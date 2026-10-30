import { Injectable } from '@nestjs/common';
import type { TenantUser } from '../common/auth/auth-user.js';
import { tenantCtx } from '../common/auth/decorators.js';
import { DbService, type Tx } from '../common/db/db.service.js';
import { insertParts, setClauses, type ColumnMap } from '../common/db/sql.js';
import { AppException } from '../common/errors/app-exception.js';
import { validateAutomation } from './automation-format.js';
import type { CreateHolidayDto, SetQueueMembersDto, SetSlotsDto } from './dto/catalog.dto.js';

/** Definição de um recurso do catálogo. Tabela/colunas vêm SÓ daqui (nunca da requisição). */
export interface CatalogResource {
  table: string;
  /** artigo + nome para mensagens ("a fila", "o status") */
  label: string;
  columns: ColumnMap;
  /** colunas devolvidas, já em camelCase */
  select: string;
  order: string;
  /** só um registro pode ter is_default (índice único parcial no banco) */
  exclusiveDefault?: boolean;
  /** o banco depende de existir um padrão (status/prioridade iniciais de novos chamados) */
  requiresDefault?: boolean;
  validate?: (dto: Record<string, unknown>) => void;
}

const BH_SELECT = `id, name, timezone,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday', s.weekday, 'startTime', to_char(s.start_time, 'HH24:MI'),
                                                'endTime', to_char(s.end_time, 'HH24:MI')) ORDER BY s.weekday, s.start_time)
              FROM business_hour_slots s WHERE s.business_hours_id = business_hours.id), '[]') AS slots,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('date', h.holiday_date, 'name', h.name) ORDER BY h.holiday_date)
              FROM business_holidays h WHERE h.business_hours_id = business_hours.id), '[]') AS holidays`;

export const RESOURCES = {
  queues: {
    table: 'queues',
    label: 'a fila',
    columns: [['name', 'name'], ['description', 'description']],
    select: 'id, name, description, created_at AS "createdAt"',
    order: 'name',
  },
  categories: {
    table: 'categories',
    label: 'a categoria',
    columns: [['name', 'name'], ['parentId', 'parent_id'], ['defaultQueueId', 'default_queue_id'], ['active', 'active']],
    select: 'id, name, parent_id AS "parentId", default_queue_id AS "defaultQueueId", active',
    order: 'name',
  },
  priorities: {
    table: 'priorities',
    label: 'a prioridade',
    columns: [['name', 'name'], ['level', 'level'], ['color', 'color'], ['isDefault', 'is_default']],
    select: 'id, name, level, color, is_default AS "isDefault"',
    order: 'level, name',
    exclusiveDefault: true,
    requiresDefault: true,
  },
  statuses: {
    table: 'statuses',
    label: 'o status',
    columns: [['name', 'name'], ['kind', 'kind'], ['slaPauses', 'sla_pauses'], ['isDefault', 'is_default'], ['position', 'position'], ['color', 'color']],
    select: 'id, name, kind, sla_pauses AS "slaPauses", is_default AS "isDefault", position, color',
    order: 'position, name',
    exclusiveDefault: true,
    requiresDefault: true,
  },
  businessHours: {
    table: 'business_hours',
    label: 'o horário comercial',
    columns: [['name', 'name'], ['timezone', 'timezone']],
    select: BH_SELECT,
    order: 'name',
  },
  slaPolicies: {
    table: 'sla_policies',
    label: 'a política de SLA',
    columns: [
      ['name', 'name'], ['priorityId', 'priority_id'], ['firstResponseMinutes', 'first_response_minutes'],
      ['resolutionMinutes', 'resolution_minutes'], ['businessHoursId', 'business_hours_id'], ['isDefault', 'is_default'], ['active', 'active'],
    ],
    select: `id, name, priority_id AS "priorityId", first_response_minutes AS "firstResponseMinutes",
             resolution_minutes AS "resolutionMinutes", business_hours_id AS "businessHoursId", is_default AS "isDefault", active`,
    order: 'is_default DESC, name',
    exclusiveDefault: true,
  },
  automationRules: {
    table: 'automation_rules',
    label: 'a regra de automação',
    columns: [['name', 'name'], ['event', 'event'], ['conditions', 'conditions'], ['actions', 'actions'], ['position', 'position'], ['active', 'active']],
    select: 'id, name, event, conditions, actions, position, active, created_at AS "createdAt", updated_at AS "updatedAt"',
    order: 'event, position, name',
    validate: (dto) => validateAutomation(dto as { conditions?: unknown[]; actions?: unknown[] }),
  },
  macros: {
    table: 'macros',
    label: 'a resposta pronta',
    columns: [['title', 'title'], ['body', 'body']],
    select: 'id, title, body, updated_at AS "updatedAt"',
    order: 'title',
  },
} satisfies Record<string, CatalogResource>;

