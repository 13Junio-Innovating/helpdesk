import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../../config/app-config.js';
import type { JwtPayload } from './auth.types.js';

export const JWT_ISSUER = 'helpdesk-api';
export const JWT_AUDIENCE = 'helpdesk-web';

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  signAccess(userId: string, tenantId: string): { token: string; expiresIn: number } {
    const expiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS');
    const payload: JwtPayload = { sub: userId, tid: tenantId, typ: 'access' };
    return { token: this.jwt.sign(payload, { expiresIn }), expiresIn };
  }

  signPreTenant(userId: string): { token: string; expiresIn: number } {
    const expiresIn = this.config.get('JWT_PRE_TENANT_TTL_SECONDS');
    const payload: JwtPayload = { sub: userId, typ: 'pre' };
    return { token: this.jwt.sign(payload, { expiresIn }), expiresIn };
  }

  /** Lança se a assinatura, o emissor, o público ou a validade não baterem. */
  verify(token: string): JwtPayload {
    const p = this.jwt.verify<JwtPayload>(token);
    if (typeof p.sub !== 'string' || (p.typ !== 'access' && p.typ !== 'pre')) {
      throw new Error('payload inválido');
    }
    if (p.typ === 'access' && typeof p.tid !== 'string') throw new Error('token de acesso sem tenant');
    return p;
  }
}
