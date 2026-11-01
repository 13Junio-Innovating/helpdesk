import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { actionSchema, conditionSchema } from '../catalog/automation-rules.js';
import { planActions, ruleMatches, type PlannedChanges, type TicketFacts } from './automation-engine.js';
import { WorkerDbService, type WorkerClient } from './worker-db.service.js';

/** Evento de auditoria -> evento de automação. */
const EVENT_MAP: Record<string, string> = {
  created: 'ticket_created',
  status_changed: 'ticket_updated',
  assigned: 'ticket_updated',
  priority_changed: 'ticket_updated',
  queue_changed: 'ticket_updated',
  category_changed: 'ticket_updated',
  sla_warning: 'sla_warning',
  sla_breached: 'sla_breached',
};

const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  conditions: z.array(conditionSchema),
  actions: z.array(actionSchema),
});

interface EventRow { id: string; tenant_id: string; ticket_id: string; event_type: string }

/**
 * Avaliador de automações.
 *  - Cada evento é avaliado UMA vez: a linha em automation_runs (PK = event_id) é a trava entre instâncias.
 *  - Uma transação por evento: se uma ação falhar (ex.: agente desativado), só aquele evento é desfeito
 *    e fica registrado como `error`, sem travar a fila.
 *  - Sem cascata: os eventos gerados pelas próprias ações (mudança de fila, prioridade...) são marcados
 *    como `skipped` na mesma transação, então nenhuma regra dispara por causa de outra.
 *  - Todas as regras do evento são avaliadas sobre o estado do chamado no momento da avaliação.
 */
@Injectable()
export class AutomationsProcessor {
  private readonly logger = new Logger(AutomationsProcessor.name);

  constructor(private readonly db: WorkerDbService) {}

