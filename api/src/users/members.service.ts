import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { newOpaqueToken } from '../common/auth/crypto.js';
import { MembershipService } from '../common/auth/membership.service.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { likeContains, SqlParams } from '../common/db/sql-params.js';
import { pickColumns, updateRow } from '../common/db/writes.js';
import { AppError } from '../common/errors/app-error.js';
import { decodeCursor, encodeCursor, type Page } from '../common/http/cursor.js';
import type { CreateInvitationDto, ListMembersQuery, UpdateMemberDto } from './dto/users.dto.js';

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  organization: { id: string; name: string } | null;
  phone: string | null;
  jobTitle: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const MEMBER_SELECT = `
  SELECT u.id, u.name, u.email, m.role, m.active, m.phone, m.job_title AS "jobTitle",
         u.last_login_at AS "lastLoginAt", m.created_at AS "createdAt",
         CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'name', o.name) END AS organization
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN organizations o ON o.id = m.organization_id`;

@Injectable()
export class MembersService {
  constructor(
    private readonly db: DbService,
    private readonly memberships: MembershipService,
  ) {}

  list(auth: TenantAuth, q: ListMembersQuery): Promise<Page<MemberRow>> {
    const p = new SqlParams();
    const where: string[] = [];
    if (q.role) where.push(`m.role = ${p.add(q.role)}`);
    if (q.group === 'staff') where.push(`m.role IN ('admin', 'agent')`);
    if (q.active !== undefined) where.push(`m.active = ${p.add(q.active)}`);
    if (q.organization) where.push(`m.organization_id = ${p.add(q.organization)}`);
    if (q.q) {
      const like = p.add(likeContains(q.q.trim()));
      where.push(`(u.name ILIKE ${like} OR u.email::text ILIKE ${like})`);
    }
    if (q.cursor) {
      const [name, id] = decodeCursor(q.cursor, 2);
      where.push(`(lower(u.name), u.id) > (${p.add(name)}, ${p.add(id)}::uuid)`);
    }
    const limit = q.limit ?? 50;
    const sql = `${MEMBER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY lower(u.name), u.id LIMIT ${p.add(limit + 1)}`;
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<MemberRow>(sql, p.values);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page, nextCursor: rows.length > limit && last ? encodeCursor([last.name.toLowerCase(), last.id]) : null };
    });
  }

  /** Equipe ativa (para escolher responsável). Visível a todos os papéis pela RLS. */
  agents(auth: TenantAuth) {
    return this.db.withTenant(auth, async (c) =>
      (await c.query(
        `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.role IN ('admin', 'agent') AND m.active ORDER BY lower(u.name), u.id`,
      )).rows);
  }

  update(auth: TenantAuth, userId: string, dto: UpdateMemberDto) {
    const cols = pickColumns(dto, { role: 'role', active: 'active', organizationId: 'organization_id', phone: 'phone', jobTitle: 'job_title' });
    return this.db.withTenant(auth, async (c) => {
      // RLS: só admin altera; limite de agentes do plano => 402 (trigger)
      await updateRow(c, 'memberships', userId, cols, 'Membro', 'user_id');
      const admins = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE role = 'admin' AND active`);
      if (admins.rows[0]!.n === 0) {
        throw new AppError(409, 'last_admin', 'O workspace precisa de pelo menos um administrador ativo.');
      }
      const { rows } = await c.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [userId]);
      this.memberships.invalidate(userId, auth.tenantId);
      return rows[0];
    });
  }

  // ---------- convites ----------

  invite(auth: TenantAuth, dto: CreateInvitationDto) {
    const token = newOpaqueToken();
    return this.db.withTenant(auth, async (c) => {
      const already = await c.query(
        'SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.active', [dto.email]);
      if (already.rowCount) throw new AppError(409, 'already_member', 'Esta pessoa já faz parte do workspace.');

      // um convite pendente por e-mail: o novo substitui os anteriores (links antigos param de valer)
      await c.query('DELETE FROM invitations WHERE email = $1 AND accepted_at IS NULL', [dto.email]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, organization_id, token_hash, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [auth.tenantId, dto.email, dto.role, dto.organizationId ?? null, token.hash, auth.userId],
      );
      const id = rows[0]!.id;
      await c.query('SELECT enqueue_invitation_email($1, $2)', [id, token.token]);
      return this.findInvitation(c, id);
    });
  }

  invitations(auth: TenantAuth) {
    return this.db.withTenant(auth, async (c) =>
      (await c.query(`${INVITATION_SELECT} WHERE i.accepted_at IS NULL ORDER BY i.created_at DESC`)).rows);
  }

  revokeInvitation(auth: TenantAuth, id: string): Promise<void> {
    return this.db.withTenant(auth, async (c) => {
      const { rowCount } = await c.query('DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL', [id]);
      if (!rowCount) throw new AppError(404, 'not_found', 'Convite não encontrado.');
    });
  }

  private async findInvitation(c: DbClient, id: string) {
    const { rows } = await c.query(`${INVITATION_SELECT} WHERE i.id = $1`, [id]);
    return rows[0];
  }
}

const INVITATION_SELECT = `
  SELECT i.id, i.email, i.role, i.organization_id AS "organizationId", i.expires_at AS "expiresAt",
         i.created_at AS "createdAt", (i.expires_at <= now()) AS expired,
         CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name) END AS "invitedBy"
    FROM invitations i LEFT JOIN users u ON u.id = i.invited_by`;
