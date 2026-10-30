import { STATUS_KINDS, type StatusKind, type TicketListItem, type TicketSort, type TicketSla } from '@helpdesk/shared';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import type { ListTicketsQuery } from './dto/ticket.dto.js';

/**
 * SELECT base de chamados com os nomes já resolvidos e o SLA agregado (evita N+1).
 * Os JOINs são só por id: a RLS garante que tudo é do tenant corrente. Para o cliente,
 * v_ticket_sla (security_invoker) não devolve linhas → `sla` vem nulo.
 */
export const TICKET_FROM = `
  FROM tickets t
  JOIN statuses   s ON s.id = t.status_id
  JOIN priorities p ON p.id = t.priority_id
  LEFT JOIN users ru ON ru.id = t.requester_id
  LEFT JOIN users au ON au.id = t.assignee_id
  LEFT JOIN queues q ON q.id = t.queue_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN organizations o ON o.id = t.organization_id
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(v.kind, jsonb_build_object(
             'state', v.state, 'dueAt', v.due_at, 'minutesRemaining', v.minutes_remaining)) AS timers,
           CASE
             WHEN bool_or(v.state = 'breached') THEN 'breached'
             WHEN bool_or(v.state = 'running')  THEN 'running'
             WHEN bool_or(v.state = 'paused')   THEN 'paused'
             WHEN bool_or(v.state = 'met_late') THEN 'met_late'
             WHEN count(*) > 0                  THEN 'met'
           END AS state,
           min(v.due_at) FILTER (WHERE v.state IN ('running', 'breached')) AS next_due
      FROM v_ticket_sla v
     WHERE v.ticket_id = t.id
  ) sla ON true`;

export const TICKET_COLUMNS = `
  t.id, t.number, t.subject, t.channel, t.tags, t.created_at, t.updated_at, t.first_response_at, t.resolved_at,
  s.id AS status_id, s.name AS status_name, s.kind AS status_kind, s.color AS status_color,
  p.id AS priority_id, p.name AS priority_name, p.level AS priority_level, p.color AS priority_color,
  ru.id AS requester_id, ru.name AS requester_name, ru.email AS requester_email,
  au.id AS assignee_id, au.name AS assignee_name,
  q.id AS queue_id, q.name AS queue_name,
  c.id AS category_id, c.name AS category_name,
  o.id AS organization_id, o.name AS organization_name,
  sla.timers AS sla_timers, sla.state AS sla_state`;

export interface TicketRow {
  id: string;
  number: string; // bigint chega como texto
  subject: string;
  channel: TicketListItem['channel'];
  tags: string[];
  created_at: Date;
  updated_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  status_id: string; status_name: string; status_kind: StatusKind; status_color: string;
  priority_id: string; priority_name: string; priority_level: number; priority_color: string;
  requester_id: string | null; requester_name: string | null; requester_email: string | null;
  assignee_id: string | null; assignee_name: string | null;
  queue_id: string | null; queue_name: string | null;
  category_id: string | null; category_name: string | null;
  organization_id: string | null; organization_name: string | null;
  sla_timers: Record<string, { state: TicketSla['state']; dueAt: string; minutesRemaining: number | null }> | null;
  sla_state: TicketSla['state'] | null;
}

