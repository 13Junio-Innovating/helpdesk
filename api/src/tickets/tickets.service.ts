import { Injectable } from '@nestjs/common';
import type {
  BulkUpdateResult,
  Paginated,
  TicketAttachment,
  TicketDetail,
  TicketEvent,
  TicketListItem,
  TicketMessage,
  TimeEntry,
  MemberRole,
} from '@helpdesk/shared';
import { DbService, type Tx } from '../common/db/db.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { tenantCtx } from '../common/auth/decorators.js';
import type { TenantUser } from '../common/auth/auth-user.js';
import { DEFAULT_LIMIT } from '../common/pagination/cursor.js';
import type {
  BulkUpdateDto,
  CreateMessageDto,
  CreateTicketDto,
  CreateTimeEntryDto,
  ListTicketsQuery,
  UpdateTicketDto,
} from './dto/ticket.dto.js';
import { buildListQuery, nextCursorOf, TICKET_COLUMNS, TICKET_FROM, toListItem, type TicketRow } from './ticket-sql.js';

const notFound = () => new AppException(404, 'not_found', 'Chamado não encontrado.');
const isStaff = (role: MemberRole) => role === 'admin' || role === 'agent';

/** Colunas que o sd_app pode atualizar (GRANT UPDATE em 008). Nada fora desta lista entra no SET. */
const UPDATABLE: ReadonlyArray<[keyof UpdateTicketDto, string]> = [
  ['subject', 'subject'],
  ['description', 'description'],
  ['statusId', 'status_id'],
  ['priorityId', 'priority_id'],
  ['assigneeId', 'assignee_id'],
  ['queueId', 'queue_id'],
  ['categoryId', 'category_id'],
  ['organizationId', 'organization_id'],
  ['tags', 'tags'],
  ['customFields', 'custom_fields'],
];

@Injectable()
export class TicketsService {
  constructor(private readonly db: DbService) {}

