import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { DbService } from '../common/db/db.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CreateTimeEntryDto } from './dto/ticket.dto.js';

const ENTRY_COLUMNS = `e.id, e.ticket_id AS "ticketId", e.minutes, e.note, e.worked_on::text AS "workedOn",
                       e.created_at AS "createdAt", json_build_object('id', u.id, 'name', u.name) AS "user"`;

@Injectable()
export class TimeEntriesService {
  constructor(private readonly db: DbService) {}

  create(auth: TenantAuth, ticketId: string, dto: CreateTimeEntryDto) {
    return this.db.withTenant(auth, async (c) => {
      const visible = await c.query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
      if (!visible.rowCount) throw new AppError(404, 'not_found', 'Chamado não encontrado.');
      // worked_on nulo => o trigger usa "hoje" no fuso do workspace
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO time_entries (tenant_id, ticket_id, user_id, minutes, note, worked_on)
         VALUES ($1, $2, $3, $4, $5, $6::date) RETURNING id`,
        [auth.tenantId, ticketId, auth.userId, dto.minutes, dto.note ?? null, dto.workedOn ?? null],
      );
      const created = await c.query(
        `SELECT ${ENTRY_COLUMNS} FROM time_entries e JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
        [rows[0]!.id],
      );
      return created.rows[0];
    });
  }

  list(auth: TenantAuth, ticketId: string) {
    return this.db.withTenant(auth, async (c) => {
      const visible = await c.query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
      if (!visible.rowCount) throw new AppError(404, 'not_found', 'Chamado não encontrado.');
      const { rows } = await c.query<{ minutes: number }>(
        `SELECT ${ENTRY_COLUMNS} FROM time_entries e JOIN users u ON u.id = e.user_id
          WHERE e.ticket_id = $1 ORDER BY e.worked_on DESC, e.created_at DESC`,
        [ticketId],
      );
      return { items: rows, totalMinutes: rows.reduce((a, r) => a + r.minutes, 0) };
    });
  }

  remove(auth: TenantAuth, id: string): Promise<void> {
    return this.db.withTenant(auth, async (c) => {
      const { rowCount } = await c.query('DELETE FROM time_entries WHERE id = $1', [id]);
      if (!rowCount) throw new AppError(404, 'not_found', 'Apontamento não encontrado.');
    });
  }
}
