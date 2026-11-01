import type { MemberRole } from '../common/auth/auth.types.js';

type Ref = { id: string; name: string } | null;

export interface SlaTimerView {
  state: 'running' | 'paused' | 'met' | 'met_late' | 'breached';
  dueAt: string;
  minutesRemaining: number | null;
}

/** Linha devolvida por ticketSelect(). */
export interface TicketRow {
  id: string;
  number: string;
  subject: string;
  description?: string;
  channel: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  status: { id: string; name: string; kind: string; color: string };
  priority: { id: string; name: string; level: number; color: string };
  requester: { id: string; name: string; email: string } | null;
  assignee: Ref;
  organization: Ref;
  queue: Ref;
  category: Ref;
  sla: Record<string, { state: SlaTimerView['state']; due_at: string; minutes_remaining: number | null }> | null;
  next_due: Date | null;
  cursor_updated: string;
  cursor_created: string;
  cursor_due: string;
}

/**
 * SELECT base de chamados, com nomes e SLA já resolvidos (sem N+1). Tudo passa pela RLS de quem
 * consulta: para o cliente, `sla` sai vazio (sla_timers é só da equipe) e organização sai nula.
 * Os campos cursor_* são texto do Postgres (precisão de microssegundos) para a paginação.
 */
export const ticketSelect = (withDescription = false) => `
  SELECT t.id, t.number, t.subject,${withDescription ? ' t.description,' : ''} t.channel, t.tags, t.custom_fields,
         t.created_at, t.updated_at, t.first_response_at, t.resolved_at, t.closed_at,
         json_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color) AS status,
         json_build_object('id', p.id, 'name', p.name, 'level', p.level, 'color', p.color) AS priority,
         CASE WHEN ru.id IS NULL THEN NULL ELSE json_build_object('id', ru.id, 'name', ru.name, 'email', ru.email) END AS requester,
         CASE WHEN au.id IS NULL THEN NULL ELSE json_build_object('id', au.id, 'name', au.name) END AS assignee,
         CASE WHEN o.id  IS NULL THEN NULL ELSE json_build_object('id', o.id,  'name', o.name)  END AS organization,
         CASE WHEN q.id  IS NULL THEN NULL ELSE json_build_object('id', q.id,  'name', q.name)  END AS queue,
         CASE WHEN c.id  IS NULL THEN NULL ELSE json_build_object('id', c.id,  'name', c.name)  END AS category,
         sla.timers AS sla, sla.next_due,
         t.updated_at::text AS cursor_updated,
         t.created_at::text AS cursor_created,
         COALESCE(sla.next_due, 'infinity'::timestamptz)::text AS cursor_due
    FROM tickets t
    JOIN statuses s   ON s.id = t.status_id
    JOIN priorities p ON p.id = t.priority_id
    LEFT JOIN users ru ON ru.id = t.requester_id
    LEFT JOIN users au ON au.id = t.assignee_id
    LEFT JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN queues q        ON q.id = t.queue_id
    LEFT JOIN categories c    ON c.id = t.category_id
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(v.kind, jsonb_build_object('state', v.state, 'due_at', v.due_at,
                                                         'minutes_remaining', v.minutes_remaining)) AS timers,
             min(v.due_at) FILTER (WHERE v.met_at IS NULL AND v.paused_at IS NULL) AS next_due
        FROM v_ticket_sla v WHERE v.ticket_id = t.id
    ) sla ON true`;

const isStaff = (role: MemberRole) => role === 'admin' || role === 'agent';

/** Formato público (camelCase). O cliente não recebe dados internos (SLA, fila, tags, campos). */
export function toTicketView(r: TicketRow, role: MemberRole) {
  const base = {
    id: r.id,
    number: Number(r.number),
    subject: r.subject,
    ...(r.description === undefined ? {} : { description: r.description }),
    channel: r.channel,
    status: r.status,
    priority: r.priority,
    requester: r.requester,
    assignee: r.assignee,
    category: r.category,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
  };
  if (!isStaff(role)) return base;
  return {
    ...base,
    organization: r.organization,
    queue: r.queue,
    tags: r.tags,
    customFields: r.custom_fields,
    sla: r.sla
      ? Object.fromEntries(
          Object.entries(r.sla).map(([kind, v]) => [
            kind,
            { state: v.state, dueAt: v.due_at, minutesRemaining: v.minutes_remaining } satisfies SlaTimerView,
          ]),
        )
      : null,
    nextDueAt: r.next_due,
  };
}

export type TicketView = ReturnType<typeof toTicketView>;
