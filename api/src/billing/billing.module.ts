import { Body, Controller, Get, Headers, HttpCode, Injectable, Logger, Module, OnModuleDestroy, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import pg from 'pg';
import type { Env } from '../config/env.js';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Public, Roles, tenantCtx } from '../common/auth/decorators.js';
import { DbService } from '../common/db/db.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { AsaasBillingProvider } from './asaas.provider.js';
import { FakeBillingProvider, type FakeOutcome } from './fake.provider.js';
import { WebhookAuthError, type BillingEvent, type BillingProvider } from './provider.js';

export interface PublicPlan {
  id: string;
  name: string;
  priceCents: number;
  maxAgents: number | null;
  maxTicketsPerMonth: number | null;
  features: Record<string, boolean>;
}

class CheckoutDto {
  @ApiProperty() @IsString() @Matches(/^[a-z0-9_-]{1,40}$/) planId: string;
  @ApiPropertyOptional({ description: 'CPF/CNPJ (obrigatório no Asaas)' })
  @IsOptional() @IsString() @Matches(/^[\d./-]{11,18}$/, { message: 'CPF ou CNPJ inválido' }) document?: string;
}

class SimulateDto {
  @ApiProperty() @IsString() @MaxLength(500) session: string;
  @ApiProperty({ enum: ['paid', 'overdue', 'canceled'] }) @IsIn(['paid', 'overdue', 'canceled']) outcome: FakeOutcome;
}

/**
 * Conexão sd_worker (BYPASSRLS) usada SOMENTE pelo webhook de cobrança: ele não tem usuário
 * logado nem tenant em contexto, e precisa gravar billing_events/subscriptions, que a API não acessa.
 * Nenhuma rota autenticada de usuário recebe esta conexão.
 */
