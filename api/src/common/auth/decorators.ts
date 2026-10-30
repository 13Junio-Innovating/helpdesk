import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { MemberRole } from '@helpdesk/shared';
import type { AuthUser, TenantUser } from './auth-user.js';
import type { TenantContext } from '../db/db.service.js';

export const IS_PUBLIC = 'isPublic';
/** Rota sem autenticação. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PRE_TENANT = 'allowPreTenant';
/** Aceita também o token "pré-tenant" emitido no login antes da escolha do workspace. */
export const AllowPreTenant = () => SetMetadata(ALLOW_PRE_TENANT, true);

export const ROLES = 'roles';
/** Primeira barreira por papel (a autorização real é da RLS). */
export const Roles = (...roles: MemberRole[]) => SetMetadata(ROLES, roles);

export const SENSITIVE_AUTH = 'sensitiveAuth';
/** Liga o rate limit forte (por IP e por e-mail do corpo). */
export const SensitiveAuth = () => SetMetadata(SENSITIVE_AUTH, true);

type AuthedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

/** Contexto para `db.withTenant(...)`. O guard garante que a rota tem tenant. */
export function tenantCtx(user: TenantUser): TenantContext {
  return { tenantId: user.tenantId, userId: user.userId };
}

/** Usuário de rota com tenant (o guard já rejeita o token pré-tenant nessas rotas). */
export const CurrentTenantUser = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user?.tenantId || !user.role) {
    throw new Error('CurrentTenantUser usado em rota sem tenant');
  }
  return user as TenantUser;
});
