import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { MemberRole } from '@helpdesk/shared';
import { AppException } from '../errors/app-exception.js';
import type { AuthUser, JwtPayload } from './auth-user.js';
import { ALLOW_PRE_TENANT, IS_PUBLIC, ROLES } from './decorators.js';

const UNAUTHORIZED = () => new AppException(401, 'unauthorized', 'Autenticação necessária.');

/**
 * Guard global: valida o Bearer e o tipo do token, e aplica @Roles como primeira barreira.
 * O membership é revalidado no banco a cada requisição dentro de DbService.withTenant.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw UNAUTHORIZED();

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw UNAUTHORIZED();
    }

    const allowPre = this.reflector.getAllAndOverride<boolean>(ALLOW_PRE_TENANT, targets) ?? false;
    if (payload.typ === 'pre') {
      if (!allowPre) throw new AppException(403, 'forbidden', 'Selecione um workspace para continuar.');
    } else if (payload.typ !== 'access' || !payload.tid || !payload.role) {
      throw UNAUTHORIZED();
    }

    req.user = {
      userId: payload.sub,
      tokenType: payload.typ,
      tenantId: payload.tid ?? null,
      role: payload.role ?? null,
    };

    const roles = this.reflector.getAllAndOverride<MemberRole[] | undefined>(ROLES, targets);
    if (roles && (!req.user.role || !roles.includes(req.user.role))) {
      throw new AppException(403, 'forbidden', 'Você não tem permissão para esta ação.');
    }
    return true;
  }
}
