import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { TenantInfo, TenantStatus } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Roles, tenantCtx } from '../common/auth/decorators.js';
import { DbService, type Tx } from '../common/db/db.service.js';
import { setClauses } from '../common/db/sql.js';
import { AppException } from '../common/errors/app-exception.js';
import { TimeZoneField } from '../catalog/dto/catalog.dto.js';

export class UpdateTenantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'America/Sao_Paulo' })
  @IsOptional()
  @TimeZoneField()
  timezone?: string;
}

@Injectable()
export class TenantsService {
  constructor(private readonly db: DbService) {}

  get(user: TenantUser): Promise<TenantInfo> {
    return this.db.withTenant(tenantCtx(user), (tx) => this.info(tx));
  }

  update(user: TenantUser, dto: UpdateTenantDto): Promise<TenantInfo> {
    const params: unknown[] = [];
    const sets = setClauses([['name', 'name'], ['timezone', 'timezone']], dto, params);
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos um campo para alterar.');
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      // a policy tenants_update exige admin: para os demais o UPDATE afeta 0 linhas
      const res = await tx.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = app_tenant_id()`, params);
      if (!res.rowCount) throw new AppException(403, 'forbidden', 'Só administradores alteram o workspace.');
      return this.info(tx);
    });
  }

  private async info(tx: Tx): Promise<TenantInfo> {
    const { rows } = await tx.query<{
      id: string; name: string; slug: string; status: TenantStatus; timezone: string; trial_ends_at: Date | null;
      plan_id: string; plan_name: string; price_cents: number; max_agents: number | null; max_tickets_per_month: number | null;
      features: Record<string, boolean>; agents: number; tickets_month: number;
      sub_status: string | null; provider: string | null; current_period_end: Date | null; cancel_at_period_end: boolean | null;
    }>(
      `SELECT t.id, t.name, t.slug, t.status, t.timezone, t.trial_ends_at,
              p.id AS plan_id, p.name AS plan_name, p.price_cents, p.max_agents, p.max_tickets_per_month, p.features,
              (SELECT count(*)::int FROM memberships m WHERE m.role IN ('admin', 'agent') AND m.active) AS agents,
              -- mesma janela do limite do plano (trigger fn_tickets_bi): mês corrente no fuso do workspace
              (SELECT count(*)::int FROM tickets x
                WHERE x.created_at >= date_trunc('month', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone) AS tickets_month,
              s.status AS sub_status, s.provider, s.current_period_end, s.cancel_at_period_end
         FROM tenants t JOIN plans p ON p.id = t.plan_id
         LEFT JOIN subscriptions s ON s.tenant_id = t.id   -- RLS: só admin enxerga
        WHERE t.id = app_tenant_id()`,
    );
    const r = rows[0]!;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      timezone: r.timezone,
      trialEndsAt: r.trial_ends_at?.toISOString() ?? null,
      plan: {
        id: r.plan_id, name: r.plan_name, priceCents: r.price_cents, maxAgents: r.max_agents,
        maxTicketsPerMonth: r.max_tickets_per_month, features: r.features,
      },
      usage: { agents: r.agents, ticketsThisMonth: r.tickets_month },
      subscription: r.sub_status
        ? { status: r.sub_status, provider: r.provider, currentPeriodEnd: r.current_period_end?.toISOString() ?? null, cancelAtPeriodEnd: !!r.cancel_at_period_end }
        : null,
    };
  }
}

@ApiTags('tenant')
@ApiBearerAuth()
@Controller('tenant')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  /** Equipe: plano e uso (o cliente usa /auth/me). */
  @Roles('admin', 'agent') @Get()
  get(@CurrentTenantUser() u: TenantUser): Promise<TenantInfo> { return this.tenants.get(u); }

  @Roles('admin') @Patch()
  update(@CurrentTenantUser() u: TenantUser, @Body() d: UpdateTenantDto): Promise<TenantInfo> { return this.tenants.update(u, d); }
}

@Module({ controllers: [TenantsController], providers: [TenantsService] })
export class TenantsModule {}
