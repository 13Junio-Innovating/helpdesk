import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { assertPlanFeature, deleteRow, insertRow, pickColumns, updateRow } from '../common/db/writes.js';
import { AppError } from '../common/errors/app-error.js';
import { validateRule } from './automation-rules.js';
import { AUTOMATION_RULES, type ResourceSpec } from './catalog.specs.js';

type Dto = Record<string, unknown>;

/**
 * CRUD do catálogo guiado por ResourceSpec. Quem pode escrever é decidido pela RLS (só admin):
 * INSERT barrado => 42501 => 403; UPDATE/DELETE barrado => 0 linhas => 403 (ver writes.ts).
 */
@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService) {}

  list(auth: TenantAuth, spec: ResourceSpec) {
    return this.db.withTenant(auth, async (c) =>
      (await c.query(`SELECT ${spec.select} FROM ${spec.table} ORDER BY ${spec.orderBy}`)).rows);
  }

  get(auth: TenantAuth, spec: ResourceSpec, id: string) {
    return this.db.withTenant(auth, (c) => this.findOne(c, spec, id));
  }

  create(auth: TenantAuth, spec: ResourceSpec, dto: Dto) {
    return this.db.withTenant(auth, async (c) => {
      if (spec.feature) await assertPlanFeature(c, spec.feature.key, spec.feature.label);
      await this.prepare(c, spec, dto);
      if (spec.defaultFlag && dto.isDefault === true) await this.clearDefault(c, spec, null);
      const id = await insertRow(c, spec.table, [['tenant_id', auth.tenantId], ...pickColumns(dto, spec.fields, spec.jsonColumns)]);
      return this.findOne(c, spec, id);
    });
  }

  update(auth: TenantAuth, spec: ResourceSpec, id: string, dto: Dto) {
    return this.db.withTenant(auth, async (c) => {
      if (spec.feature) await assertPlanFeature(c, spec.feature.key, spec.feature.label);
      await this.prepare(c, spec, dto);
      if (spec.defaultFlag?.required && dto.isDefault === false && (await this.isDefault(c, spec, id))) {
        throw defaultRequired(spec);
      }
      if (spec.defaultFlag && dto.isDefault === true) await this.clearDefault(c, spec, id);
      await updateRow(c, spec.table, id, pickColumns(dto, spec.fields, spec.jsonColumns), spec.label);
      return this.findOne(c, spec, id);
    });
  }

  remove(auth: TenantAuth, spec: ResourceSpec, id: string): Promise<void> {
    return this.db.withTenant(auth, async (c) => {
      if (spec.defaultFlag?.required && (await this.isDefault(c, spec, id))) throw defaultRequired(spec);
      await deleteRow(c, spec.table, id, spec.label);
    });
  }

  private async findOne(c: DbClient, spec: ResourceSpec, id: string) {
    const { rows } = await c.query(`SELECT ${spec.select} FROM ${spec.table} WHERE id = $1`, [id]);
    if (!rows[0]) throw new AppError(404, 'not_found', `${spec.label} não encontrado(a).`);
    return rows[0];
  }

  /** Validações que dependem do banco (formato das automações e referências delas). */
  private async prepare(c: DbClient, spec: ResourceSpec, dto: Dto): Promise<void> {
    if (spec === AUTOMATION_RULES) {
      const v = await validateRule(c, dto.conditions as unknown[] | undefined, dto.actions as unknown[] | undefined);
      if (v.conditions) dto.conditions = v.conditions;
      if (v.actions) dto.actions = v.actions;
    }
  }

  private async isDefault(c: DbClient, spec: ResourceSpec, id: string): Promise<boolean> {
    const { rows } = await c.query<{ is_default: boolean }>(`SELECT is_default FROM ${spec.table} WHERE id = $1`, [id]);
    return rows[0]?.is_default === true;
  }

  /** O índice único parcial exige tirar o padrão anterior ANTES de marcar o novo. */
  private async clearDefault(c: DbClient, spec: ResourceSpec, exceptId: string | null): Promise<void> {
    await c.query(`UPDATE ${spec.table} SET is_default = false WHERE is_default AND id IS DISTINCT FROM $1`, [exceptId]);
  }
}

const defaultRequired = (spec: ResourceSpec) =>
  new AppError(422, 'default_required', `Defina outro(a) ${spec.label.toLowerCase()} como padrão antes.`);
