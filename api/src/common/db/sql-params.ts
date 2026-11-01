/** Acumula parâmetros posicionais ($1, $2...). Entrada do usuário NUNCA é concatenada no SQL. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Escapa curingas do LIKE/ILIKE (escape padrão: barra invertida). */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
