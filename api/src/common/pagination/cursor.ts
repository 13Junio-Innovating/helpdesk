import { AppException } from '../errors/app-exception.js';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * Cursor opaco de keyset: os valores das colunas de ordenação da última linha, como TEXTO
 * vindo do próprio Postgres (Date do JS perderia os microssegundos e a página repetiria/pularia linhas).
 */
export function encodeCursor(keys: string[]): string {
  return Buffer.from(JSON.stringify(keys)).toString('base64url');
}

export function decodeCursor(cursor: string, expectedKeys: number): string[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === expectedKeys && parsed.every((k) => typeof k === 'string')) {
      return parsed;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new AppException(400, 'bad_request', 'Cursor de paginação inválido.');
}
