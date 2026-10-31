/**
 * Texto útil para `last_error`. Alguns erros de rede chegam com `message` vazia: o Node tenta IPv6 e
 * IPv4 para "localhost" e, se ambos falham, lança um AggregateError sem mensagem (só nos `errors`).
 */
export function errorMessage(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length) {
    return [...new Set(e.errors.map(errorMessage))].join('; ');
  }
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return e.message || (typeof code === 'string' ? code : '') || e.name || 'erro desconhecido';
  }
  return String(e) || 'erro desconhecido';
}
