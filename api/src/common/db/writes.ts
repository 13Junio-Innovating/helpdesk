import { AppError } from '../errors/app-error.js';
import type { DbClient } from './db.service.js';
import { SqlParams } from './sql-params.js';

/**
 * Tabelas e colunas aqui são SEMPRE constantes do código (nunca entrada do usuário);
 * os valores vão como parâmetros.
 */
export type ColumnMap = Record<string, string>;

/** Converte os campos presentes do DTO em pares coluna/valor (jsonb vira texto JSON). */
export function pickColumns(dto: object, map: ColumnMap, jsonColumns: ReadonlySet<string> = new Set()): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, column] of Object.entries(map)) {
    const value = (dto as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out.push([column, jsonColumns.has(column) && value !== null ? JSON.stringify(value) : value]);
  }
  return out;
}

export async function insertRow(c: DbClient, table: string, cols: [string, unknown][]): Promise<string> {
  const p = new SqlParams();
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ${table} (${cols.map(([k]) => k).join(', ')}) VALUES (${cols.map(([, v]) => p.add(v)).join(', ')}) RETURNING id`,
    p.values,
  );
  return rows[0]!.id;
}

/**
 * UPDATE/DELETE sob RLS: se a policy barrar, o Postgres não dá erro, só afeta 0 linhas.
 * Aqui transformamos isso em 403 (o registro é visível, mas não pode ser alterado) ou 404.
 */
export async function explainNoRows(c: DbClient, table: string, idColumn: string, id: string, label: string): Promise<never> {
  const { rowCount } = await c.query(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1`, [id]);
  if (rowCount) throw new AppError(403, 'forbidden', 'Você não tem permissão para esta ação.');
  throw new AppError(404, 'not_found', `${label} não encontrado(a).`);
}

export async function updateRow(
  c: DbClient, table: string, id: string, cols: [string, unknown][], label: string, idColumn = 'id',
): Promise<void> {
  if (!cols.length) throw new AppError(400, 'nothing_to_update', 'Informe ao menos um campo para alterar.');
  const p = new SqlParams();
  const sets = cols.map(([k, v]) => `${k} = ${p.add(v)}`).join(', ');
  const { rowCount } = await c.query(`UPDATE ${table} SET ${sets} WHERE ${idColumn} = ${p.add(id)}`, p.values);
  if (!rowCount) await explainNoRows(c, table, idColumn, id, label);
}

export async function deleteRow(c: DbClient, table: string, id: string, label: string, idColumn = 'id'): Promise<void> {
  const { rowCount } = await c.query(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id]);
  if (!rowCount) await explainNoRows(c, table, idColumn, id, label);
}

/** Recursos do plano (plans.features), ex.: automações só a partir do Pro. */
export async function assertPlanFeature(c: DbClient, feature: string, label: string): Promise<void> {
  const { rows } = await c.query<{ on: boolean }>(
    `SELECT COALESCE((p.features->>$1)::boolean, false) AS on
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = app_tenant_id()`,
    [feature],
  );
  if (!rows[0]?.on) {
    throw new AppError(402, 'plan_feature_unavailable', `${label} não está disponível no seu plano. Faça upgrade para usar.`);
  }
}
