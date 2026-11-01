import type { Type } from '@nestjs/common';
import type { MemberRole } from '../common/auth/auth.types.js';
import type { ColumnMap } from '../common/db/writes.js';
import * as D from './dto/catalog.dto.js';

export interface ResourceSpec {
  /** Rota (sem barra). */
  path: string;
  table: string;
  /** Nome em pt-BR para mensagens de erro. */
  label: string;
  /** Lista de colunas (já com aliases camelCase). */
  select: string;
  orderBy: string;
  fields: ColumnMap;
  jsonColumns?: ReadonlySet<string>;
  /** Tabela com `is_default` único por tenant. `required`: sempre deve existir um padrão. */
  defaultFlag?: { required: boolean };
  /** Quem pode LER (a escrita é sempre decidida pela RLS: só admin). undefined = todos. */
  readRoles?: MemberRole[];
  feature?: { key: string; label: string };
  createDto: Type;
  updateDto: Type;
}

const STAFF: MemberRole[] = ['admin', 'agent'];

export const QUEUES: ResourceSpec = {
  path: 'queues', table: 'queues', label: 'Fila',
  select: 'id, name, description, created_at AS "createdAt"',
  orderBy: 'name, id',
  fields: { name: 'name', description: 'description' },
  createDto: D.CreateQueueDto, updateDto: D.UpdateQueueDto,
};

export const CATEGORIES: ResourceSpec = {
  path: 'categories', table: 'categories', label: 'Categoria',
  select: 'id, name, parent_id AS "parentId", default_queue_id AS "defaultQueueId", active, created_at AS "createdAt"',
  orderBy: 'name, id',
  fields: { name: 'name', parentId: 'parent_id', defaultQueueId: 'default_queue_id', active: 'active' },
  createDto: D.CreateCategoryDto, updateDto: D.UpdateCategoryDto,
};

export const PRIORITIES: ResourceSpec = {
  path: 'priorities', table: 'priorities', label: 'Prioridade',
  select: 'id, name, level, color, is_default AS "isDefault"',
  orderBy: 'level DESC, name',
  fields: { name: 'name', level: 'level', color: 'color', isDefault: 'is_default' },
  defaultFlag: { required: true },
  createDto: D.CreatePriorityDto, updateDto: D.UpdatePriorityDto,
};

export const STATUSES: ResourceSpec = {
  path: 'statuses', table: 'statuses', label: 'Status',
  select: 'id, name, kind, sla_pauses AS "slaPauses", is_default AS "isDefault", position, color',
  orderBy: 'position, name',
  fields: { name: 'name', kind: 'kind', slaPauses: 'sla_pauses', isDefault: 'is_default', position: 'position', color: 'color' },
  defaultFlag: { required: true },
  createDto: D.CreateStatusDto, updateDto: D.UpdateStatusDto,
};

export const BUSINESS_HOURS: ResourceSpec = {
  path: 'business-hours', table: 'business_hours', label: 'Horário comercial',
  select: 'id, name, timezone',
  orderBy: 'name, id',
  fields: { name: 'name', timezone: 'timezone' },
  readRoles: STAFF,
  createDto: D.CreateBusinessHoursDto, updateDto: D.UpdateBusinessHoursDto,
};

export const SLA_POLICIES: ResourceSpec = {
  path: 'sla-policies', table: 'sla_policies', label: 'Política de SLA',
  select: `id, name, priority_id AS "priorityId", first_response_minutes AS "firstResponseMinutes",
           resolution_minutes AS "resolutionMinutes", business_hours_id AS "businessHoursId",
           is_default AS "isDefault", active`,
  orderBy: 'is_default DESC, name',
  fields: {
    name: 'name', priorityId: 'priority_id', firstResponseMinutes: 'first_response_minutes',
    resolutionMinutes: 'resolution_minutes', businessHoursId: 'business_hours_id', isDefault: 'is_default', active: 'active',
  },
  defaultFlag: { required: false },
  readRoles: STAFF,
  createDto: D.CreateSlaPolicyDto, updateDto: D.UpdateSlaPolicyDto,
};

export const AUTOMATION_RULES: ResourceSpec = {
  path: 'automation-rules', table: 'automation_rules', label: 'Regra de automação',
  select: `id, name, event, conditions, actions, position, active, created_at AS "createdAt", updated_at AS "updatedAt"`,
  orderBy: 'event, position, name',
  fields: { name: 'name', event: 'event', conditions: 'conditions', actions: 'actions', position: 'position', active: 'active' },
  jsonColumns: new Set(['conditions', 'actions']),
  readRoles: STAFF,
  feature: { key: 'automations', label: 'Automações' },
  createDto: D.CreateAutomationRuleDto, updateDto: D.UpdateAutomationRuleDto,
};

export const CATALOG_SPECS = [QUEUES, CATEGORIES, PRIORITIES, STATUSES, BUSINESS_HOURS, SLA_POLICIES, AUTOMATION_RULES];
