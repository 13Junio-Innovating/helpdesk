import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CreateHolidayDto, SlotDto } from './dto/catalog.dto.js';

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

@Injectable()
export class CatalogExtrasService {
  constructor(private readonly db: DbService) {}

  queueMembers(auth: TenantAuth, queueId: string) {
    return this.db.withTenant(auth, async (c) => {
      await this.mustSee(c, 'queues', queueId, 'Fila');
      const { rows } = await c.query(
        `SELECT u.id, u.name, u.email, m.role
           FROM queue_members qm JOIN users u ON u.id = qm.user_id
           JOIN memberships m ON m.tenant_id = qm.tenant_id AND m.user_id = qm.user_id
          WHERE qm.queue_id = $1 ORDER BY u.name`,
        [queueId],
      );
      return rows;
    });
  }

  /** Substitui os membros da fila (só equipe ativa). */
  setQueueMembers(auth: TenantAuth, queueId: string, userIds: string[]) {
    const ids = [...new Set(userIds)];
    return this.db.withTenant(auth, async (c) => {
      await this.mustSee(c, 'queues', queueId, 'Fila');
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships WHERE user_id = ANY($1::uuid[]) AND role IN ('admin', 'agent') AND active`,
        [ids],
      );
      if (rows[0]!.n !== ids.length) {
        throw new AppError(422, 'queue_member_must_be_staff', 'Só agentes e administradores ativos podem fazer parte de uma fila.');
      }
      await this.deleteAllOrForbid(c, 'queue_members', 'queue_id', queueId);
      if (ids.length) {
        await c.query(
          `INSERT INTO queue_members (tenant_id, queue_id, user_id) SELECT $1, $2, unnest($3::uuid[])`,
          [auth.tenantId, queueId, ids],
        );
      }
      return { queueId, userIds: ids };
    });
  }

  schedule(auth: TenantAuth, id: string) {
    return this.db.withTenant(auth, async (c) => this.loadSchedule(c, id));
  }

  /** Substitui as faixas semanais. Faixas do mesmo dia não podem se sobrepor. */
  setSlots(auth: TenantAuth, id: string, slots: SlotDto[]) {
    const sorted = slots.toSorted((a, b) => a.weekday - b.weekday || toMinutes(a.start) - toMinutes(b.start));
    for (const [i, s] of sorted.entries()) {
      if (toMinutes(s.end) <= toMinutes(s.start)) throw new AppError(422, 'invalid_slot', 'O fim da faixa deve ser depois do início.');
      const prev = sorted[i - 1];
      if (prev && prev.weekday === s.weekday && toMinutes(s.start) < toMinutes(prev.end)) {
        throw new AppError(422, 'slots_overlap', 'Há faixas sobrepostas no mesmo dia.');
      }
    }
    return this.db.withTenant(auth, async (c) => {
      await this.mustSee(c, 'business_hours', id, 'Horário comercial');
      await this.deleteAllOrForbid(c, 'business_hour_slots', 'business_hours_id', id);
      for (const s of sorted) {
        await c.query(
          `INSERT INTO business_hour_slots (tenant_id, business_hours_id, weekday, start_time, end_time)
           VALUES ($1, $2, $3, $4::time, $5::time)`,
          [auth.tenantId, id, s.weekday, s.start, s.end === '24:00' ? '23:59:59' : s.end],
        );
      }
      return this.loadSchedule(c, id);
    });
  }

  addHoliday(auth: TenantAuth, id: string, dto: CreateHolidayDto) {
    return this.db.withTenant(auth, async (c) => {
      await this.mustSee(c, 'business_hours', id, 'Horário comercial');
      await c.query(
        `INSERT INTO business_holidays (tenant_id, business_hours_id, holiday_date, name) VALUES ($1, $2, $3::date, $4)`,
        [auth.tenantId, id, dto.date, dto.name ?? null],
      );
      return this.loadSchedule(c, id);
    });
  }

  removeHoliday(auth: TenantAuth, id: string, date: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'invalid_input', 'Data inválida.');
    return this.db.withTenant(auth, async (c) => {
      const { rowCount } = await c.query(
        'DELETE FROM business_holidays WHERE business_hours_id = $1 AND holiday_date = $2::date', [id, date]);
      if (!rowCount) {
        const seen = await c.query('SELECT 1 FROM business_holidays WHERE business_hours_id = $1 AND holiday_date = $2::date', [id, date]);
        if (seen.rowCount) throw new AppError(403, 'forbidden', 'Você não tem permissão para esta ação.');
        throw new AppError(404, 'not_found', 'Feriado não encontrado.');
      }
    });
  }

  private async loadSchedule(c: DbClient, id: string) {
    const bh = await c.query('SELECT id, name, timezone FROM business_hours WHERE id = $1', [id]);
    if (!bh.rows[0]) throw new AppError(404, 'not_found', 'Horário comercial não encontrado.');
    const slots = await c.query(
      `SELECT weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
         FROM business_hour_slots WHERE business_hours_id = $1 ORDER BY weekday, start_time`, [id]);
    const holidays = await c.query(
      `SELECT holiday_date::text AS date, name FROM business_holidays WHERE business_hours_id = $1 ORDER BY holiday_date`, [id]);
    return { ...bh.rows[0], slots: slots.rows, holidays: holidays.rows };
  }

  private async mustSee(c: DbClient, table: string, id: string, label: string): Promise<void> {
    const { rowCount } = await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (!rowCount) throw new AppError(404, 'not_found', `${label} não encontrado(a).`);
  }

  /**
   * Substituição "apaga tudo e insere de novo" sob RLS: se a policy barrar o DELETE ele só apaga
   * menos linhas do que eram visíveis, sem erro. Isso vira 403.
   */
  private async deleteAllOrForbid(c: DbClient, table: string, column: string, id: string): Promise<void> {
    const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [id]);
    const { rowCount } = await c.query(`DELETE FROM ${table} WHERE ${column} = $1`, [id]);
    if ((rowCount ?? 0) !== rows[0]!.n) throw new AppError(403, 'forbidden', 'Você não tem permissão para esta ação.');
  }
}
