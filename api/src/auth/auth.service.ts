import { Injectable } from '@nestjs/common';
import type { MemberRole, TenantAuth } from '../common/auth/auth.types.js';
import { newOpaqueToken, sha256 } from '../common/auth/crypto.js';
import { TokensService } from '../common/auth/tokens.service.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { AppError } from '../common/errors/app-error.js';
import { AppConfig } from '../config/app-config.js';
import type { LoginDto, SignupDto } from './dto/auth.dto.js';
import { PasswordService } from './password.service.js';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: string;
  role: MemberRole;
}

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  /** Valor do cookie httpOnly; nunca vai no corpo da resposta. */
  refreshToken: string;
}

export interface LoginResult {
  user: { id: string; name: string; email: string };
  workspaces: Workspace[];
  /** Presente quando já há um workspace definido (único vínculo). */
  session?: SessionTokens & { tenantId: string };
  /** Presente quando o usuário precisa escolher entre vários workspaces. */
  preTenantToken?: { token: string; expiresIn: number };
}

const INVALID_CREDENTIALS = () => new AppError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokensService,
    private readonly passwords: PasswordService,
    private readonly config: AppConfig,
  ) {}

  private get refreshTtl(): string {
    return `${this.config.get('REFRESH_TTL_DAYS')} days`;
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.db.anonymous(async (c) => {
      const { rows } = await c.query<{ id: string; email: string; name: string; password_hash: string | null; disabled: boolean }>(
        'SELECT id, email, name, password_hash, disabled FROM auth_get_user_by_email($1)',
        [dto.email],
      );
      return rows[0];
    });

    // compara SEMPRE (mesmo sem usuário) para o tempo de resposta não revelar se o e-mail existe
    const ok = await this.passwords.verify(dto.password, user?.password_hash);
    if (!user || !ok || user.disabled) throw INVALID_CREDENTIALS();

    const workspaces = await this.db.anonymous(async (c) => {
      await c.query('SELECT auth_touch_login($1)', [user.id]);
      return this.listWorkspaces(c, user.id);
    });

    const result: LoginResult = { user: { id: user.id, name: user.name, email: user.email }, workspaces };
    const only = workspaces.length === 1 ? workspaces[0] : undefined;
    if (only) {
      result.session = { ...(await this.issueSession(user.id, only.id)), tenantId: only.id };
    } else {
      result.preTenantToken = this.tokens.signPreTenant(user.id);
    }
    return result;
  }

  async listWorkspacesFor(userId: string): Promise<Workspace[]> {
    return this.db.anonymous((c) => this.listWorkspaces(c, userId));
  }

  /** Escolhe (ou troca) o workspace. Revoga a sessão anterior deste navegador, se houver. */
  async selectTenant(userId: string, tenantId: string, previousRefresh?: string): Promise<SessionTokens> {
    const workspaces = await this.listWorkspacesFor(userId);
    if (!workspaces.some((w) => w.id === tenantId)) {
      throw new AppError(403, 'not_a_member', 'Você não tem acesso a este workspace.');
    }
    if (previousRefresh) await this.logout(previousRefresh);
    return this.issueSession(userId, tenantId);
  }

  async signup(dto: SignupDto): Promise<{ userId: string; tenantId: string; session: SessionTokens }> {
    const hash = await this.passwords.hash(dto.password);
    const created = await this.db.anonymous(async (c) => {
      const { rows } = await c.query<{ out_tenant_id: string; out_user_id: string }>(
        'SELECT out_tenant_id, out_user_id FROM signup_tenant($1, $2, $3, $4, $5)',
        [dto.workspaceName, dto.slug, dto.email, dto.name, hash],
      );
      return rows[0]!;
    });
    const session = await this.issueSession(created.out_user_id, created.out_tenant_id);
    return { userId: created.out_user_id, tenantId: created.out_tenant_id, session };
  }

  /** Rotação do refresh token. Em reuso o banco já revogou a sessão inteira. */
  async refresh(refreshToken: string): Promise<SessionTokens & { tenantId: string }> {
    const next = newOpaqueToken();
    const row = await this.db.anonymous(async (c) => {
      const { rows } = await c.query<{ status: 'ok' | 'reused' | 'invalid'; user_id: string | null; tenant_id: string | null }>(
        'SELECT status, user_id, tenant_id FROM auth_rotate_refresh($1, $2, $3::interval)',
        [sha256(refreshToken), next.hash, this.refreshTtl],
      );
      return rows[0]!;
    });
    // a transação acima já foi COMMITada: a revogação por reuso fica persistida
    if (row.status === 'reused') {
      throw new AppError(401, 'refresh_reused', 'Sessão encerrada por segurança. Entre novamente.');
    }
    if (row.status !== 'ok' || !row.user_id || !row.tenant_id) {
      throw new AppError(401, 'refresh_invalid', 'Sessão expirada. Entre novamente.');
    }
    const access = this.tokens.signAccess(row.user_id, row.tenant_id);
    return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken: next.token, tenantId: row.tenant_id };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.anonymous((c) => c.query('SELECT auth_revoke_refresh($1)', [sha256(refreshToken)]));
  }

  async logoutAll(userId: string): Promise<number> {
    return this.db.anonymous(async (c) => {
      const { rows } = await c.query<{ n: number }>('SELECT auth_revoke_all_refresh($1) AS n', [userId]);
      return rows[0]?.n ?? 0;
    });
  }

  async me(auth: TenantAuth) {
    const data = await this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<{
        user: { id: string; email: string; name: string; locale: string; avatar_url: string | null };
        tenant: { id: string; name: string; slug: string; status: string; timezone: string; trial_ends_at: string | null };
        plan: { id: string; name: string; price_cents: number; max_agents: number | null; max_tickets_per_month: number | null; features: Record<string, boolean> };
        role: MemberRole;
      }>(
        `SELECT json_build_object('id', u.id, 'email', u.email, 'name', u.name,
                                  'locale', u.locale, 'avatar_url', u.avatar_url) AS user,
                json_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status,
                                  'timezone', t.timezone, 'trial_ends_at', t.trial_ends_at) AS tenant,
                json_build_object('id', p.id, 'name', p.name, 'price_cents', p.price_cents,
                                  'max_agents', p.max_agents, 'max_tickets_per_month', p.max_tickets_per_month,
                                  'features', p.features) AS plan,
                app_role() AS role
           FROM users u, tenants t JOIN plans p ON p.id = t.plan_id
          WHERE u.id = app_user_id() AND t.id = app_tenant_id()`,
      );
      return rows[0];
    });
    if (!data) throw new AppError(401, 'session_invalid', 'Seu acesso a este workspace não está mais ativo.');

    const trialEnds = data.tenant.trial_ends_at ? new Date(data.tenant.trial_ends_at) : null;
    const trialActive = data.tenant.status === 'trial' && !!trialEnds && trialEnds.getTime() > Date.now();
    return {
      ...data,
      trial: {
        active: trialActive,
        endsAt: trialEnds?.toISOString() ?? null,
        daysLeft: trialActive && trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / 86_400_000) : 0,
      },
    };
  }

  private async issueSession(userId: string, tenantId: string): Promise<SessionTokens> {
    const refresh = newOpaqueToken();
    await this.db.anonymous((c) =>
      c.query('SELECT auth_issue_refresh($1, $2, $3, $4::interval)', [userId, tenantId, refresh.hash, this.refreshTtl]),
    );
    const access = this.tokens.signAccess(userId, tenantId);
    return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken: refresh.token };
  }

  private async listWorkspaces(c: DbClient, userId: string): Promise<Workspace[]> {
    const { rows } = await c.query<Workspace>(
      `SELECT tenant_id AS id, tenant_name AS name, tenant_slug::text AS slug, tenant_status::text AS status, role::text AS role
         FROM auth_list_memberships($1)`,
      [userId],
    );
    return rows;
  }
}