  async processBatch(limit = 100): Promise<{ events: number; applied: number }> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT e.id::text, e.tenant_id, e.ticket_id, e.event_type
         FROM ticket_events e
        WHERE e.created_at > now() - interval '1 day'
          AND e.event_type = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.event_id = e.id)
        ORDER BY e.id
        LIMIT $2`,
      [Object.keys(EVENT_MAP), limit],
    );
    let applied = 0;
    for (const ev of rows) {
      try {
        if (await this.db.tx((c) => this.handle(c, ev))) applied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn({ eventId: ev.id, error: message }, 'automação falhou; evento registrado como erro');
        await this.db.query(
          `INSERT INTO automation_runs (event_id, tenant_id, outcome, error) VALUES ($1, $2, 'error', left($3, 500))
           ON CONFLICT (event_id) DO NOTHING`,
          [ev.id, ev.tenant_id, message],
        );
      }
    }
    if (applied) this.logger.log({ events: rows.length, applied }, 'automações aplicadas');
    return { events: rows.length, applied };
  }

  async drain(maxBatches = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = await this.processBatch();
      total += r.events;
      if (!r.events) break;
    }
    return total;
  }

  /** true se alguma regra foi aplicada. */
  private async handle(c: WorkerClient, ev: EventRow): Promise<boolean> {
    // trava: se outra instância já pegou o evento, a PK colide e paramos aqui
    const claim = await c.query(
      `INSERT INTO automation_runs (event_id, tenant_id, outcome) VALUES ($1, $2, 'no_match')
       ON CONFLICT (event_id) DO NOTHING RETURNING 1`,
      [ev.id, ev.tenant_id],
    );
    if (!claim.rowCount) return false;

    const plan = await c.query<{ on: boolean }>(
      `SELECT COALESCE((p.features->>'automations')::boolean, false) AS on
         FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [ev.tenant_id]);
    if (!plan.rows[0]?.on) {
      await c.query(`UPDATE automation_runs SET outcome = 'skipped' WHERE event_id = $1`, [ev.id]);
      return false;
    }

    const rules = await c.query(
      `SELECT id, name, conditions, actions FROM automation_rules
        WHERE tenant_id = $1 AND event = $2::automation_event AND active
        ORDER BY position, name`,
      [ev.tenant_id, EVENT_MAP[ev.event_type]],
    );
    if (!rules.rowCount) return false;

    const facts = await this.loadFacts(c, ev.ticket_id);
    if (!facts) return false;

    const matched: { id: string; name: string }[] = [];
    const changes: PlannedChanges = { addTags: [], notify: false };
    for (const raw of rules.rows) {
      const parsed = ruleSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn({ ruleId: (raw as { id: string }).id }, 'regra com formato inválido ignorada');
        continue;
      }
      if (!ruleMatches(parsed.data.conditions, facts)) continue;
      matched.push({ id: parsed.data.id, name: parsed.data.name });
      planActions(parsed.data.actions, changes);
    }
    if (!matched.length) return false;

    const before = await c.query<{ max: string | null }>('SELECT max(id)::text AS max FROM ticket_events WHERE ticket_id = $1', [ev.ticket_id]);
    await this.apply(c, ev, changes, matched.map((m) => m.name).join(', '));
    await c.query(
      `INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
       VALUES ($1, $2, NULL, 'automation_applied', jsonb_build_object('trigger_event', $3::bigint, 'rules', $4::jsonb, 'changes', $5::jsonb))`,
      [ev.tenant_id, ev.ticket_id, ev.id, JSON.stringify(matched), JSON.stringify(changes)],
    );
    // eventos gerados pelas ações desta automação não disparam outras regras (sem cascata)
    await c.query(
      `INSERT INTO automation_runs (event_id, tenant_id, outcome)
       SELECT id, tenant_id, 'skipped' FROM ticket_events WHERE ticket_id = $1 AND id > COALESCE($2::bigint, 0)
       ON CONFLICT (event_id) DO NOTHING`,
      [ev.ticket_id, before.rows[0]?.max ?? null],
    );
    await c.query(`UPDATE automation_runs SET outcome = 'applied', rules = $2::uuid[] WHERE event_id = $1`,
      [ev.id, matched.map((m) => m.id)]);
    return true;
  }

  private async apply(c: WorkerClient, ev: EventRow, ch: PlannedChanges, ruleNames: string): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [ev.ticket_id];
    const add = (col: string, v: unknown, cast = '') => { args.push(v); sets.push(`${col} = $${args.length}${cast}`); };
    if (ch.queue_id) add('queue_id', ch.queue_id, '::uuid');
    if (ch.assignee_id) add('assignee_id', ch.assignee_id, '::uuid');
    if (ch.priority_id) add('priority_id', ch.priority_id, '::uuid');
    if (ch.addTags.length) {
      args.push(ch.addTags);
      sets.push(`tags = ARRAY(SELECT DISTINCT x FROM unnest(tags || $${args.length}::text[]) x ORDER BY x)`);
    }
    // os triggers do banco validam (responsável da equipe, FKs do mesmo tenant) e auditam
    if (sets.length) await c.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1`, args);

    if (ch.notify) {
      // responsável; sem responsável, membros da fila; sem fila, toda a equipe ativa
      await c.query(
        `WITH t AS (SELECT * FROM tickets WHERE id = $1),
              rcpt AS (
                SELECT u.email FROM t JOIN users u ON u.id = t.assignee_id
                UNION
                SELECT u.email FROM t JOIN queue_members qm ON qm.queue_id = t.queue_id
                  JOIN memberships m ON m.tenant_id = qm.tenant_id AND m.user_id = qm.user_id AND m.active
                  JOIN users u ON u.id = qm.user_id
                 WHERE t.assignee_id IS NULL
                UNION
                SELECT u.email FROM t JOIN memberships m ON m.tenant_id = t.tenant_id AND m.role IN ('admin', 'agent') AND m.active
                  JOIN users u ON u.id = m.user_id
                 WHERE t.assignee_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM queue_members qm WHERE qm.queue_id = t.queue_id))
         INSERT INTO email_outbox (tenant_id, to_email, template, payload)
         SELECT t.tenant_id, r.email, 'staff_notification',
                jsonb_build_object('ticket_id', t.id, 'number', t.number, 'subject', t.subject, 'rule', $2::text)
           FROM t, rcpt r`,
        [ev.ticket_id, ruleNames],
      );
    }
  }

  private async loadFacts(c: WorkerClient, ticketId: string): Promise<TicketFacts | null> {
    const { rows } = await c.query<TicketFacts>(
      `SELECT t.subject, t.description, t.channel::text AS channel, t.tags,
              p.id::text AS "priority.id", p.name AS "priority.name",
              s.id::text AS "status.id", s.name AS "status.name", s.kind::text AS "status.kind",
              c.id::text AS "category.id", c.name AS "category.name",
              q.id::text AS "queue.id", q.name AS "queue.name",
              ru.email::text AS "requester.email",
              o.id::text AS "organization.id", o.name AS "organization.name"
         FROM tickets t
         JOIN priorities p ON p.id = t.priority_id
         JOIN statuses s   ON s.id = t.status_id
         LEFT JOIN categories c    ON c.id = t.category_id
         LEFT JOIN queues q        ON q.id = t.queue_id
         LEFT JOIN users ru        ON ru.id = t.requester_id
         LEFT JOIN organizations o ON o.id = t.organization_id
        WHERE t.id = $1
        FOR UPDATE OF t`,
      [ticketId],
    );
    return rows[0] ?? null;
  }
}
