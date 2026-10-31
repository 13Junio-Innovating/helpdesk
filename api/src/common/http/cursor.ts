import { AppError } from '../errors/app-error.js';

/**
 * Cursor opaco de paginação por chave (keyset). Guarda os valores da ordenação como TEXTO vindo
 * do Postgres (timestamps com microssegundos), para não perder precisão no JavaScript.
 */
export function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, size: number): string[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === size && parsed.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return parsed.map(String);
    }
  } catch {
    /* cai no erro abaixo */
  }
  throw new AppError(400, 'invalid_cursor', 'Cursor de paginação inválido.');
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
