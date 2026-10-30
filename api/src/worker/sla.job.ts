import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from './worker.env.js';
import { WorkerDbService } from './worker-db.service.js';

export interface SlaRunResult {
  breached: number;
  warned: number;
}

/**
 * A cada minuto:
 * - sla_mark_breaches() (função do banco): marca estouros e grava 'sla_breached' na auditoria;
 * - alerta de "perto de vencer": cronômetro rodando que já consumiu SLA_WARNING_RATIO do prazo
 *   (em tempo corrido desde a abertura) recebe UM alerta: evento 'sla_warning' + e-mail para o
 *   responsável (ou para os admins, se não houver). A tabela sla_alerts garante uma vez só,
 *   inclusive com vários workers (INSERT ... ON CONFLICT DO NOTHING na mesma transação).
 */
@Injectable()
export class SlaJob {
  private readonly logger = new Logger(SlaJob.name);
  private readonly ratio: number;

  constructor(
    private readonly db: WorkerDbService,
    config: ConfigService<WorkerEnv, true>,
  ) {
    this.ratio = config.get('SLA_WARNING_RATIO', { infer: true });
  }

  async runOnce(): Promise<SlaRunResult> {
    const { rows } = await this.db.query<{ n: string }>('SELECT sla_mark_breaches() AS n');
    const breached = Number(rows[0]?.n ?? 0);
    const warned = await this.warn();
    if (breached || warned) this.logger.log(`SLA: ${breached} estouro(s) marcado(s), ${warned} alerta(s) enviado(s)`);
    return { breached, warned };
  }

  private warn(): Promise<number> {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ timer_id: string; tenant_id: string; ticket_id: string; kind: string; due_at: Date }>(
        `WITH cand AS (
           SELECT st.id, st.tenant_id, st.ticket_id, st.kind, st.due_at
             FROM sla_timers st JOIN tickets t ON t.id = st.ticket_id
            WHERE st.met_at IS NULL AND st.paused_at IS NULL AND st.breached_at IS NULL
              AND st.due_at > now()
              AND now() >= t.created_at + (st.due_at - t.created_at) * $1::float8
              AND NOT EXISTS (SELECT 1 FROM sla_alerts a WHERE a.timer_id = st.id)
            ORDER BY st.due_at
            LIMIT 200
         ), ins AS (
           INSERT INTO sla_alerts (timer_id, tenant_id) SELECT id, tenant_id FROM cand
           ON CONFLICT DO NOTHING RETURNING timer_id
         )
         SELECT c.id AS timer_id, c.tenant_id, c.ticket_id, c.kind, c.due_at FROM cand c JOIN ins ON ins.timer_id = c.id`,
        [this.ratio],
      );
      for (const r of rows) {
        await tx.query(
          `INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
           VALUES ($1, $2, NULL, 'sla_warning', jsonb_build_object('kind', $3::text, 'due_at', $4::timestamptz))`,
          [r.tenant_id, r.ticket_id, r.kind, r.due_at],
        );
        // responsável ativo; sem responsável, os admins ativos do tenant
        await tx.query(
          `INSERT INTO email_outbox (tenant_id, to_email, template, payload)
           SELECT t.tenant_id, u.email, 'sla_warning',
                  jsonb_build_object('ticket_id', t.id, 'number', t.number, 'subject', t.subject, 'kind', $2::text, 'due_at', $3::timestamptz)
             FROM tickets t
             JOIN memberships m ON m.tenant_id = t.tenant_id AND m.active
                               AND ((t.assignee_id IS NOT NULL AND m.user_id = t.assignee_id)
                                 OR (t.assignee_id IS NULL AND m.role = 'admin'))
             JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
            WHERE t.id = $1`,
          [r.ticket_id, r.kind, r.due_at],
        );
      }
      return rows.length;
    });
  }
}
