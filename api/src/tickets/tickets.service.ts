import { Injectable } from '@nestjs/common';
import type { MemberRole, TenantAuth } from '../common/auth/auth.types.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { AppError } from '../common/errors/app-error.js';
import { decodeCursor, encodeCursor, type Page } from '../common/http/cursor.js';
import type { BulkUpdateDto, CreateMessageDto, CreateTicketDto, ListTicketsQuery, UpdateTicketDto } from './dto/ticket.dto.js';
import { likeContains, SqlParams } from '../common/db/sql-params.js';
import { ticketSelect, toTicketView, type TicketRow, type TicketView } from './ticket.view.js';

const STATUS_KINDS = ['open', 'pending', 'on_hold', 'resolved', 'closed'];
const UNRESOLVED = ['open', 'pending', 'on_hold'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 25;

interface SortSpec {
  keys: string[];
  casts: string[];
  cursor: (r: TicketRow) => (string | number)[];
  dir: 'ASC' | 'DESC';
}

/** Ordenações permitidas (lista fechada: nada vindo do usuário entra no ORDER BY). */
const SORTS: Record<NonNullable<ListTicketsQuery['sort']>, SortSpec> = {
  updated: { keys: ['t.updated_at', 't.id'], casts: ['timestamptz', 'uuid'], cursor: (r) => [r.cursor_updated, r.id], dir: 'DESC' },
  created: { keys: ['t.created_at', 't.id'], casts: ['timestamptz', 'uuid'], cursor: (r) => [r.cursor_created, r.id], dir: 'DESC' },
  priority: {
    keys: ['p.level', 't.updated_at', 't.id'],
    casts: ['smallint', 'timestamptz', 'uuid'],
    cursor: (r) => [r.priority.level, r.cursor_updated, r.id],
    dir: 'DESC',
  },
  due: {
    keys: ["COALESCE(sla.next_due, 'infinity'::timestamptz)", 't.id'],
    casts: ['timestamptz', 'uuid'],
    cursor: (r) => [r.cursor_due, r.id],
    dir: 'ASC',
  },
};

/** Campos que o cliente (requester) pode informar ao abrir um chamado. */
const REQUESTER_CREATE_FIELDS = new Set(['subject', 'description', 'categoryId']);

/** DTO -> coluna. Só estas colunas têm GRANT UPDATE para sd_app (migration 008). */
const UPDATABLE: Record<keyof UpdateTicketDto, string> = {
  subject: 'subject',
  description: 'description',
  assigneeId: 'assignee_id',
  queueId: 'queue_id',
  categoryId: 'category_id',
  organizationId: 'organization_id',
  priorityId: 'priority_id',
  statusId: 'status_id',
  tags: 'tags',
  customFields: 'custom_fields',
};

const notFound = () => new AppError(404, 'not_found', 'Chamado não encontrado.');

@Injectable()
export class TicketsService {
  constructor(private readonly db: DbService) {}

  list(auth: TenantAuth, q: ListTicketsQuery): Promise<Page<TicketView>> {
    const p = new SqlParams();
    const where: string[] = [];

    if (q.status) {
      const ids: string[] = [];
      const kinds = new Set<string>();
      for (const raw of q.status.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (UUID.test(raw)) ids.push(raw);
        else if (raw === 'unresolved') UNRESOLVED.forEach((k) => kinds.add(k));
        else if (STATUS_KINDS.includes(raw)) kinds.add(raw);
        else throw new AppError(400, 'invalid_filter', `Filtro de status inválido: ${raw.slice(0, 40)}`);
      }
      where.push(`(t.status_id = ANY(${p.add(ids)}::uuid[]) OR s.kind = ANY(${p.add([...kinds])}::status_kind[]))`);
    }
    if (q.assignee === 'me') where.push(`t.assignee_id = ${p.add(auth.userId)}`);
    else if (q.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (q.assignee) where.push(`t.assignee_id = ${p.add(q.assignee)}::uuid`);

    if (q.queue) where.push(`t.queue_id = ${p.add(q.queue)}`);
    if (q.category) where.push(`t.category_id = ${p.add(q.category)}`);
    if (q.priority) where.push(`t.priority_id = ${p.add(q.priority)}`);
    if (q.organization) where.push(`t.organization_id = ${p.add(q.organization)}`);
    if (q.requester) where.push(`t.requester_id = ${p.add(q.requester)}`);
    if (q.tag) where.push(`t.tags @> ARRAY[${p.add(q.tag.trim().toLowerCase())}::text]`);
    if (q.sla) where.push(`EXISTS (SELECT 1 FROM v_ticket_sla v WHERE v.ticket_id = t.id AND v.state = ${p.add(q.sla)})`);
    if (q.createdFrom) where.push(`t.created_at >= ${p.add(q.createdFrom)}::timestamptz`);
    if (q.createdTo) where.push(`t.created_at < ${p.add(q.createdTo)}::timestamptz`);
    if (q.q) {
      const text = q.q.trim();
      const parts = [
        `t.search @@ websearch_to_tsquery('portuguese', ${p.add(text)})`,
        `t.subject ILIKE ${p.add(likeContains(text))}`,
      ];
      const num = /^#?(\d{1,15})$/.exec(text);
      if (num) parts.push(`t.number = ${p.add(num[1])}::bigint`);
      where.push(`(${parts.join(' OR ')})`);
    }

    const sort = SORTS[q.sort ?? 'updated'];
    if (q.cursor) {
      const values = decodeCursor(q.cursor, sort.keys.length);
      const placeholders = values.map((v, i) => `${p.add(v)}::${sort.casts[i]}`);
      where.push(`(${sort.keys.join(', ')}) ${sort.dir === 'DESC' ? '<' : '>'} (${placeholders.join(', ')})`);
    }

    const limit = q.limit ?? DEFAULT_LIMIT;
    const sql = `${ticketSelect()}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${sort.keys.map((k) => `${k} ${sort.dir}`).join(', ')}
      LIMIT ${p.add(limit + 1)}`;

    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<TicketRow>(sql, p.values);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map((r) => toTicketView(r, auth.role)),
        nextCursor: hasMore && last ? encodeCursor(sort.cursor(last)) : null,
      };
    });
  }

  get(auth: TenantAuth, id: string) {
    return this.db.withTenant(auth, async (c) => {
      const ticket = await this.findView(c, id, auth.role, true);
      if (!ticket) throw notFound();
      const staff = auth.role !== 'requester';

      const [messages, attachments, events, time] = await Promise.all([
        c.query(
          `SELECT m.id, m.kind, m.body, m.channel, m.created_at AS "createdAt",
                  CASE WHEN m.author_id IS NULL THEN NULL
                       ELSE json_build_object('id', m.author_id, 'name', u.name, 'role', mm.role) END AS author
             FROM ticket_messages m
             LEFT JOIN users u        ON u.id = m.author_id
             LEFT JOIN memberships mm ON mm.tenant_id = m.tenant_id AND mm.user_id = m.author_id
            WHERE m.ticket_id = $1
            ORDER BY m.created_at, m.id`,
          [id],
        ),
        c.query(
          `SELECT id, message_id AS "messageId", filename, content_type AS "contentType",
                  size_bytes::int AS "sizeBytes", uploaded_by AS "uploadedBy", created_at AS "createdAt"
             FROM attachments WHERE ticket_id = $1 ORDER BY created_at, id`,
          [id],
        ),
        staff
          ? c.query(
              `SELECT e.id::text AS id, e.event_type AS type, e.data, e.created_at AS "createdAt",
                      CASE WHEN e.actor_id IS NULL THEN NULL ELSE json_build_object('id', e.actor_id, 'name', u.name) END AS actor
                 FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
                WHERE e.ticket_id = $1
                ORDER BY e.created_at, e.id`,
              [id],
            )
          : null,
        staff
          ? c.query<{ total: number }>('SELECT COALESCE(sum(minutes), 0)::int AS total FROM time_entries WHERE ticket_id = $1', [id])
          : null,
      ]);

      return {
        ...ticket,
        messages: messages.rows,
        attachments: attachments.rows,
        ...(staff ? { events: events!.rows, timeLoggedMinutes: time!.rows[0]?.total ?? 0 } : {}),
      };
    });
  }

  create(auth: TenantAuth, dto: CreateTicketDto): Promise<TicketView> {
    if (auth.role === 'requester') {
      const extra = Object.entries(dto).filter(([k, v]) => v !== undefined && !REQUESTER_CREATE_FIELDS.has(k));
      if (extra.length) {
        throw new AppError(403, 'field_not_allowed', 'Clientes não podem definir esses campos do chamado.', extra.map(([k]) => k));
      }
    }

    const cols: Record<string, unknown> = {
      tenant_id: auth.tenantId,
      subject: dto.subject,
      description: dto.description ?? '',
      requester_id: dto.requesterId ?? auth.userId,
      category_id: dto.categoryId,
      priority_id: dto.priorityId,
      status_id: dto.statusId,
      queue_id: dto.queueId,
      assignee_id: dto.assigneeId,
      organization_id: dto.organizationId,
      channel: dto.channel,
      tags: dto.tags,
      custom_fields: dto.customFields,
    };
    const p = new SqlParams();
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    const sql = `INSERT INTO tickets (${entries.map(([k]) => k).join(', ')})
                 VALUES (${entries.map(([, v]) => p.add(v)).join(', ')}) RETURNING id`;

    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<{ id: string }>(sql, p.values);
      const view = await this.findView(c, rows[0]!.id, auth.role);
      return view!;
    });
  }

  update(auth: TenantAuth, id: string, dto: UpdateTicketDto): Promise<TicketView> {
    const p = new SqlParams();
    const sets = (Object.keys(UPDATABLE) as (keyof UpdateTicketDto)[])
      .filter((k) => dto[k] !== undefined)
      .map((k) => `${UPDATABLE[k]} = ${p.add(dto[k])}`);
    if (!sets.length) throw new AppError(400, 'nothing_to_update', 'Informe ao menos um campo para alterar.');

    const sql = `UPDATE tickets SET ${sets.join(', ')} WHERE id = ${p.add(id)} RETURNING id`;
    return this.db.withTenant(auth, async (c) => {
      const { rowCount } = await c.query(sql, p.values);
      // A RLS de UPDATE filtra em silêncio (0 linhas): distinguimos "não existe" de "sem permissão".
      if (!rowCount) throw (await this.isVisible(c, id)) ? forbidden() : notFound();
      return (await this.findView(c, id, auth.role))!;
    });
  }

  bulk(auth: TenantAuth, dto: BulkUpdateDto): Promise<{ updated: string[]; notFound: string[] }> {
    const ch = dto.changes;
    const p = new SqlParams();
    const sets: string[] = [];
    if (ch.assigneeId !== undefined) sets.push(`assignee_id = ${p.add(ch.assigneeId)}`);
    if (ch.queueId !== undefined) sets.push(`queue_id = ${p.add(ch.queueId)}`);
    if (ch.statusId !== undefined) sets.push(`status_id = ${p.add(ch.statusId)}`);
    if (ch.priorityId !== undefined) sets.push(`priority_id = ${p.add(ch.priorityId)}`);
    if (ch.addTags?.length) sets.push(`tags = ARRAY(SELECT DISTINCT x FROM unnest(tags || ${p.add(ch.addTags)}::text[]) x ORDER BY x)`);
    if (!sets.length) throw new AppError(400, 'nothing_to_update', 'Informe ao menos uma alteração.');

    const ids = [...new Set(dto.ids)];
    const sql = `UPDATE tickets SET ${sets.join(', ')} WHERE id = ANY(${p.add(ids)}::uuid[]) RETURNING id`;
    // uma transação: ou todos os chamados mudam, ou nenhum (ex.: responsável inválido)
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<{ id: string }>(sql, p.values);
      const done = new Set(rows.map((r) => r.id));
      return { updated: [...done], notFound: ids.filter((i) => !done.has(i)) };
    });
  }

  addMessage(auth: TenantAuth, ticketId: string, dto: CreateMessageDto) {
    return this.db.withTenant(auth, async (c) => {
      if (!(await this.isVisible(c, ticketId))) throw notFound();
      // a RLS decide: cliente só grava resposta pública em chamado seu (nota interna => 42501 => 403)
      const { rows } = await c.query(
        `INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body, channel)
         VALUES ($1, $2, $3, $4, $5, 'portal')
         RETURNING id, kind, body, channel, created_at AS "createdAt"`,
        [auth.tenantId, ticketId, auth.userId, dto.kind, dto.body],
      );
      // os triggers podem ter mudado o chamado (primeira resposta, reabertura)
      const ticket = await this.findView(c, ticketId, auth.role);
      return { message: rows[0], ticket };
    });
  }

  private async findView(c: DbClient, id: string, role: MemberRole, withDescription = false): Promise<TicketView | null> {
    const { rows } = await c.query<TicketRow>(`${ticketSelect(withDescription)} WHERE t.id = $1`, [id]);
    return rows[0] ? toTicketView(rows[0], role) : null;
  }

  private async isVisible(c: DbClient, id: string): Promise<boolean> {
    const { rowCount } = await c.query('SELECT 1 FROM tickets WHERE id = $1', [id]);
    return !!rowCount;
  }
}

const forbidden = () => new AppError(403, 'forbidden', 'Você não tem permissão para alterar este chamado.');
