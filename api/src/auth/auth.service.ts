import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthResponse, MeResponse, MemberRole, TenantStatus, WorkspaceSummary } from '@helpdesk/shared';
import type { Env } from '../config/env.js';
import { DbService, type Tx } from '../common/db/db.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { tenantCtx } from '../common/auth/decorators.js';
import type { TenantUser } from '../common/auth/auth-user.js';
import { PasswordService } from './password.service.js';
import { newOpaqueToken, sha256, TokenService } from './token.service.js';
import type { AcceptInviteDto, ForgotPasswordDto, LoginDto, ResetPasswordDto, SignupDto } from './dto/auth.dto.js';

/** Resultado interno: o controller grava `refreshToken` em cookie httpOnly e não o devolve no corpo. */
export interface AuthResult {
  body: AuthResponse;
  refreshToken: string | null;
}

const invalidCredentials = () => new AppException(401, 'invalid_credentials', 'E-mail ou senha incorretos.');
const sessionInvalid = () => new AppException(401, 'session_invalid', 'Sua sessão expirou. Entre novamente.');

@Injectable()
export class AuthService {
  private readonly resetTtl: string;

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    config: ConfigService<Env, true>,
  ) {
    this.resetTtl = `${config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true })} minutes`;
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.db.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ id: string; password_hash: string | null; disabled: boolean }>(
        'SELECT id, password_hash, disabled FROM auth_get_user_by_email($1)',
        [dto.email],
      );
      return rows[0];
    });
    // compare roda sempre (mesmo sem usuário) para o tempo de resposta não revelar se o e-mail existe
    const ok = await this.passwords.verify(dto.password, user?.password_hash);
    if (!user || !ok || user.disabled) throw invalidCredentials();

    const workspaces = await this.listWorkspaces(user.id);
    const only = workspaces.length === 1 ? workspaces[0] : undefined;
    if (workspaces.length === 0) {
      throw new AppException(403, 'forbidden', 'Sua conta não tem acesso a nenhum workspace ativo.');
    }
    if (only) return this.startSession(user.id, only, workspaces);

    return {
      body: {
        accessToken: await this.tokens.signPreTenant(user.id),
        expiresIn: this.tokens.preTenantTtl,
        needsTenantSelection: true,
        workspaces,
      },
      refreshToken: null,
    };
  }

  /** Escolha (ou troca) de workspace: o membership é conferido no banco, não no token. */
  async selectTenant(userId: string, tenantId: string): Promise<AuthResult> {
    const workspaces = await this.listWorkspaces(userId);
    const ws = workspaces.find((w) => w.tenantId === tenantId);
    if (!ws) throw new AppException(403, 'forbidden', 'Você não tem acesso a este workspace.');
    return this.startSession(userId, ws, workspaces);
  }

  async refresh(rawToken: string | undefined): Promise<AuthResult> {
    if (!rawToken) throw sessionInvalid();
    const { token, hash } = newOpaqueToken();
    const rotated = await this.db.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ status: 'ok' | 'invalid' | 'reused'; user_id: string | null; tenant_id: string | null }>(
        'SELECT status, user_id, tenant_id FROM auth_session_rotate($1, $2, $3::interval)',
        [sha256(rawToken), hash, this.tokens.refreshInterval],
      );
      return rows[0];
    });
    if (rotated?.status !== 'ok' || !rotated.user_id || !rotated.tenant_id) throw sessionInvalid();

    const workspaces = await this.listWorkspaces(rotated.user_id);
    const ws = workspaces.find((w) => w.tenantId === rotated.tenant_id);
    if (!ws) throw sessionInvalid();
    return {
      body: {
        accessToken: await this.tokens.signAccess(rotated.user_id, ws.tenantId, ws.role),
        expiresIn: this.tokens.accessTtl,
        needsTenantSelection: false,
        workspaces,
      },
      refreshToken: token,
    };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.db.withoutTenant((tx) => tx.query('SELECT auth_session_revoke($1)', [sha256(rawToken)]));
  }

  async me(user: TenantUser): Promise<MeResponse> {
    return this.db.withTenant(tenantCtx(user), async (tx, info) => {
      const u = await tx.query<{ id: string; email: string; name: string; locale: string; avatar_url: string | null }>(
        'SELECT id, email, name, locale, avatar_url FROM users WHERE id = app_user_id()',
      );
      const t = await tx.query<{
        id: string; name: string; slug: string; status: TenantStatus; timezone: string; trial_ends_at: Date | null;
        plan_id: string; plan_name: string; max_agents: number | null; max_tickets_per_month: number | null;
        features: Record<string, boolean>;
      }>(
        `SELECT t.id, t.name, t.slug, t.status, t.timezone, t.trial_ends_at,
                p.id AS plan_id, p.name AS plan_name, p.max_agents, p.max_tickets_per_month, p.features
           FROM tenants t JOIN plans p ON p.id = t.plan_id
          WHERE t.id = app_tenant_id()`,
      );
      const usr = u.rows[0];
      const ten = t.rows[0];
      if (!usr || !ten) throw sessionInvalid();
      return {
        user: { id: usr.id, email: usr.email, name: usr.name, locale: usr.locale, avatarUrl: usr.avatar_url },
        tenant: {
          id: ten.id, name: ten.name, slug: ten.slug, status: ten.status, timezone: ten.timezone,
          trialEndsAt: ten.trial_ends_at?.toISOString() ?? null,
        },
        role: info.role,
        plan: {
          id: ten.plan_id, name: ten.plan_name, maxAgents: ten.max_agents,
          maxTicketsPerMonth: ten.max_tickets_per_month, features: ten.features,
        },
      };
    });
  }

  async signup(dto: SignupDto): Promise<AuthResult> {
    const hash = await this.passwords.hash(dto.password);
    const created = await this.db.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ out_tenant_id: string; out_user_id: string }>(
        'SELECT out_tenant_id, out_user_id FROM signup_tenant($1, $2, $3, $4, $5)',
        [dto.workspaceName, dto.slug, dto.email, dto.name, hash],
      );
      return rows[0];
    });
    if (!created) throw new Error('signup_tenant não devolveu linha');
    return this.startSessionFor(created.out_user_id, created.out_tenant_id);
  }

  /**
   * Aceite de convite. Se o e-mail já tinha conta, o banco mantém a senha antiga; por isso
   * conferimos a senha informada contra o hash gravado NA MESMA transação. Assim, possuir o
   * link do convite nunca basta para entrar numa conta existente (se falhar, o convite não é consumido).
   */
  async acceptInvite(dto: AcceptInviteDto): Promise<AuthResult> {
    const hash = await this.passwords.hash(dto.password);
    const accepted = await this.db.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ out_tenant_id: string; out_user_id: string }>(
        'SELECT out_tenant_id, out_user_id FROM accept_invitation($1, $2, $3)',
        [sha256(dto.token), dto.name, hash],
      );
      const r = rows[0];
      if (!r) throw new Error('accept_invitation não devolveu linha');
      const stored = await this.storedHashOf(tx, r.out_tenant_id, r.out_user_id);
      if (!(await this.passwords.verify(dto.password, stored))) {
        throw new AppException(401, 'invalid_credentials', 'Este e-mail já tem uma conta. Informe a senha atual dela para aceitar o convite.');
      }
      return r;
    });
    return this.startSessionFor(accepted.out_user_id, accepted.out_tenant_id);
  }

  /** Resposta idêntica exista ou não o e-mail (o controller sempre devolve 202). */
  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const { token, hash } = newOpaqueToken();
    await this.db.withoutTenant((tx) =>
      tx.query('SELECT auth_reset_create($1, $2, $3, $4::interval)', [dto.email, hash, token, this.resetTtl]),
    );
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const hash = await this.passwords.hash(dto.password);
    await this.db.withoutTenant((tx) => tx.query('SELECT auth_reset_consume($1, $2)', [sha256(dto.token), hash]));
  }

  // ---------------------------------------------------------------------------

  private async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    return this.db.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ tenant_id: string; tenant_name: string; tenant_slug: string; tenant_status: TenantStatus; role: MemberRole }>(
        'SELECT tenant_id, tenant_name, tenant_slug, tenant_status, role FROM auth_list_memberships($1)',
        [userId],
      );
      return rows.map((r) => ({ tenantId: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug, status: r.tenant_status, role: r.role }));
    });
  }

  private async startSessionFor(userId: string, tenantId: string): Promise<AuthResult> {
    const workspaces = await this.listWorkspaces(userId);
    const ws = workspaces.find((w) => w.tenantId === tenantId);
    if (!ws) throw sessionInvalid();
    return this.startSession(userId, ws, workspaces);
  }

  private async startSession(userId: string, ws: WorkspaceSummary, workspaces: WorkspaceSummary[]): Promise<AuthResult> {
    const { token, hash } = newOpaqueToken();
    await this.db.withoutTenant(async (tx) => {
      await tx.query('SELECT auth_session_create($1, $2, $3, $4::interval)', [userId, ws.tenantId, hash, this.tokens.refreshInterval]);
      await tx.query('SELECT auth_touch_login($1)', [userId]);
    });
    return {
      body: {
        accessToken: await this.tokens.signAccess(userId, ws.tenantId, ws.role),
        expiresIn: this.tokens.accessTtl,
        needsTenantSelection: false,
        workspaces,
      },
      refreshToken: token,
    };
  }

  /** password_hash não é legível pelo sd_app; só via auth_get_user_by_email (SECURITY DEFINER). */
  private async storedHashOf(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
    await tx.query('SELECT app_set_context($1, $2)', [tenantId, userId]);
    const { rows } = await tx.query<{ password_hash: string | null }>(
      'SELECT a.password_hash FROM users u CROSS JOIN LATERAL auth_get_user_by_email(u.email) a WHERE u.id = app_user_id()',
    );
    return rows[0]?.password_hash ?? null;
  }
}