  list(user: TenantUser, query: ListTicketsQuery): Promise<Paginated<TicketListItem>> {
    const built = buildListQuery(query, query.limit ?? DEFAULT_LIMIT);
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const { rows } = await tx.query<TicketRow & Record<string, unknown>>(built.text, built.params);
      const page = rows.slice(0, built.limit);
      return {
        items: page.map(toListItem),
        nextCursor: rows.length > built.limit ? nextCursorOf(page, built.sort) : null,
      };
    });
  }

  get(user: TenantUser, id: string): Promise<TicketDetail> {
    return this.db.withTenant(tenantCtx(user), (tx, info) => this.detail(tx, id, info.role));
  }

  create(user: TenantUser, dto: CreateTicketDto): Promise<TicketDetail> {
    return this.db.withTenant(tenantCtx(user), async (tx, info) => {
      const staff = isStaff(info.role);
      // Para o cliente o banco já ignora status/prioridade/fila/responsável (trigger); aqui também
      // descartamos organização, canal e tags para ele não "se encaixar" em outra empresa.
      const values = {
        tenant_id: user.tenantId,
        subject: dto.subject,
        description: dto.description ?? '',
        requester_id: staff ? dto.requesterId ?? user.userId : user.userId,
        category_id: dto.categoryId ?? null,
        priority_id: staff ? dto.priorityId ?? null : null,
        status_id: staff ? dto.statusId ?? null : null,
        queue_id: staff ? dto.queueId ?? null : null,
        assignee_id: staff ? dto.assigneeId ?? null : null,
        organization_id: staff ? dto.organizationId ?? null : null,
        channel: staff ? dto.channel ?? 'portal' : 'portal',
        tags: staff ? dto.tags ?? [] : [],
        custom_fields: dto.customFields ?? {},
      };
      if (!staff && dto.requesterId && dto.requesterId !== user.userId) {
        throw new AppException(403, 'forbidden', 'Você só pode abrir chamados em seu próprio nome.');
      }
      const cols = Object.keys(values);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tickets (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(values),
      );
      return this.detail(tx, rows[0]!.id, info.role);
    });
  }

  update(user: TenantUser, id: string, dto: UpdateTicketDto): Promise<TicketDetail> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [field, column] of UPDATABLE) {
      const value = dto[field];
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos um campo para alterar.');

    return this.db.withTenant(tenantCtx(user), async (tx, info) => {
      // um UPDATE só: os triggers recalculam SLA/auditoria uma vez para o conjunto de mudanças
      const res = await tx.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
      if (res.rowCount === 0) await this.explainNoRows(tx, id);
      return this.detail(tx, id, info.role);
    });
  }

  bulkUpdate(user: TenantUser, dto: BulkUpdateDto): Promise<BulkUpdateResult> {
    const c = dto.changes;
    const sets: string[] = [];
    const params: unknown[] = [dto.ids];
    const add = (sql: (n: string) => string, v: unknown) => {
      params.push(v);
      sets.push(sql(`$${params.length}`));
    };
    if (c.statusId !== undefined) add((n) => `status_id = ${n}`, c.statusId);
    if (c.priorityId !== undefined) add((n) => `priority_id = ${n}`, c.priorityId);
    if (c.assigneeId !== undefined) add((n) => `assignee_id = ${n}`, c.assigneeId);
    if (c.queueId !== undefined) add((n) => `queue_id = ${n}`, c.queueId);
    if (c.categoryId !== undefined) add((n) => `category_id = ${n}`, c.categoryId);
    if (c.addTags?.length || c.removeTags?.length) {
      params.push(c.addTags ?? [], c.removeTags ?? []);
      const a = `$${params.length - 1}`;
      const r = `$${params.length}`;
      sets.push(`tags = ARRAY(SELECT DISTINCT x FROM unnest(tags || ${a}::text[]) x WHERE x <> ALL(${r}::text[]) ORDER BY x)`);
    }
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos uma alteração.');

    return this.db.withTenant(tenantCtx(user), async (tx) => {
      // um único UPDATE: tudo ou nada (um erro de FK/regra desfaz o lote inteiro)
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE tickets SET ${sets.join(', ')} WHERE id = ANY($1::uuid[]) RETURNING id`,
        params,
      );
      const updated = new Set(rows.map((r) => r.id));
      if (updated.size === 0) {
        // nada atualizado mas algum visível → falta de permissão (ex.: cliente)
        const visible = await tx.query('SELECT 1 FROM tickets WHERE id = ANY($1::uuid[]) LIMIT 1', [dto.ids]);
        if (visible.rowCount) throw new AppException(403, 'forbidden', 'Você não tem permissão para alterar estes chamados.');
      }
      return { updated: dto.ids.filter((i) => updated.has(i)), skipped: dto.ids.filter((i) => !updated.has(i)) };
    });
  }

  addMessage(user: TenantUser, ticketId: string, dto: CreateMessageDto): Promise<TicketMessage> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.assertVisible(tx, ticketId);
      // a RLS decide: cliente só public_reply em chamado seu; nota interna só equipe (senão 42501 → 403)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body, channel)
         VALUES ($1, $2, $3, $4, $5, 'portal') RETURNING id`,
        [user.tenantId, ticketId, user.userId, dto.kind, dto.body],
      );
      const msgs = await this.messages(tx, ticketId, rows[0]!.id);
      return msgs[0]!;
    });
  }

  listTimeEntries(user: TenantUser, ticketId: string): Promise<TimeEntry[]> {
    return this.db.withTenant(tenantCtx(user), async (tx, info) => {
      await this.assertVisible(tx, ticketId);
      if (!isStaff(info.role)) throw new AppException(403, 'forbidden', 'Apontamento de horas é exclusivo da equipe.');
      return this.timeEntries(tx, ticketId);
    });
  }

  addTimeEntry(user: TenantUser, ticketId: string, dto: CreateTimeEntryDto): Promise<TimeEntry> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.assertVisible(tx, ticketId);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO time_entries (tenant_id, ticket_id, user_id, minutes, note, worked_on)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, (now() AT TIME ZONE (SELECT timezone FROM tenants WHERE id = $1))::date))
         RETURNING id`,
        [user.tenantId, ticketId, user.userId, dto.minutes, dto.note ?? null, dto.workedOn ?? null],
      );
      const entries = await this.timeEntries(tx, ticketId, rows[0]!.id);
      return entries[0]!;
    });
  }

  /** Regra de negócio (além da RLS, que libera qualquer agente): só o autor ou um admin apaga. */
  deleteTimeEntry(user: TenantUser, id: string): Promise<void> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const res = await tx.query(
        'DELETE FROM time_entries WHERE id = $1 AND (user_id = app_user_id() OR app_is_admin())',
        [id],
      );
      if (res.rowCount) return;
      const exists = await tx.query('SELECT 1 FROM time_entries WHERE id = $1', [id]);
      if (exists.rowCount) throw new AppException(403, 'forbidden', 'Só quem apontou (ou um admin) pode remover este registro.');
      throw new AppException(404, 'not_found', 'Apontamento não encontrado.');
    });
  }

  // ---------------------------------------------------------------------------

  private async detail(tx: Tx, id: string, role: MemberRole): Promise<TicketDetail> {
    const { rows } = await tx.query<TicketRow & { description: string; custom_fields: Record<string, unknown>; closed_at: Date | null }>(
      `SELECT ${TICKET_COLUMNS}, t.description, t.custom_fields, t.closed_at ${TICKET_FROM} WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw notFound();

    const base: TicketDetail = {
      ...toListItem(row),
      description: row.description,
      customFields: row.custom_fields,
      closedAt: row.closed_at?.toISOString() ?? null,
      messages: await this.messages(tx, id),
      attachments: await this.attachments(tx, id),
    };
    if (!isStaff(role)) return base;

    const ev = await tx.query<{ id: string; event_type: string; data: Record<string, unknown>; actor_id: string | null; actor_name: string | null; created_at: Date }>(
      `SELECT e.id, e.event_type, e.data, u.id AS actor_id, u.name AS actor_name, e.created_at
         FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.ticket_id = $1 ORDER BY e.created_at, e.id`,
      [id],
    );
    const spent = await tx.query<{ total: string }>('SELECT COALESCE(sum(minutes), 0) AS total FROM time_entries WHERE ticket_id = $1', [id]);
    const events: TicketEvent[] = ev.rows.map((e) => ({
      id: Number(e.id),
      type: e.event_type,
      data: e.data,
      actor: e.actor_id ? { id: e.actor_id, name: e.actor_name ?? '' } : null,
      createdAt: e.created_at.toISOString(),
    }));
    return { ...base, events, timeSpentMinutes: Number(spent.rows[0]?.total ?? 0) };
  }

  private async messages(tx: Tx, ticketId: string, onlyId?: string): Promise<TicketMessage[]> {
    const { rows } = await tx.query<{ id: string; kind: TicketMessage['kind']; body: string; channel: TicketMessage['channel']; author_id: string | null; author_name: string | null; created_at: Date }>(
      `SELECT m.id, m.kind, m.body, m.channel, u.id AS author_id, u.name AS author_name, m.created_at
         FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.ticket_id = $1 AND ($2::uuid IS NULL OR m.id = $2)
        ORDER BY m.created_at, m.id`,
      [ticketId, onlyId ?? null],
    );
    return rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      body: m.body,
      channel: m.channel,
      author: m.author_id ? { id: m.author_id, name: m.author_name ?? '' } : null,
      createdAt: m.created_at.toISOString(),
    }));
  }

  private async attachments(tx: Tx, ticketId: string): Promise<TicketAttachment[]> {
    const { rows } = await tx.query<{ id: string; message_id: string | null; filename: string; content_type: string; size_bytes: string; uploaded_by: string; uploader_name: string | null; created_at: Date }>(
      `SELECT a.id, a.message_id, a.filename, a.content_type, a.size_bytes, a.uploaded_by, u.name AS uploader_name, a.created_at
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.ticket_id = $1 ORDER BY a.created_at, a.id`,
      [ticketId],
    );
    return rows.map((a) => ({
      id: a.id,
      messageId: a.message_id,
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: Number(a.size_bytes),
      uploadedBy: a.uploader_name !== null ? { id: a.uploaded_by, name: a.uploader_name } : null,
      createdAt: a.created_at.toISOString(),
    }));
  }

  private async timeEntries(tx: Tx, ticketId: string, onlyId?: string): Promise<TimeEntry[]> {
    const { rows } = await tx.query<{ id: string; ticket_id: string; user_id: string; user_name: string | null; minutes: number; note: string | null; worked_on: string; created_at: Date }>(
      `SELECT te.id, te.ticket_id, te.user_id, u.name AS user_name, te.minutes, te.note, te.worked_on::text AS worked_on, te.created_at
         FROM time_entries te LEFT JOIN users u ON u.id = te.user_id
        WHERE te.ticket_id = $1 AND ($2::uuid IS NULL OR te.id = $2)
        ORDER BY te.worked_on DESC, te.created_at DESC`,
      [ticketId, onlyId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      ticketId: r.ticket_id,
      user: { id: r.user_id, name: r.user_name ?? '' },
      minutes: r.minutes,
      note: r.note,
      workedOn: r.worked_on,
      createdAt: r.created_at.toISOString(),
    }));
  }

  private async assertVisible(tx: Tx, ticketId: string): Promise<void> {
    const res = await tx.query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
    if (!res.rowCount) throw notFound();
  }

  /** UPDATE afetou 0 linhas: 404 se o chamado não é visível, 403 se é visível mas a RLS não deixa alterar. */
  private async explainNoRows(tx: Tx, ticketId: string): Promise<never> {
    await this.assertVisible(tx, ticketId);
    throw new AppException(403, 'forbidden', 'Você não tem permissão para alterar este chamado.');
  }
}
