import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AppConfig } from '../../config/app-config.js';
import { AUTH_RATE_LIMIT } from '../auth/decorators.js';

const isAuthRoute = (ctx: ExecutionContext): boolean =>
  Reflect.getMetadata(AUTH_RATE_LIMIT, ctx.getHandler()) === true;

const ip = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

/**
 * Três janelas:
 *  - `default`: limite geral por IP em toda a API;
 *  - `auth-ip` e `auth-email`: só nas rotas com @AuthRateLimit (login, cadastro, recuperação),
 *    contadas por IP e pelo e-mail informado — trocar de IP não libera mais tentativas na mesma conta.
 */
export function throttlerOptions(config: AppConfig): ThrottlerModuleOptions {
  const authWindow = config.get('AUTH_RATE_WINDOW_SECONDS') * 1000;
  return {
    throttlers: [
      { name: 'default', ttl: 60_000, limit: config.get('RATE_LIMIT_PER_MIN') },
      {
        name: 'auth-ip',
        ttl: authWindow,
        limit: config.get('AUTH_RATE_LIMIT_IP'),
        skipIf: (ctx) => !isAuthRoute(ctx),
      },
      {
        name: 'auth-email',
        ttl: authWindow,
        limit: config.get('AUTH_RATE_LIMIT_EMAIL'),
        skipIf: (ctx) => !isAuthRoute(ctx),
        getTracker: (req: Record<string, unknown>) => {
          const body = (req as unknown as Request).body as { email?: unknown } | undefined;
          const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
          return Promise.resolve(email ? `email:${email}` : `ip:${ip(req as unknown as Request)}`);
        },
      },
    ],
  };
}
