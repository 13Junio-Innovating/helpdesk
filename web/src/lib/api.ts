import type { ApiError as ApiErrorBody, AuthResponse, ErrorCode, ValidationIssue } from '@helpdesk/shared';

/** Erro padronizado da API: `code` estável + mensagem pt-BR pronta para exibir. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** Erros de validação por campo (`validation_failed`). */
  get fieldErrors(): ValidationIssue[] {
    return Array.isArray(this.details) ? (this.details as ValidationIssue[]) : [];
  }
}

// O access token vive SÓ em memória (nunca em localStorage). O refresh fica em cookie httpOnly.
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;

type Listener = (code: ErrorCode) => void;
const listeners = new Set<Listener>();
/** Avisos globais: sessão perdida, conta suspensa. */
export function onApiEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Renova a sessão pelo cookie. "Single flight": várias requisições com 401 ao mesmo tempo
 * compartilham UMA chamada de refresh (a API revoga a sessão se o mesmo refresh for usado 2x).
 */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return null;
      const body = (await res.json()) as AuthResponse;
      accessToken = body.accessToken;
      return body;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** false: não tenta renovar a sessão em 401 (rotas públicas) */
  auth?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: Options = {}, retried = false): Promise<T> {
  const qs = opts.query
    ? new URLSearchParams(
        Object.entries(opts.query).filter((e): e is [string, string | number | boolean] => e[1] !== undefined && e[1] !== null && e[1] !== '').map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken && opts.auth !== false) headers['Authorization'] = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs ? `?${qs}` : ''}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'service_unavailable', 'Sem conexão com o servidor. Verifique sua internet e tente de novo.');
  }

  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (ApiErrorBody & Record<string, unknown>) | null;
  if (res.ok) return body as T;

  const err = new ApiError(res.status, body?.code ?? 'internal_error', body?.message ?? 'Erro inesperado. Tente novamente.', body?.details);
  if (res.status === 401 && opts.auth !== false && !retried && err.code !== 'invalid_credentials') {
    const renewed = await refreshSession();
    if (renewed && !renewed.needsTenantSelection) return api<T>(path, opts, true);
    accessToken = null;
    listeners.forEach((l) => l('session_invalid'));
  }
  if (err.code === 'tenant_inactive') listeners.forEach((l) => l('tenant_inactive'));
  throw err;
}
