import { Injectable } from '@nestjs/common';
import type { Invitation, Member, MemberRole, Ref } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { tenantCtx } from '../common/auth/decorators.js';
import { DbService, type Tx } from '../common/db/db.service.js';
import { insertParts, setClauses, type ColumnMap } from '../common/db/sql.js';
import { AppException } from '../common/errors/app-exception.js';
import { newOpaqueToken } from '../auth/token.service.js';
import type {
  CreateInvitationDto,
  CreateOrganizationDto,
  ListMembersQuery,
  ListOrganizationsQuery,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from './dto/team.dto.js';

const MEMBER_COLUMNS: ColumnMap = [
  ['role', 'role'],
  ['active', 'active'],
  ['organizationId', 'organization_id'],
  ['phone', 'phone'],
  ['jobTitle', 'job_title'],
];
const ORG_COLUMNS: ColumnMap = [
  ['name', 'name'],
  ['document', 'document'],
  ['notes', 'notes'],
];
const ORG_SELECT = `o.id, o.name, o.document, o.notes, o.created_at AS "createdAt",
  (SELECT count(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.active) AS "memberCount",
  (SELECT count(*)::int FROM tickets t WHERE t.organization_id = o.id) AS "ticketCount"`;

interface MemberRow {
  user_id: string; name: string; email: string; role: MemberRole; active: boolean;
  org_id: string | null; org_name: string | null; phone: string | null; job_title: string | null;
  last_login_at: Date | null; created_at: Date;
}

const toMember = (r: MemberRow): Member => ({
  userId: r.user_id,
  name: r.name,
  email: r.email,
  role: r.role,
  active: r.active,
  organization: r.org_id && r.org_name ? { id: r.org_id, name: r.org_name } : null,
  phone: r.phone,
  jobTitle: r.job_title,
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

interface InvitationRow { id: string; email: string; role: MemberRole; organization_id: string | null; expires_at: Date; created_at: Date }

const toInvitation = (r: InvitationRow): Invitation => ({
  id: r.id,
  email: r.email,
  role: r.role,
  organizationId: r.organization_id,
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
});

@Injectable()
export class TeamService {
  constructor(private readonly db: DbService) {}

  // ---------- membros ----------

  listMembers(user: TenantUser, q: ListMembersQuery): Promise<Member[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (q.role) where.push(`m.role = ${p(q.role)}`);
    if (q.active !== undefined) where.push(`m.active = ${p(q.active)}`);
    if (q.organization) where.push(`m.organization_id = ${p(q.organization)}`);
    if (q.q) {
      const like = p(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`(u.name ILIKE ${like} OR u.email::text ILIKE ${like})`);
    }
    return this.db.withTenant(tenantCtx(user), async (tx) =>
      (await this.members(tx, where.length ? `WHERE ${where.join(' AND ')}` : '', params)).map(toMember),
    );
  }

  /** Equipe ativa (para atribuição de chamados). */
  agents(user: TenantUser): Promise<Array<Ref & { email: string; role: MemberRole }>> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const { rows } = await tx.query<Ref & { email: string; role: MemberRole }>(
        `SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.role IN ('admin', 'agent') AND m.active AND u.disabled_at IS NULL ORDER BY u.name`,
      );
      return rows;
    });
  }

  updateMember(user: TenantUser, userId: string, dto: UpdateMemberDto): Promise<Member> {
    const params: unknown[] = [userId];
    const sets = setClauses(MEMBER_COLUMNS, dto, params);
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos um campo para alterar.');
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      // limite de agentes do plano: o trigger do banco barra (23514 agent_limit_reached → 402)
      const res = await tx.query(`UPDATE memberships SET ${sets.join(', ')} WHERE user_id = $1 RETURNING id`, params);
      if (!res.rowCount) {
        const rows = await this.members(tx, 'WHERE m.user_id = $1', [userId]);
        if (!rows.length) throw new AppException(404, 'not_found', 'Membro não encontrado.');
        throw new AppException(403, 'forbidden', 'Você não tem permissão para esta ação.');
      }
      // o workspace nunca fica sem admin ativo (senão ninguém mais administra)
      const admins = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE role = 'admin' AND active`);
      if (!admins.rows[0]?.n) {
        throw new AppException(409, 'last_admin', 'O workspace precisa de pelo menos um administrador ativo.');
      }
      const [row] = await this.members(tx, 'WHERE m.user_id = $1', [userId]);
      return toMember(row!);
    });
  }

  // ---------- convites ----------

  listInvitations(user: TenantUser): Promise<Invitation[]> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const { rows } = await tx.query<InvitationRow>(
        `SELECT id, email, role, organization_id, expires_at, created_at FROM invitations
          WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      );
      return rows.map(toInvitation);
    });
  }

  /**
   * Cria o convite e enfileira o e-mail na mesma transação. O token só existe em claro no e-mail
   * (no banco fica o SHA-256) e NUNCA é devolvido na resposta: nem o admin consegue usá-lo.
   */
  invite(user: TenantUser, dto: CreateInvitationDto): Promise<Invitation> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const member = await tx.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.active`,
        [dto.email],
      );
      if (member.rowCount) throw new AppException(409, 'already_member', 'Esta pessoa já faz parte do workspace.');

      // reenviar convite invalida o anterior
      await tx.query('DELETE FROM invitations WHERE email = $1 AND accepted_at IS NULL', [dto.email]);
      const { token, hash } = newOpaqueToken();
      const { rows } = await tx.query<InvitationRow>(
        `INSERT INTO invitations (tenant_id, email, role, organization_id, token_hash, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, role, organization_id, expires_at, created_at`,
        [user.tenantId, dto.email, dto.role, dto.organizationId ?? null, hash, user.userId],
      );
      const inv = rows[0]!;
      await tx.query('SELECT enqueue_invitation_email($1, $2)', [inv.id, token]);
      return toInvitation(inv);
    });
  }

  revokeInvitation(user: TenantUser, id: string): Promise<void> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const res = await tx.query('DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL', [id]);
      if (!res.rowCount) throw new AppException(404, 'not_found', 'Convite não encontrado.');
    });
  }

  // ---------- organizações ----------

  listOrganizations(user: TenantUser, q: ListOrganizationsQuery): Promise<Record<string, unknown>[]> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      const { rows } = await tx.query(
        `SELECT ${ORG_SELECT} FROM organizations o WHERE ($1::text IS NULL OR o.name ILIKE $1 OR o.document ILIKE $1) ORDER BY o.name`,
        [like],
      );
      return rows;
    });
  }

  getOrganization(user: TenantUser, id: string): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantCtx(user), (tx) => this.org(tx, id));
  }

  createOrganization(user: TenantUser, dto: CreateOrganizationDto): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const params: unknown[] = [user.tenantId];
      const { cols, vals } = insertParts(ORG_COLUMNS, dto, params);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO organizations (tenant_id, ${cols.join(', ')}) VALUES ($1, ${vals.join(', ')}) RETURNING id`,
        params,
      );
      return this.org(tx, rows[0]!.id);
    });
  }

  updateOrganization(user: TenantUser, id: string, dto: UpdateOrganizationDto): Promise<Record<string, unknown>> {
    const params: unknown[] = [id];
    const sets = setClauses(ORG_COLUMNS, dto, params);
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos um campo para alterar.');
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const res = await tx.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, params);
      if (!res.rowCount) throw new AppException(404, 'not_found', 'Organização não encontrada.');
      return this.org(tx, id);
    });
  }

  removeOrganization(user: TenantUser, id: string): Promise<void> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      // FK de chamados/membros → 23503 → 409 in_use
      const res = await tx.query('DELETE FROM organizations WHERE id = $1', [id]);
      if (!res.rowCount) throw new AppException(404, 'not_found', 'Organização não encontrada.');
    });
  }

  // ---------------------------------------------------------------------------

  private async members(tx: Tx, where: string, params: unknown[]): Promise<MemberRow[]> {
    const { rows } = await tx.query<MemberRow>(
      `SELECT m.user_id, u.name, u.email, m.role, m.active, o.id AS org_id, o.name AS org_name,
              m.phone, m.job_title, u.last_login_at, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN organizations o ON o.id = m.organization_id
        ${where}
        ORDER BY u.name`,
      params,
    );
    return rows;
  }

  private async org(tx: Tx, id: string): Promise<Record<string, unknown>> {
    const { rows } = await tx.query(`SELECT ${ORG_SELECT} FROM organizations o WHERE o.id = $1`, [id]);
    if (!rows[0]) throw new AppException(404, 'not_found', 'Organização não encontrada.');
    return rows[0];
  }
}