const ref = (id: string | null, name: string | null) => (id && name !== null ? { id, name } : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toListItem(r: TicketRow): TicketListItem {
  return {
    id: r.id,
    number: Number(r.number),
    subject: r.subject,
    channel: r.channel,
    tags: r.tags,
    status: { id: r.status_id, name: r.status_name, kind: r.status_kind, color: r.status_color },
    priority: { id: r.priority_id, name: r.priority_name, level: r.priority_level, color: r.priority_color },
    requester: { id: r.requester_id ?? '', name: r.requester_name ?? '', email: r.requester_email ?? '' },
    assignee: ref(r.assignee_id, r.assignee_name),
    queue: ref(r.queue_id, r.queue_name),
    category: ref(r.category_id, r.category_name),
    organization: ref(r.organization_id, r.organization_name),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    firstResponseAt: iso(r.first_response_at),
    resolvedAt: iso(r.resolved_at),
    sla:
      r.sla_state && r.sla_timers
        ? {
            state: r.sla_state,
            firstResponse: r.sla_timers['first_response'] ?? null,
            resolution: r.sla_timers['resolution'] ?? null,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// ordenação por keyset: cada sort tem colunas de chave (todas na mesma direção) e seus casts

interface SortSpec {
  keys: string[]; // expressões SQL
  casts: string[]; // tipo para comparar o valor do cursor
  dir: 'ASC' | 'DESC';
}

const SORTS: Record<TicketSort, SortSpec> = {
  updated: { keys: ['t.updated_at', 't.id'], casts: ['timestamptz', 'uuid'], dir: 'DESC' },
  created: { keys: ['t.created_at', 't.id'], casts: ['timestamptz', 'uuid'], dir: 'DESC' },
  priority: { keys: ['p.level', 't.updated_at', 't.id'], casts: ['smallint', 'timestamptz', 'uuid'], dir: 'DESC' },
  // próximo vencimento primeiro; sem prazo em aberto vai para o fim
  due: { keys: [`COALESCE(sla.next_due, 'infinity'::timestamptz)`, 't.id'], casts: ['timestamptz', 'uuid'], dir: 'ASC' },
};

/** Escapa % _ \ para uso literal em LIKE. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export interface BuiltQuery {
  text: string;
  params: unknown[];
  limit: number;
  sort: SortSpec;
}

/** Monta a listagem com filtros 100% parametrizados; só nomes de coluna de listas fixas entram no SQL. */
export function buildListQuery(q: ListTicketsQuery, limit: number): BuiltQuery {
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (q.status?.length) {
    const kinds = q.status.filter((s): s is StatusKind => (STATUS_KINDS as readonly string[]).includes(s.toLowerCase())).map((s) => s.toLowerCase());
    const ids = q.status.filter((s) => !(STATUS_KINDS as readonly string[]).includes(s.toLowerCase()));
    const ors: string[] = [];
    if (kinds.length) ors.push(`s.kind = ANY(${p(kinds)}::status_kind[])`);
    if (ids.length) ors.push(`t.status_id = ANY(${p(ids)}::uuid[])`);
    where.push(`(${ors.join(' OR ')})`);
  }
  if (q.assignee === 'me') where.push('t.assignee_id = app_user_id()');
  else if (q.assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (q.assignee) where.push(`t.assignee_id = ${p(q.assignee)}`);

  if (q.queue) where.push(`t.queue_id = ${p(q.queue)}`);
  if (q.category) where.push(`t.category_id = ${p(q.category)}`);
  if (q.priority) where.push(`t.priority_id = ${p(q.priority)}`);
  if (q.organization) where.push(`t.organization_id = ${p(q.organization)}`);
  if (q.requester) where.push(`t.requester_id = ${p(q.requester)}`);
  if (q.sla) where.push(`sla.state = ${p(q.sla)}`);
  if (q.tag) where.push(`t.tags @> ARRAY[${p(q.tag)}]::text[]`);
  if (q.createdFrom) where.push(`t.created_at >= ${p(q.createdFrom)}::timestamptz`);
  if (q.createdTo) where.push(`t.created_at < ${p(q.createdTo)}::timestamptz`);

  if (q.q) {
    const num = /^#?(\d{1,18})$/.exec(q.q)?.[1];
    const term = p(q.q);
    const ors = [
      `t.search @@ websearch_to_tsquery('portuguese', ${term})`,
      // fallback para termos que o dicionário não reduz (siglas, parte de palavra): usa o índice trigram
      `t.subject ILIKE '%' || ${p(likeEscape(q.q))} || '%'`,
    ];
    if (num) ors.push(`t.number = ${p(num)}::bigint`);
    where.push(`(${ors.join(' OR ')})`);
  }

  const sort = SORTS[q.sort];
  if (q.cursor) {
    const values = decodeCursor(q.cursor, sort.keys.length);
    const op = sort.dir === 'DESC' ? '<' : '>';
    const rhs = values.map((v, i) => `${p(v)}::${sort.casts[i]}`).join(', ');
    where.push(`(${sort.keys.join(', ')}) ${op} (${rhs})`);
  }

  const order = sort.keys.map((k) => `${k} ${sort.dir}`).join(', ');
  const cursorCols = sort.keys.map((k, i) => `(${k})::text AS _k${i}`).join(', ');
  const text = `SELECT ${TICKET_COLUMNS}, ${cursorCols}
  ${TICKET_FROM}
  ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  ORDER BY ${order}
  LIMIT ${p(limit + 1)}`;
  return { text, params, limit, sort };
}

export function nextCursorOf(rows: Array<Record<string, unknown>>, sort: SortSpec): string {
  const last = rows[rows.length - 1]!;
  return encodeCursor(sort.keys.map((_, i) => String(last[`_k${i}`])));
}
