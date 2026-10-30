import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AutomationEvent } from '@helpdesk/shared';
import type { Tx } from '../../common/db/db.service.js';
import type { WorkerEnv } from '../worker.env.js';
import { WorkerDbService } from '../worker-db.service.js';
import { planActions, ruleMatches, type PlannedChanges, type TicketSnapshot } from './evaluate.js';

/** Tipo de evento de auditoria (ticket_events.event_type) → evento de automação. */
const EVENT_MAP: Record<string, AutomationEvent> = {
  created: 'ticket_created',
  status_changed: 'ticket_updated',
  assigned: 'ticket_updated',
  priority_changed: 'ticket_updated',
  queue_changed: 'ticket_updated',
  category_changed: 'ticket_updated',
  sla_warning: 'sla_warning',
  sla_breached: 'sla_breached',
};

export interface AutomationRunResult {
  processed: number;
  matched: number;
  errors: number;
}

/**
 * Avalia automation_rules sobre eventos novos de ticket_events (último dia).
 * - Idempotente e seguro com várias instâncias: cada evento é travado (SKIP LOCKED) e registrado em
 *   automation_runs na mesma transação em que as ações são aplicadas.
 * - Sem cascata: os eventos gerados pelas próprias ações (mesma transação) são registrados como
 *   `skipped`, então mudanças feitas por automação não disparam automações.
 * - Respeita o plano: sem `features.automations`, o evento é registrado sem avaliar regras.
 * - Ação inválida (ex.: agente desativado) desfaz só as ações (SAVEPOINT) e grava o erro.
 */
@Injectable()
export class AutomationJob {
  private readonly logger = new Logger(AutomationJob.name);
  private readonly batch: number;

  constructor(
    private readonly db: WorkerDbService,
    config: ConfigService<WorkerEnv, true>,
  ) {
    this.batch = config.get('AUTOMATION_BATCH_SIZE', { infer: true });
  }

  async runOnce(): Promise<AutomationRunResult> {
    const result: AutomationRunResult = { processed: 0, matched: 0, errors: 0 };
    for (let i = 0; i < this.batch; i++) {
      const outcome = await this.db.tx((tx) => this.processNext(tx));
      if (!outcome) break;
      result.processed++;
      result.matched += outcome.matched;
      if (outcome.error) result.errors++;
    }
    if (result.processed) this.logger.log(`automações: ${result.processed} evento(s), ${result.matched} regra(s) aplicada(s), ${result.errors} erro(s)`);
    return result;
  }

  private async processNext(tx: Tx): Promise<{ matched: number; error: string | null } | null> {
    const ev = await tx.query<{ id: string; tenant_id: string; ticket_id: string; event_type: string }>(
      `SELECT e.id, e.tenant_id, e.ticket_id, e.event_type
         FROM ticket_events e
        WHERE e.created_at > now() - interval '1 day'
          AND e.event_type = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.event_id = e.id)
        ORDER BY e.id
        LIMIT 1
        FOR UPDATE OF e SKIP LOCKED`,
      [Object.keys(EVENT_MAP)],
    );
    const e = ev.rows[0];
    if (!e) return null;

    const event = EVENT_MAP[e.event_type]!;
    let matched = 0;
    let error: string | null = null;

    const enabled = await tx.query<{ on: boolean }>(
      `SELECT COALESCE((p.features->>'automations')::boolean, false) AS on
         FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
      [e.tenant_id],
    );
    if (enabled.rows[0]?.on) {
      const rules = await tx.query<{ name: string; conditions: unknown; actions: unknown }>(
        `SELECT name, conditions, actions FROM automation_rules
          WHERE tenant_id = $1 AND event = $2 AND active ORDER BY position, created_at`,
        [e.tenant_id, event],
      );
      const snap = await this.snapshot(tx, e.tenant_id, e.ticket_id);
      const hits = snap ? rules.rows.filter((r) => ruleMatches(r.conditions, snap)) : [];
      matched = hits.length;
      if (hits.length && snap) {
        await tx.query('SAVEPOINT apply_actions');
        try {
          await this.apply(tx, e.tenant_id, e.ticket_id, planActions(hits));
          // eventos gerados agora pelas ações não reentram na avaliação
          await tx.query(
            `INSERT INTO automation_runs (event_id, tenant_id, skipped)
             SELECT id, tenant_id, true FROM ticket_events
              WHERE ticket_id = $1 AND id > $2 AND created_at = now() AND actor_id IS NULL
             ON CONFLICT DO NOTHING`,
            [e.ticket_id, e.id],
          );
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT apply_actions');
          error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          this.logger.warn(`automação do evento ${e.id} falhou: ${error}`);
        }
      }
    }

    await tx.query(
      `INSERT INTO automation_runs (event_id, tenant_id, rules_matched, error) VALUES ($1, $2, $3, $4)`,
      [e.id, e.tenant_id, matched, error],
    );
    return { matched, error };
  }

  private async snapshot(tx: Tx, tenantId: string, ticketId: string): Promise<TicketSnapshot | null> {
    const { rows } = await tx.query<Record<string, string | string[] | null>>(
      `SELECT t.subject, t.description, t.channel::text AS channel, t.tags,
              t.priority_id::text AS "priority.id", p.name AS "priority.name",
              t.status_id::text AS "status.id", s.name AS "status.name", s.kind::text AS "status.kind",
              t.category_id::text AS "category.id", c.name AS "category.name",
              t.queue_id::text AS "queue.id", t.organization_id::text AS "organization.id",
              t.assignee_id::text AS "assignee.id", t.requester_id::text AS "requester.id"
         FROM tickets t
         JOIN priorities p ON p.id = t.priority_id
         JOIN statuses s ON s.id = t.status_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.id = $1 AND t.tenant_id = $2`,
      [ticketId, tenantId],
    );
    return rows[0] ?? null;
  }

  /** sd_worker ignora a RLS: tudo filtrado por tenant; as FKs compostas barram IDs de outro tenant. */
  private async apply(tx: Tx, tenantId: string, ticketId: string, plan: PlannedChanges): Promise<void> {
    const params: unknown[] = [ticketId, tenantId];
    const sets: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      sets.push(sql.replace('?', `$${params.length}`));
    };
    if (plan.queueId) add('queue_id = ?', plan.queueId);
    if (plan.assigneeId) add('assignee_id = ?', plan.assigneeId);
    if (plan.priorityId) add('priority_id = ?', plan.priorityId);
    if (plan.addTags.length) add('tags = ARRAY(SELECT DISTINCT x FROM unnest(tags || ?::text[]) x ORDER BY x)', plan.addTags);
    if (sets.length) {
      await tx.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
    }
    for (const rule of plan.notify) {
      await tx.query(
        `INSERT INTO email_outbox (tenant_id, to_email, template, payload)
         SELECT t.tenant_id, u.email, 'notify_staff',
                jsonb_build_object('ticket_id', t.id, 'number', t.number, 'subject', t.subject, 'rule', $3::text)
           FROM tickets t
           JOIN memberships m ON m.tenant_id = t.tenant_id AND m.role IN ('admin', 'agent') AND m.active
           JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
          WHERE t.id = $1 AND t.tenant_id = $2`,
        [ticketId, tenantId, rule],
      );
    }
  }
}
