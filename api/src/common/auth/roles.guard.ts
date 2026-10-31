import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../errors/app-error.js';
import type { MemberRole } from './auth.types.js';
import { ROLES } from './decorators.js';

/** Primeira barreira por papel. O papel veio do banco (JwtAuthGuard), não do token. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<MemberRole[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const role = ctx.switchToHttp().getRequest<Request>().auth?.role;
    if (role && roles.includes(role)) return true;
    throw new AppError(403, 'forbidden', 'Você não tem permissão para esta ação.');
  }
}
