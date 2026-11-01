import { Injectable, Logger } from '@nestjs/common';
import { WorkerConfig } from './worker-config.js';
import { WorkerDbService } from './worker-db.service.js';

@Injectable()
export class SlaJobs {
  private readonly logger = new Logger(SlaJobs.name);

  constructor(
    private readonly db: WorkerDbService,
    private readonly config: WorkerConfig,
  ) {}

  /** Marca cronômetros vencidos (função do banco; gera eventos `sla_breached`). */
  async markBreaches(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>('SELECT sla_mark_breaches() AS n');
    const n = Number(rows[0]?.n ?? 0);
    this.logger[n ? 'log' : 'debug']({ breached: n }, 'SLA: estouros marcados');
    return n;
  }

  /**
   * Alerta "SLA perto de vencer": quando resta SLA_WARNING_REMAINING do prazo (padrão 20%, ou seja,
   * 80% consumido). Uma vez por prazo (warned_at, migration 014). Gera evento `sla_warning` (que
   * alimenta as automações) e e-mail para o responsável, se houver.
   * A fração é medida em tempo corrido desde a abertura, uma aproximação do prazo em minutos úteis.
   */
  async warnNearDue(): Promise<number> {
    const remaining = this.config.get('SLA_WARNING_REMAINING');
    return this.db.tx(async (c) => {
      const { rows } = await c.query<{
        id: string; ticket_id: string; tenant_id: string; kind: string; due_at: Date; number: string;
        subject: string; email: string | null; timezone: string;
      }>(
        `SELECT k.id, k.ticket_id, k.tenant_id, k.kind::text, k.due_at, t.number::text, t.subject, u.email::text, tn.timezone
           FROM sla_timers k
           JOIN tickets t  ON t.id = k.ticket_id
           JOIN tenants tn ON tn.id = t.tenant_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE k.met_at IS NULL AND k.paused_at IS NULL AND k.breached_at IS NULL AND k.warned_at IS NULL
            AND k.due_at > now()
            AND now() >= k.due_at - (k.due_at - t.created_at) * $1::float8
          ORDER BY k.due_at
          FOR UPDATE OF k SKIP LOCKED
          LIMIT 500`,
        [remaining],
      );
      for (const r of rows) {
        await c.query('UPDATE sla_timers SET warned_at = now() WHERE id = $1', [r.id]);
        await c.query(
          `INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
           VALUES ($1, $2, NULL, 'sla_warning', jsonb_build_object('kind', $3::text, 'due_at', $4::timestamptz))`,
          [r.tenant_id, r.ticket_id, r.kind, r.due_at],
        );
        if (r.email) {
          await c.query(
            `INSERT INTO email_outbox (tenant_id, to_email, template, payload)
             VALUES ($1, $2, 'sla_warning', jsonb_build_object('ticket_id', $3::uuid, 'number', $4::bigint, 'subject', $5::text,
                     'kind', $6::text, 'due_at', $7::timestamptz, 'timezone', $8::text))`,
            [r.tenant_id, r.email, r.ticket_id, r.number, r.subject, r.kind, r.due_at, r.timezone],
          );
        }
      }
      if (rows.length) this.logger.log({ warned: rows.length }, 'SLA: alertas de vencimento próximo');
      return rows.length;
    });
  }

  /** Limpeza diária: sessões/resets expirados e histórico antigo do avaliador de automações. */
  async purge(): Promise<{ auth: number; automationRuns: number }> {
    const a = await this.db.query<{ n: string }>('SELECT auth_purge_expired() AS n');
    const r = await this.db.query("DELETE FROM automation_runs WHERE processed_at < now() - interval '7 days'");
    const out = { auth: Number(a.rows[0]?.n ?? 0), automationRuns: r.rowCount ?? 0 };
    this.logger.log(out, 'limpeza diária');
    return out;
  }
}
