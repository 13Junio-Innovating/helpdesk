import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import type { MemberRole } from '@helpdesk/shared';
import type { Env } from '../config/env.js';
import type { JwtPayload } from '../common/auth/auth-user.js';

/** Tokens opacos (refresh, reset, convite): só o hash vai para o banco. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class TokenService {
  readonly accessTtl: number;
  readonly preTenantTtl: number;
  readonly refreshTtlDays: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.accessTtl = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.preTenantTtl = config.get('JWT_PRE_TENANT_TTL_SECONDS', { infer: true });
    this.refreshTtlDays = config.get('REFRESH_TTL_DAYS', { infer: true });
  }

  signAccess(userId: string, tenantId: string, role: MemberRole): Promise<string> {
    const payload: JwtPayload = { sub: userId, typ: 'access', tid: tenantId, role };
    return this.jwt.signAsync(payload, { expiresIn: this.accessTtl });
  }

  signPreTenant(userId: string): Promise<string> {
    const payload: JwtPayload = { sub: userId, typ: 'pre' };
    return this.jwt.signAsync(payload, { expiresIn: this.preTenantTtl });
  }

  /** Intervalo no formato aceito pelo Postgres (parâmetro `interval`). */
  get refreshInterval(): string {
    return `${this.refreshTtlDays} days`;
  }
}
