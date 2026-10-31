import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { deleteRow, insertRow, pickColumns, updateRow } from '../common/db/writes.js';
import { AppError } from '../common/errors/app-error.js';
import { ListTicketsQuery } from '../tickets/dto/ticket.dto.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { CreateMacroDto, CreateSavedViewDto, UpdateMacroDto, UpdateSavedViewDto } from './macros.dto.js';
import { renderMacro, type MacroContext } from './render.js';

const OWNER = `json_build_object('id', u.id, 'name', u.name) AS owner`;
const MACRO_SELECT = `SELECT x.id, x.name, x.body, x.shared, x.created_at AS "createdAt", x.updated_at AS "updatedAt", ${OWNER}
                        FROM macros x JOIN users u ON u.id = x.owner_id`;
const VIEW_SELECT = `SELECT x.id, x.name, x.filters, x.shared, x.position, false AS builtin, ${OWNER}
                       FROM saved_views x JOIN users u ON u.id = x.owner_id`;

/** Visões prontas, sempre disponíveis para a equipe (não ficam no banco). */
export const BUILTIN_VIEWS = [
  { id: 'builtin:my-open', name: 'Meus abertos', filters: { assignee: 'me', status: 'unresolved' } },
  { id: 'builtin:unassigned', name: 'Sem responsável', filters: { assignee: 'none', status: 'unresolved' } },
  { id: 'builtin:sla-breached', name: 'SLA vencido', filters: { sla: 'breached' } },
  { id: 'builtin:waiting-customer', name: 'Aguardando cliente', filters: { status: 'pending' } },
].map((v, i) => ({ ...v, shared: true, position: i, builtin: true, owner: null }));

/**
 * Macros e visões salvas. RLS (011): só equipe; cada um vê os seus + compartilhados (admin vê todos);
 * escreve só o dono ou admin.
 */
@Injectable()
export class MacrosService {
  constructor(private readonly db: DbService) {}

  // ---------- macros ----------
  listMacros(auth: TenantAuth) {
    return this.db.withTenant(auth, async (c) => (await c.query(`${MACRO_SELECT} ORDER BY lower(x.name), x.id`)).rows);
  }

  createMacro(auth: TenantAuth, dto: CreateMacroDto) {
    return this.db.withTenant(auth, async (c) => {
      const id = await insertRow(c, 'macros', [['tenant_id', auth.tenantId], ['owner_id', auth.userId],
        ...pickColumns(dto, { name: 'name', body: 'body', shared: 'shared' })]);
      return this.one(c, MACRO_SELECT, id, 'Macro');
    });
  }

  updateMacro(auth: TenantAuth, id: string, dto: UpdateMacroDto) {
    return this.db.withTenant(auth, async (c) => {
      await updateRow(c, 'macros', id, pickColumns(dto, { name: 'name', body: 'body', shared: 'shared' }), 'Macro');
      return this.one(c, MACRO_SELECT, id, 'Macro');
    });
  }

  removeMacro(auth: TenantAuth, id: string): Promise<void> {
    return this.db.withTenant(auth, (c) => deleteRow(c, 'macros', id, 'Macro'));
  }

  /** Aplica a macro a um chamado, substituindo as variáveis no servidor. */
  renderMacro(auth: TenantAuth, id: string, ticketId: string) {
    return this.db.withTenant(auth, async (c) => {
      const macro = await this.one<{ body: string }>(c, MACRO_SELECT, id, 'Macro');
      const { rows } = await c.query<MacroContext>(
        `SELECT json_build_object('nome', ru.name, 'primeiro_nome', split_part(ru.name, ' ', 1), 'email', ru.email) AS solicitante,
                json_build_object('nome', me.name, 'primeiro_nome', split_part(me.name, ' ', 1)) AS agente,
                json_build_object('numero', t.number::text, 'assunto', t.subject, 'status', s.name, 'prioridade', p.name) AS chamado,
                json_build_object('nome', COALESCE(o.name, '')) AS organizacao,
                json_build_object('nome', tn.name) AS empresa
           FROM tickets t
           JOIN statuses s ON s.id = t.status_id
           JOIN priorities p ON p.id = t.priority_id
           JOIN tenants tn ON tn.id = t.tenant_id
           LEFT JOIN users ru ON ru.id = t.requester_id
           LEFT JOIN users me ON me.id = app_user_id()
           LEFT JOIN organizations o ON o.id = t.organization_id
          WHERE t.id = $1`,
        [ticketId],
      );
      if (!rows[0]) throw new AppError(404, 'not_found', 'Chamado não encontrado.');
      return { body: renderMacro(macro.body, rows[0]) };
    });
  }

  // ---------- visões salvas ----------
  listViews(auth: TenantAuth) {
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query(`${VIEW_SELECT} ORDER BY x.position, lower(x.name), x.id`);
      return [...BUILTIN_VIEWS, ...rows];
    });
  }

  async createView(auth: TenantAuth, dto: CreateSavedViewDto) {
    await assertTicketFilters(dto.filters);
    return this.db.withTenant(auth, async (c) => {
      const id = await insertRow(c, 'saved_views', [['tenant_id', auth.tenantId], ['owner_id', auth.userId],
        ...pickColumns(dto, VIEW_FIELDS, JSON_COLS)]);
      return this.one(c, VIEW_SELECT, id, 'Visão');
    });
  }

  async updateView(auth: TenantAuth, id: string, dto: UpdateSavedViewDto) {
    if (dto.filters) await assertTicketFilters(dto.filters);
    return this.db.withTenant(auth, async (c) => {
      await updateRow(c, 'saved_views', id, pickColumns(dto, VIEW_FIELDS, JSON_COLS), 'Visão');
      return this.one(c, VIEW_SELECT, id, 'Visão');
    });
  }

  removeView(auth: TenantAuth, id: string): Promise<void> {
    return this.db.withTenant(auth, (c) => deleteRow(c, 'saved_views', id, 'Visão'));
  }

  private async one<T = Record<string, unknown>>(c: DbClient, select: string, id: string, label: string): Promise<T> {
    const { rows } = await c.query(`${select} WHERE x.id = $1`, [id]);
    if (!rows[0]) throw new AppError(404, 'not_found', `${label} não encontrada.`);
    return rows[0] as T;
  }
}

const VIEW_FIELDS = { name: 'name', filters: 'filters', shared: 'shared', position: 'position' };
const JSON_COLS = new Set(['filters']);

/** Filtros salvos precisam ser exatamente o que GET /tickets aceita (mesmo DTO, mesmas regras). */
async function assertTicketFilters(filters: Record<string, unknown>): Promise<void> {
  if ('cursor' in filters || 'limit' in filters) {
    throw new AppError(400, 'validation_failed', 'Visões salvas não guardam paginação (cursor/limit).');
  }
  const asStrings = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
  const errors = await validate(plainToInstance(ListTicketsQuery, asStrings), { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) {
    throw new AppError(400, 'validation_failed', 'Filtros inválidos.',
      errors.flatMap((e) => Object.values(e.constraints ?? { [e.property]: `${e.property} inválido` })));
  }
}
