import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { MemberRole, TenantAuth, UserAuth } from './auth.types.js';

export const IS_PUBLIC = 'auth:public';
export const ALLOW_PRE_TENANT = 'auth:allowPreTenant';
export const ROLES = 'auth:roles';
export const AUTH_RATE_LIMIT = 'auth:rateLimit';

/** Rota sem autenticação. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Aceita também o token curto emitido antes de escolher o workspace. */
export const AllowPreTenant = () => SetMetadata(ALLOW_PRE_TENANT, true);

/**
 * Primeira barreira por papel (o papel vem do banco). A decisão final continua sendo da RLS:
 * isto só evita trabalho inútil e dá uma mensagem melhor.
 */
export const Roles = (...roles: MemberRole[]) => SetMetadata(ROLES, roles);

/** Aplica os limites fortes de tentativas (por IP e por e-mail) de login/cadastro/recuperação. */
export const AuthRateLimit = () => SetMetadata(AUTH_RATE_LIMIT, true);

/** Identidade com workspace. Só use em rotas que NÃO têm @AllowPreTenant. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantAuth => {
  const auth = ctx.switchToHttp().getRequest<Request>().auth;
  if (!auth?.tenantId || !auth.role) throw new UnauthorizedException();
  return { userId: auth.userId, tenantId: auth.tenantId, role: auth.role };
});

/** Identidade que pode ainda não ter workspace (rotas com @AllowPreTenant). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserAuth => {
  const auth = ctx.switchToHttp().getRequest<Request>().auth;
  if (!auth) throw new UnauthorizedException();
  return auth;
});
