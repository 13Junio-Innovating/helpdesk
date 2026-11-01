import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { pickColumns, updateRow } from '../common/db/writes.js';
import { IsTimeZone, Trim } from '../common/http/validators.js';

export class UpdateTenantDto {
  @IsOptional() @Trim() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsTimeZone() timezone?: string;
}

@Injectable()
export class TenantsService {
  constructor(private readonly db: DbService) {}

  get(auth: TenantAuth) {
    return this.db.withTenant(auth, (c) => this.load(c, auth));
  }

  update(auth: TenantAuth, dto: UpdateTenantDto) {
    return this.db.withTenant(auth, async (c) => {
      // RLS + GRANT UPDATE (name, timezone): só admin, só essas colunas
      await updateRow(c, 'tenants', auth.tenantId, pickColumns(dto, { name: 'name', timezone: 'timezone' }), 'Workspace');
      return this.load(c, auth);
    });
  }

  /** Plano, uso do mês (no fuso do workspace, como o trigger de cota) e trial. Assinatura só para admin. */
  private async load(c: DbClient, auth: TenantAuth) {
    const { rows } = await c.query<{
      tenant: { id: string; name: string; slug: string; status: string; timezone: string; trialEndsAt: string | null; createdAt: string };
      plan: { id: string; name: string; priceCents: number; maxAgents: number | null; maxTicketsPerMonth: number | null; features: Record<string, boolean> };
      agents: number;
      tickets_month: number;
    }>(
      `SELECT json_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status, 'timezone', t.timezone,
                                'trialEndsAt', t.trial_ends_at, 'createdAt', t.created_at) AS tenant,
              json_build_object('id', p.id, 'name', p.name, 'priceCents', p.price_cents, 'maxAgents', p.max_agents,
                                'maxTicketsPerMonth', p.max_tickets_per_month, 'features', p.features) AS plan,
              (SELECT count(*)::int FROM memberships m WHERE m.role IN ('admin', 'agent') AND m.active) AS agents,
              (SELECT count(*)::int FROM tickets k
                WHERE k.created_at >= date_trunc('month', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone) AS tickets_month
         FROM tenants t JOIN plans p ON p.id = t.plan_id
        WHERE t.id = app_tenant_id()`,
    );
    const r = rows[0]!;
    const subscription = auth.role === 'admin'
      ? (await c.query(
          `SELECT plan_id AS "planId", status, provider, current_period_end AS "currentPeriodEnd",
                  cancel_at_period_end AS "cancelAtPeriodEnd" FROM subscriptions`)).rows[0] ?? null
      : undefined;
    const trialEnds = r.tenant.trialEndsAt ? new Date(r.tenant.trialEndsAt) : null;
    const trialActive = r.tenant.status === 'trial' && !!trialEnds && trialEnds > new Date();
    return {
      tenant: r.tenant,
      plan: r.plan,
      usage: {
        agents: { used: r.agents, limit: r.plan.maxAgents },
        ticketsThisMonth: { used: r.tickets_month, limit: r.plan.maxTicketsPerMonth },
      },
      trial: {
        active: trialActive,
        endsAt: trialEnds?.toISOString() ?? null,
        daysLeft: trialActive && trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / 86_400_000) : 0,
      },
      ...(subscription === undefined ? {} : { subscription }),
    };
  }
}

@ApiTags('tenant')
@ApiBearerAuth()
@Controller('tenant')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Roles('admin', 'agent')
  @Get()
  get(@CurrentAuth() auth: TenantAuth) {
    return this.tenants.get(auth);
  }

  @Patch()
  update(@CurrentAuth() auth: TenantAuth, @Body() dto: UpdateTenantDto) {
    return this.tenants.update(auth, dto);
  }
}

@Module({ controllers: [TenantsController], providers: [TenantsService] })
export class TenantsModule {}
