import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../errors/app-error.js';
import { ALLOW_PRE_TENANT, IS_PUBLIC } from './decorators.js';
import { MembershipService } from './membership.service.js';
import { TokensService } from './tokens.service.js';

const unauthorized = (code = 'unauthorized', message = 'Faça login para continuar.') =>
  new AppError(401, code, message);

/** Guard global: toda rota exige token, exceto as marcadas com @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly memberships: MembershipService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    let payload;
    try {
      payload = this.tokens.verify(header.slice(7).trim());
    } catch {
      throw unauthorized('token_invalid', 'Sessão expirada ou inválida. Entre novamente.');
    }

    const allowPre = this.reflector.getAllAndOverride<boolean>(ALLOW_PRE_TENANT, targets) ?? false;
    if (payload.typ === 'pre') {
      if (!allowPre) throw unauthorized('tenant_required', 'Escolha um workspace para continuar.');
      req.auth = { userId: payload.sub, tenantId: null, role: null };
      return true;
    }

    const tenantId = payload.tid as string;
    const role = await this.memberships.resolveRole(payload.sub, tenantId);
    if (!role) throw unauthorized('session_invalid', 'Seu acesso a este workspace não está mais ativo.');
    req.auth = { userId: payload.sub, tenantId, role };
    return true;
  }
}
