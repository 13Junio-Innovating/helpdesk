/** Par [campo do DTO, coluna SQL]. Só colunas de listas fixas entram no SQL; valores sempre como parâmetro. */
export type ColumnMap = ReadonlyArray<readonly [string, string]>;

/**
 * Gera `coluna = $n` para os campos presentes (`undefined` = não mexe; `null` = grava NULL).
 * Empilha os valores em `params` (que pode já ter parâmetros anteriores).
 */
export function setClauses(map: ColumnMap, dto: object, params: unknown[]): string[] {
  const sets: string[] = [];
  for (const [field, column] of map) {
    const value = (dto as Record<string, unknown>)[field];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  return sets;
}

/** Colunas e placeholders de INSERT para os campos presentes. */
export function insertParts(map: ColumnMap, dto: object, params: unknown[]): { cols: string[]; vals: string[] } {
  const cols: string[] = [];
  const vals: string[] = [];
  for (const [field, column] of map) {
    const value = (dto as Record<string, unknown>)[field];
    if (value === undefined) continue;
    params.push(value);
    cols.push(column);
    vals.push(`$${params.length}`);
  }
  return { cols, vals };
}