export type ResourceName = keyof typeof RESOURCES;

/** jsonb precisa ir como texto JSON para o driver (arrays JS virariam array do Postgres). */
const JSONB_COLUMNS = new Set(['conditions', 'actions']);
function prepare(dto: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(dto).map(([k, v]) => [k, JSONB_COLUMNS.has(k) && v !== undefined ? JSON.stringify(v) : v]));
}

/**
 * CRUD genérico do catálogo. A autorização real é a RLS de 008 (equipe lê, admin escreve);
 * o @Roles('admin') do controller é só a primeira barreira.
 */
@Injectable()
export class CatalogAdminService {
  constructor(private readonly db: DbService) {}

  list(user: TenantUser, name: ResourceName): Promise<Record<string, unknown>[]> {
    const r: CatalogResource = RESOURCES[name];
    return this.db.withTenant(tenantCtx(user), async (tx) => (await tx.query(`SELECT ${r.select} FROM ${r.table} ORDER BY ${r.order}`)).rows);
  }

  get(user: TenantUser, name: ResourceName, id: string): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantCtx(user), (tx) => this.fetch(tx, RESOURCES[name], id));
  }

  create(user: TenantUser, name: ResourceName, dto: object): Promise<Record<string, unknown>> {
    const r: CatalogResource = RESOURCES[name];
    r.validate?.(dto as Record<string, unknown>);
    const data = prepare(dto);
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      if (r.exclusiveDefault && data['isDefault'] === true) {
        await tx.query(`UPDATE ${r.table} SET is_default = false WHERE is_default`);
      }
      const params: unknown[] = [user.tenantId];
      const { cols, vals } = insertParts(r.columns, data, params);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ${r.table} (tenant_id, ${cols.join(', ')}) VALUES ($1, ${vals.join(', ')}) RETURNING id`,
        params,
      );
      return this.fetch(tx, r, rows[0]!.id);
    });
  }

  update(user: TenantUser, name: ResourceName, id: string, dto: object): Promise<Record<string, unknown>> {
    const r: CatalogResource = RESOURCES[name];
    r.validate?.(dto as Record<string, unknown>);
    const data = prepare(dto);
    const params: unknown[] = [id];
    const sets = setClauses(r.columns, data, params);
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos um campo para alterar.');

    return this.db.withTenant(tenantCtx(user), async (tx) => {
      if (r.requiresDefault && data['isDefault'] === false) {
        const cur = await tx.query('SELECT 1 FROM ' + r.table + ' WHERE id = $1 AND is_default', [id]);
        if (cur.rowCount) throw this.needsDefault(r);
      }
      if (r.exclusiveDefault && data['isDefault'] === true) {
        await tx.query(`UPDATE ${r.table} SET is_default = false WHERE is_default AND id <> $1`, [id]);
      }
      const res = await tx.query(`UPDATE ${r.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
      if (!res.rowCount) await this.explainNoRows(tx, r, id);
      return this.fetch(tx, r, id);
    });
  }

  remove(user: TenantUser, name: ResourceName, id: string): Promise<void> {
    const r: CatalogResource = RESOURCES[name];
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      if (r.requiresDefault) {
        const cur = await tx.query('SELECT 1 FROM ' + r.table + ' WHERE id = $1 AND is_default', [id]);
        if (cur.rowCount) throw this.needsDefault(r);
      }
      const res = await tx.query(`DELETE FROM ${r.table} WHERE id = $1`, [id]);
      if (!res.rowCount) await this.explainNoRows(tx, r, id);
    });
  }

  // ---------- membros de fila ----------

  queueMembers(user: TenantUser, queueId: string): Promise<Array<{ userId: string; name: string; email: string }>> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.fetch(tx, RESOURCES.queues, queueId);
      const { rows } = await tx.query<{ userId: string; name: string; email: string }>(
        `SELECT u.id AS "userId", u.name, u.email FROM queue_members qm JOIN users u ON u.id = qm.user_id
          WHERE qm.queue_id = $1 ORDER BY u.name`,
        [queueId],
      );
      return rows;
    });
  }

  setQueueMembers(user: TenantUser, queueId: string, dto: SetQueueMembersDto): Promise<Array<{ userId: string; name: string; email: string }>> {
    const userIds = [...new Set(dto.userIds)];
    return this.db
      .withTenant(tenantCtx(user), async (tx) => {
        await this.fetch(tx, RESOURCES.queues, queueId);
        const staff = await tx.query(
          `SELECT 1 FROM memberships WHERE user_id = ANY($1::uuid[]) AND role IN ('admin', 'agent') AND active`,
          [userIds],
        );
        if (staff.rowCount !== userIds.length) {
          throw new AppException(422, 'invalid_reference', 'Só membros ativos da equipe podem participar de filas.');
        }
        await tx.query('DELETE FROM queue_members WHERE queue_id = $1', [queueId]);
        if (userIds.length) {
          await tx.query(
            `INSERT INTO queue_members (tenant_id, queue_id, user_id) SELECT $1, $2, unnest($3::uuid[])`,
            [user.tenantId, queueId, userIds],
          );
        }
      })
      .then(() => this.queueMembers(user, queueId));
  }

  // ---------- horário comercial: faixas e feriados ----------

  setSlots(user: TenantUser, bhId: string, dto: SetSlotsDto): Promise<Record<string, unknown>> {
    const slots = [...dto.slots].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    slots.forEach((s, i) => {
      if (s.endTime <= s.startTime) {
        throw new AppException(400, 'validation_failed', 'Verifique as faixas de horário.', [{ field: `slots.${i}`, message: 'o fim deve ser depois do início' }]);
      }
      const prev = slots[i - 1];
      if (prev && prev.weekday === s.weekday && s.startTime < prev.endTime) {
        throw new AppException(400, 'validation_failed', 'Verifique as faixas de horário.', [{ field: `slots.${i}`, message: 'faixas sobrepostas no mesmo dia' }]);
      }
    });
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.fetch(tx, RESOURCES.businessHours, bhId);
      await tx.query('DELETE FROM business_hour_slots WHERE business_hours_id = $1', [bhId]);
      for (const s of slots) {
        await tx.query(
          `INSERT INTO business_hour_slots (tenant_id, business_hours_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4, $5)`,
          [user.tenantId, bhId, s.weekday, s.startTime, s.endTime],
        );
      }
      return this.fetch(tx, RESOURCES.businessHours, bhId);
    });
  }

  addHoliday(user: TenantUser, bhId: string, dto: CreateHolidayDto): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.fetch(tx, RESOURCES.businessHours, bhId);
      await tx.query(
        `INSERT INTO business_holidays (tenant_id, business_hours_id, holiday_date, name) VALUES ($1, $2, $3, $4)`,
        [user.tenantId, bhId, dto.date, dto.name ?? null],
      );
      return this.fetch(tx, RESOURCES.businessHours, bhId);
    });
  }

  removeHoliday(user: TenantUser, bhId: string, date: string): Promise<void> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.fetch(tx, RESOURCES.businessHours, bhId);
      const res = await tx.query('DELETE FROM business_holidays WHERE business_hours_id = $1 AND holiday_date = $2', [bhId, date]);
      if (!res.rowCount) throw new AppException(404, 'not_found', 'Feriado não encontrado.');
    });
  }

  // ---------------------------------------------------------------------------

  private async fetch(tx: Tx, r: CatalogResource, id: string): Promise<Record<string, unknown>> {
    const { rows } = await tx.query(`SELECT ${r.select} FROM ${r.table} WHERE id = $1`, [id]);
    if (!rows[0]) throw new AppException(404, 'not_found', `Não encontramos ${r.label}.`);
    return rows[0];
  }

  /** 0 linhas afetadas: 404 se nem é visível; 403 se é visível mas a RLS não deixa escrever. */
  private async explainNoRows(tx: Tx, r: CatalogResource, id: string): Promise<never> {
    await this.fetch(tx, r, id);
    throw new AppException(403, 'forbidden', 'Você não tem permissão para esta ação.');
  }

  private needsDefault(r: CatalogResource): AppException {
    return new AppException(409, 'conflict', `Defina outr${r.label.startsWith('a ') ? 'a' : 'o'} como padrão antes de remover ou desmarcar ${r.label} padrão.`);
  }
}