@Injectable()
export class BillingDb implements OnModuleDestroy {
  private readonly pool: pg.Pool | null;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('DATABASE_URL_WORKER', { infer: true });
    this.pool = url ? new pg.Pool({ connectionString: url, max: 3, application_name: 'helpdesk-billing-webhook' }) : null;
  }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new AppException(503, 'service_unavailable', 'Webhook de cobrança não configurado.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  readonly provider: BillingProvider;
  readonly fake: FakeBillingProvider;
  private readonly simulateAllowed: boolean;

  constructor(
    private readonly db: DbService,
    private readonly billingDb: BillingDb,
    config: ConfigService<Env, true>,
  ) {
    this.fake = new FakeBillingProvider(config.get('BILLING_FAKE_SECRET', { infer: true }), config.get('APP_URL', { infer: true }));
    this.provider =
      config.get('BILLING_PROVIDER', { infer: true }) === 'asaas'
        ? new AsaasBillingProvider(config.get('ASAAS_API_URL', { infer: true }), config.get('ASAAS_API_KEY', { infer: true }), config.get('ASAAS_WEBHOOK_TOKEN', { infer: true }))
        : this.fake;
    this.simulateAllowed = this.provider === this.fake && config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  plans(): Promise<{ provider: string; requiresDocument: boolean; plans: PublicPlan[] }> {
    return this.db.withoutTenant(async (tx) => {
      const { rows } = await tx.query<PublicPlan>(
        `SELECT id, name, price_cents AS "priceCents", max_agents AS "maxAgents", max_tickets_per_month AS "maxTicketsPerMonth", features
           FROM plans WHERE active ORDER BY price_cents`,
      );
      return { provider: this.provider.name, requiresDocument: this.provider.requiresDocument, plans: rows };
    });
  }

  /** Admin inicia a assinatura. Nada é gravado aqui: só o webhook verificado muda plano/status. */
  async checkout(user: TenantUser, dto: CheckoutDto): Promise<{ url: string }> {
    const info = await this.db.withTenant(tenantCtx(user), async (tx) => {
      const { rows } = await tx.query<{ admin: boolean; tenant_name: string; user_name: string; email: string; plan_name: string | null; price: number | null }>(
        `SELECT app_is_admin() AS admin, t.name AS tenant_name, u.name AS user_name, u.email,
                p.name AS plan_name, p.price_cents AS price
           FROM tenants t CROSS JOIN users u LEFT JOIN plans p ON p.id = $1 AND p.active
          WHERE t.id = app_tenant_id() AND u.id = app_user_id()`,
        [dto.planId],
      );
      return rows[0];
    });
    if (!info?.admin) throw new AppException(403, 'forbidden', 'Só administradores contratam planos.');
    if (!info.plan_name || !info.price) throw new AppException(422, 'invalid_reference', 'Plano inexistente ou indisponível.');
    if (this.provider.requiresDocument && !dto.document) {
      throw new AppException(400, 'validation_failed', 'Informe o CPF ou CNPJ para a cobrança.', [{ field: 'document', message: 'obrigatório' }]);
    }
    try {
      return await this.provider.createCheckout({
        tenantId: user.tenantId, tenantName: info.tenant_name, planId: dto.planId, planName: info.plan_name,
        priceCents: info.price, adminName: info.user_name, adminEmail: info.email, document: dto.document,
      });
    } catch (e) {
      this.logger.error(`checkout ${this.provider.name}: ${e instanceof Error ? e.message : String(e)}`);
      throw new AppException(503, 'service_unavailable', 'Não foi possível iniciar o pagamento agora. Tente novamente em instantes.');
    }
  }

  async webhook(providerName: string, headers: Record<string, string | string[] | undefined>, raw: Buffer | undefined): Promise<{ status: string }> {
    const provider = providerName === this.provider.name ? this.provider : providerName === 'fake' && this.simulateAllowed ? this.fake : null;
    if (!provider) throw new AppException(404, 'not_found', 'Provedor desconhecido.');
    if (!raw?.length) throw new AppException(400, 'bad_request', 'Corpo vazio.');
    let event: BillingEvent;
    try {
      event = await provider.verifyWebhook(headers, raw);
    } catch (e) {
      if (e instanceof WebhookAuthError) throw new AppException(401, 'unauthorized', 'Assinatura do webhook inválida.');
      throw new AppException(400, 'bad_request', 'Webhook inválido.');
    }
    return this.apply(provider.name, event);
  }

  /** Dev: a página de checkout simulado "paga" e o webhook assinado percorre o mesmo caminho do real. */
  async simulate(user: TenantUser, dto: SimulateDto): Promise<{ status: string }> {
    if (!this.simulateAllowed) throw new AppException(404, 'not_found', 'Recurso indisponível.');
    let built: { body: Buffer; signature: string };
    try {
      built = this.fake.buildWebhook(dto.session, dto.outcome);
    } catch {
      throw new AppException(400, 'bad_request', 'Sessão de pagamento inválida.');
    }
    const ref = JSON.parse(built.body.toString()) as { externalReference: string };
    if (!ref.externalReference.startsWith(`${user.tenantId}:`)) throw new AppException(403, 'forbidden', 'Sessão de outro workspace.');
    return this.webhook('fake', { 'x-fake-signature': built.signature }, built.body);
  }

  /**
   * Idempotente: (provider, event_id) é UNIQUE em billing_events; um evento repetido não faz nada.
   * Tudo na mesma transação (registro do evento + assinatura + tenant).
   */
  private apply(provider: string, e: BillingEvent): Promise<{ status: string }> {
    return this.billingDb.tx(async (c) => {
      const tenant = e.tenantId ? (await c.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [e.tenantId])).rows[0] : undefined;
      const ins = await c.query<{ id: string }>(
        `INSERT INTO billing_events (provider, event_id, tenant_id, event_type, payload) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [provider, e.eventId, tenant?.id ?? null, e.rawType, JSON.stringify(e.payload)],
      );
      if (!ins.rows[0]) return { status: 'duplicate' };
      if (!tenant || e.kind === 'ignored') {
        await c.query('UPDATE billing_events SET processed_at = now() WHERE id = $1', [ins.rows[0].id]);
        return { status: 'ignored' };
      }

      if (e.kind === 'paid') {
        const plan = (await c.query<{ id: string }>('SELECT id FROM plans WHERE id = $1', [e.planId])).rows[0];
        if (!plan) throw new AppException(422, 'invalid_reference', 'Plano do evento não existe.');
        await c.query(`UPDATE tenants SET status = 'active', plan_id = $2 WHERE id = $1`, [tenant.id, plan.id]);
        await c.query(
          `INSERT INTO subscriptions (tenant_id, plan_id, status, provider, provider_customer_id, provider_subscription_id, current_period_start, current_period_end)
           VALUES ($1, $2, 'active', $3, $4, $5, now(), now() + interval '1 month')
           ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', provider = EXCLUDED.provider,
             provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
             provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
             current_period_start = now(), current_period_end = now() + interval '1 month', cancel_at_period_end = false`,
          [tenant.id, plan.id, provider, e.customerId ?? null, e.subscriptionId ?? null],
        );
      } else {
        const status = e.kind === 'overdue' ? 'past_due' : 'canceled';
        await c.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, status]);
        await c.query('UPDATE subscriptions SET status = $2 WHERE tenant_id = $1', [tenant.id, status]);
      }
      await c.query('UPDATE billing_events SET processed_at = now() WHERE id = $1', [ins.rows[0].id]);
      this.logger.log(`cobrança ${provider}: ${e.rawType} aplicado ao tenant ${tenant.id}`);
      return { status: 'processed' };
    });
  }
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Público: alimenta a página de preços. */
  @Public() @Get('plans')
  plans() { return this.billing.plans(); }

  @ApiBearerAuth() @Roles('admin') @Post('checkout') @HttpCode(200)
  checkout(@CurrentTenantUser() u: TenantUser, @Body() d: CheckoutDto) { return this.billing.checkout(u, d); }

  /** Chamado pelo provedor: autenticado pela assinatura/token do próprio provedor, não por JWT. */
  @Public() @SkipThrottle() @Post('webhook/:provider') @HttpCode(200)
  webhook(@Param('provider') provider: string, @Headers() headers: Record<string, string>, @Req() req: RawBodyRequest<Request>) {
    return this.billing.webhook(provider, headers, req.rawBody);
  }

  @ApiBearerAuth() @Roles('admin') @Post('fake/simulate') @HttpCode(200)
  simulate(@CurrentTenantUser() u: TenantUser, @Body() d: SimulateDto) { return this.billing.simulate(u, d); }
}

@Module({ controllers: [BillingController], providers: [BillingService, BillingDb] })
export class BillingModule {}
