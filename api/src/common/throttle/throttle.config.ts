import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Env } from '../../config/env.js';
import { SENSITIVE_AUTH } from '../auth/decorators.js';

const isSensitive = (ctx: ExecutionContext): boolean =>
  Reflect.getMetadata(SENSITIVE_AUTH, ctx.getHandler()) === true;

const clientIp = (req: Record<string, unknown>): string => String(req['ip'] ?? 'unknown');

/**
 * Três janelas: geral por IP; e, só nas rotas @SensitiveAuth (login, signup, forgot...),
 * uma por IP e outra pelo e-mail do corpo (barra força bruta distribuída contra uma conta).
 * Armazenamento em memória: em múltiplas instâncias, trocar por storage compartilhado (Redis).
 */
export function throttleOptions(env: Pick<Env, 'THROTTLE_DEFAULT_LIMIT' | 'THROTTLE_AUTH_TTL_SECONDS' | 'THROTTLE_AUTH_IP_LIMIT' | 'THROTTLE_AUTH_EMAIL_LIMIT'>): ThrottlerModuleOptions {
  const authTtl = env.THROTTLE_AUTH_TTL_SECONDS * 1000;
  return {
    throttlers: [
      { name: 'default', ttl: 60_000, limit: env.THROTTLE_DEFAULT_LIMIT, getTracker: clientIp },
      {
        name: 'auth-ip',
        ttl: authTtl,
        limit: env.THROTTLE_AUTH_IP_LIMIT,
        getTracker: clientIp,
        skipIf: (ctx) => !isSensitive(ctx),
      },
      {
        name: 'auth-email',
        ttl: authTtl,
        limit: env.THROTTLE_AUTH_EMAIL_LIMIT,
        getTracker: (req) => {
          const body = req['body'] as { email?: unknown } | undefined;
          const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
          return email ? `email:${email}` : `ip:${clientIp(req)}`;
        },
        skipIf: (ctx) => !isSensitive(ctx),
      },
    ],
  };
}
