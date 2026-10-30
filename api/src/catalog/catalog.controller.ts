import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, tenantCtx } from '../common/auth/decorators.js';
import { DbService } from '../common/db/db.service.js';
import { AppException } from '../common/errors/app-exception.js';

/**
 * Leitura do catálogo, liberada a todos os papéis (a RLS de 008 permite SELECT a qualquer membro).
 * O CRUD de administração entra na fase 3.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly db: DbService) {}

  @Get('statuses')
  statuses(@CurrentTenantUser() user: TenantUser) {
    return this.list(user, 'SELECT id, name, kind, sla_pauses, is_default, position, color FROM statuses ORDER BY position, name');
  }

  @Get('priorities')
  priorities(@CurrentTenantUser() user: TenantUser) {
    return this.list(user, 'SELECT id, name, level, color, is_default FROM priorities ORDER BY level');
  }

  @Get('categories')
  categories(@CurrentTenantUser() user: TenantUser) {
    return this.list(user, 'SELECT id, parent_id, name, default_queue_id, active FROM categories ORDER BY name');
  }

  @Get('categories/:id')
  async category(@CurrentTenantUser() user: TenantUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const rows = await this.list(user, 'SELECT id, parent_id, name, default_queue_id, active FROM categories WHERE id = $1', [id]);
    if (!rows[0]) throw new AppException(404, 'not_found', 'Categoria não encontrada.');
    return rows[0];
  }

  @Get('queues')
  queues(@CurrentTenantUser() user: TenantUser) {
    return this.list(user, 'SELECT id, name, description FROM queues ORDER BY name');
  }

  private list(user: TenantUser, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.db.withTenant(tenantCtx(user), async (tx) => (await tx.query(sql, params)).rows);
  }
}
