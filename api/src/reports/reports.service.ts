import { Injectable } from '@nestjs/common';
import type { ReportsOverview, StatusKind } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { tenantCtx } from '../common/auth/decorators.js';
import { DbService } from '../common/db/db.service.js';

export const PERIOD_DAYS = 30;
const round1 = (v: string | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);

/**
 * Painel geral, tudo em SQL agregado. Período: os últimos 30 dias CORRIDOS no fuso do workspace
 * (hoje incluso, a partir de 00:00 do 29º dia anterior). "Abertos" e "vencidos" são o estado atual.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  overview(user: TenantUser): Promise<ReportsOverview> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const period = await tx.query<{ tz: string; start_date: string; start_ts: Date }>(
        `SELECT timezone AS tz,
                ((now() AT TIME ZONE timezone)::date - ${PERIOD_DAYS - 1})::text AS start_date,
                (((now() AT TIME ZONE timezone)::date - ${PERIOD_DAYS - 1})::timestamp AT TIME ZONE timezone) AS start_ts
           FROM tenants WHERE id = app_tenant_id()`,
      );
      const { tz, start_date: startDate, start_ts: startTs } = period.rows[0]!;

      const open = await tx.query<{ id: string; name: string; kind: StatusKind; color: string; count: number }>(
        `SELECT s.id, s.name, s.kind, s.color, count(t.id)::int AS count
           FROM statuses s LEFT JOIN tickets t ON t.status_id = s.id
          WHERE s.kind NOT IN ('resolved', 'closed')
          GROUP BY s.id ORDER BY s.position, s.name`,
      );

      const kpi = await tx.query<{ overdue: number; avg_first: string | null; avg_resolution: string | null; sla_pct: string | null; minutes: number }>(
        `SELECT
           (SELECT count(DISTINCT ticket_id)::int FROM v_ticket_sla WHERE state = 'breached') AS overdue,
           (SELECT avg(EXTRACT(epoch FROM first_response_at - created_at) / 60) FROM tickets
             WHERE created_at >= $1 AND first_response_at IS NOT NULL) AS avg_first,
           (SELECT avg(EXTRACT(epoch FROM resolved_at - created_at) / 60) FROM tickets
             WHERE resolved_at >= $1) AS avg_resolution,
           (SELECT 100.0 * count(*) FILTER (WHERE v.state = 'met') / NULLIF(count(*), 0)
              FROM v_ticket_sla v JOIN tickets t ON t.id = v.ticket_id
             WHERE t.created_at >= $1 AND v.state IN ('met', 'met_late', 'breached')) AS sla_pct,
           (SELECT COALESCE(sum(minutes), 0)::int FROM time_entries WHERE worked_on >= $2::date) AS minutes`,
        [startTs, startDate],
      );

      const perDay = await tx.query<{ date: string; created: number; resolved: number }>(
        `SELECT d::date::text AS date,
                (SELECT count(*)::int FROM tickets t WHERE (t.created_at AT TIME ZONE $2)::date = d::date) AS created,
                (SELECT count(*)::int FROM tickets t WHERE (t.resolved_at AT TIME ZONE $2)::date = d::date) AS resolved
           FROM generate_series($1::date, $1::date + ${PERIOD_DAYS - 1}, interval '1 day') AS d
          ORDER BY d`,
        [startDate, tz],
      );

      const byAgent = await tx.query<{ userId: string; name: string; open: number; resolved: number; minutesTracked: number }>(
        `SELECT u.id AS "userId", u.name,
                (SELECT count(*)::int FROM tickets t JOIN statuses s ON s.id = t.status_id
                  WHERE t.assignee_id = u.id AND s.kind NOT IN ('resolved', 'closed')) AS open,
                (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = u.id AND t.resolved_at >= $1) AS resolved,
                (SELECT COALESCE(sum(minutes), 0)::int FROM time_entries te WHERE te.user_id = u.id AND te.worked_on >= $2::date) AS "minutesTracked"
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.role IN ('admin', 'agent') AND m.active
          ORDER BY open DESC, u.name`,
        [startTs, startDate],
      );

      const byCategory = await tx.query<{ categoryId: string | null; name: string; count: number }>(
        `SELECT c.id AS "categoryId", COALESCE(c.name, 'Sem categoria') AS name, count(*)::int AS count
           FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.created_at >= $1
          GROUP BY c.id, c.name ORDER BY count DESC, name`,
        [startTs],
      );

      const k = kpi.rows[0]!;
      return {
        periodDays: PERIOD_DAYS,
        openByStatus: open.rows.map((r) => ({ statusId: r.id, name: r.name, kind: r.kind, color: r.color, count: r.count })),
        overdue: k.overdue,
        avgFirstResponseMinutes: round1(k.avg_first),
        avgResolutionMinutes: round1(k.avg_resolution),
        slaCompliancePct: round1(k.sla_pct),
        ticketsPerDay: perDay.rows,
        byAgent: byAgent.rows,
        byCategory: byCategory.rows,
        minutesTracked: k.minutes,
      };
    });
  }
}
