import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import request from 'supertest';

// esta suíte sobe a API configurada para o Asaas (sem credenciais de API: só o webhook)
process.env['BILLING_PROVIDER'] = 'asaas';
process.env['ASAAS_WEBHOOK_TOKEN'] = 'token-de-teste-do-webhook-asaas';
delete process.env['ASAAS_API_KEY'];
const { auth, cleanup, createApp, E2E_DOMAIN, superDb } = await import('./helpers.js');

describe('Cobrança Asaas: webhook (e2e)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  let tenantId: string;
  let admin: string;
  const http = () => request(app.getHttpServer());
  const send = (body: unknown, token = 'token-de-teste-do-webhook-asaas') =>
    http().post('/api/v1/billing/webhook/asaas').set('Content-Type', 'application/json').set('asaas-access-token', token).send(JSON.stringify(body));

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();
    const r = await http().post('/api/v1/auth/signup').send({ workspaceName: 'Asaas', slug: 'e2e-asaas', name: 'Admin', email: `admin-asaas@${E2E_DOMAIN}`, password: 'senha-123456' }).expect(201);
    admin = r.body.accessToken;
    tenantId = (await http().get('/api/v1/auth/me').set(auth(admin))).body.tenant.id;
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM billing_events WHERE provider = 'asaas' AND event_id LIKE 'evt_e2e_%'`);
    await cleanup(db);
    await db.end();
  });

  it('exige CPF/CNPJ no checkout e responde 503 sem ASAAS_API_KEY (sem vazar detalhes)', async () => {
    const plans = await http().get('/api/v1/billing/plans').expect(200);
    expect(plans.body).toMatchObject({ provider: 'asaas', requiresDocument: true });
    await http().post('/api/v1/billing/checkout').set(auth(admin)).send({ planId: 'pro' }).expect(400);
    const r = await http().post('/api/v1/billing/checkout').set(auth(admin)).send({ planId: 'pro', document: '12.345.678/0001-90' }).expect(503);
    expect(r.body.message).not.toMatch(/ASAAS|key/i);
  });

  it('token errado → 401; PAYMENT_RECEIVED ativa o plano; repetição é idempotente; webhook "fake" desligado', async () => {
    const event = { id: 'evt_e2e_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', customer: 'cus_1', subscription: 'sub_1', externalReference: `${tenantId}:business` } };
    await send(event, 'token-errado-de-mesmo-tamanho-xxxxxxx').expect(401);
    expect((await send(event).expect(200)).body).toEqual({ status: 'processed' });
    expect((await db.query('SELECT status, plan_id FROM tenants WHERE id = $1', [tenantId])).rows[0]).toEqual({ status: 'active', plan_id: 'business' });
    expect((await db.query('SELECT provider, provider_customer_id, provider_subscription_id FROM subscriptions WHERE tenant_id = $1', [tenantId])).rows[0]).toEqual({ provider: 'asaas', provider_customer_id: 'cus_1', provider_subscription_id: 'sub_1' });
    expect((await send(event).expect(200)).body).toEqual({ status: 'duplicate' });
    await http().post('/api/v1/billing/webhook/fake').set('Content-Type', 'application/json').send('{}').expect(404);
  });

  it('evento irrelevante é registrado e ignorado; PAYMENT_OVERDUE → past_due', async () => {
    expect((await send({ id: 'evt_e2e_2', event: 'PAYMENT_CREATED', payment: { id: 'pay_2', externalReference: `${tenantId}:business` } }).expect(200)).body).toEqual({ status: 'ignored' });
    await send({ id: 'evt_e2e_3', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_3', subscription: 'sub_1', externalReference: `${tenantId}:business` } }).expect(200);
    expect((await db.query('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0].status).toBe('past_due');
  });
});
