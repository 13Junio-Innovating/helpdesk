import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { DbService } from '../db/db.service.js';
import type { MemberRole } from './auth.types.js';

interface CacheEntry {
  role: MemberRole | null;
  expiresAt: number;
}

const MAX_ENTRIES = 10_000;

/**
 * Reconsulta, a cada requisição, se o usuário ainda tem vínculo ativo com o workspace e qual é o
 * papel dele — direto do banco (`app_role()`), nunca do JWT. Cache curto (MEMBERSHIP_CACHE_MS)
 * para que um usuário desativado perca o acesso em segundos.
 */
@Injectable()
export class MembershipService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly db: DbService,
    config: AppConfig,
  ) {
    this.ttlMs = config.get('MEMBERSHIP_CACHE_MS');
  }

  /** Papel ativo do usuário no tenant, ou null se não há vínculo ativo / usuário desativado. */
  async resolveRole(userId: string, tenantId: string): Promise<MemberRole | null> {
    const key = `${tenantId}:${userId}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.role;

    const role = await this.db.withTenant({ tenantId, userId }, async (c) => {
      const { rows } = await c.query<{ role: MemberRole | null; enabled: boolean }>(
        `SELECT app_role() AS role,
                EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND disabled_at IS NULL) AS enabled`,
      );
      const row = rows[0];
      return row?.enabled ? row.role : null;
    });

    if (this.ttlMs > 0) {
      if (this.cache.size >= MAX_ENTRIES) this.prune(now);
      this.cache.set(key, { role, expiresAt: now + this.ttlMs });
    }
    return role;
  }

  /** Chamar após mudar papel/ativo de alguém (vale para esta instância; as outras expiram sozinhas). */
  invalidate(userId: string, tenantId?: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${userId}`) && (!tenantId || key.startsWith(`${tenantId}:`))) this.cache.delete(key);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
  }
}
