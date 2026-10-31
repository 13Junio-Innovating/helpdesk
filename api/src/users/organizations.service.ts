import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { likeContains, SqlParams } from '../common/db/sql-params.js';
import { deleteRow, insertRow, pickColumns, updateRow } from '../common/db/writes.js';
import { AppError } from '../common/errors/app-error.js';
import { decodeCursor, encodeCursor } from '../common/http/cursor.js';
import type { CreateOrganizationDto, UpdateOrganizationDto } from '../catalog/dto/catalog.dto.js';
import type { ListOrganizationsQuery } from './dto/users.dto.js';

const FIELDS = { name: 'name', document: 'document', notes: 'notes' };
const SELECT = `
  SELECT o.id, o.name, o.document, o.notes, o.created_at AS "createdAt",
         (SELECT count(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.active) AS "memberCount",
         (SELECT count(*)::int FROM tickets t WHERE t.organization_id = o.id) AS "ticketCount"
    FROM organizations o`;

/** Empresas-cliente. RLS: só a equipe enxerga e escreve. */
@Injectable()
export class OrganizationsService {
  constructor(private readonly db: DbService) {}

  list(auth: TenantAuth, q: ListOrganizationsQuery) {
    const p = new SqlParams();
    const where: string[] = [];
    if (q.q) where.push(`(o.name ILIKE ${p.add(likeContains(q.q.trim()))} OR o.document = ${p.add(q.q.trim())})`);
    if (q.cursor) {
      const [name, id] = decodeCursor(q.cursor, 2);
      where.push(`(lower(o.name), o.id) > (${p.add(name)}, ${p.add(id)}::uuid)`);
    }
    const limit = q.limit ?? 50;
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(o.name), o.id LIMIT ${p.add(limit + 1)}`;
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<{ id: string; name: string }>(sql, p.values);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page, nextCursor: rows.length > limit && last ? encodeCursor([last.name.toLowerCase(), last.id]) : null };
    });
  }

  get(auth: TenantAuth, id: string) {
    return this.db.withTenant(auth, async (c) => {
      const org = await this.find(c, id);
      const members = await c.query(
        `SELECT u.id, u.name, u.email, m.active FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 ORDER BY lower(u.name)`, [id]);
      return { ...org, members: members.rows };
    });
  }

  create(auth: TenantAuth, dto: CreateOrganizationDto) {
    return this.db.withTenant(auth, async (c) => {
      const id = await insertRow(c, 'organizations', [['tenant_id', auth.tenantId], ...pickColumns(dto, FIELDS)]);
      return this.find(c, id);
    });
  }

  update(auth: TenantAuth, id: string, dto: UpdateOrganizationDto) {
    return this.db.withTenant(auth, async (c) => {
      await updateRow(c, 'organizations', id, pickColumns(dto, FIELDS), 'Organização');
      return this.find(c, id);
    });
  }

  remove(auth: TenantAuth, id: string): Promise<void> {
    return this.db.withTenant(auth, (c) => deleteRow(c, 'organizations', id, 'Organização'));
  }

  private async find(c: DbClient, id: string) {
    const { rows } = await c.query(`${SELECT} WHERE o.id = $1`, [id]);
    if (!rows[0]) throw new AppError(404, 'not_found', 'Organização não encontrada.');
    return rows[0];
  }
}
