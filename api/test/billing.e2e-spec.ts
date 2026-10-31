import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import request from 'supertest';
import { addMember, auth, cleanup, createApp, E2E_DOMAIN, login, superDb } from './helpers.js';

const PW = 'senha-123456';

describe('Cobrança com provedor de teste (e2e)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  let admin: string;
  let agent: string;
  let tenantId: string;
  const http = () => request(app.getHttpServer());
  const tenant = async () => (await db.query<{ status: string; plan_id: string }>('SELECT status, plan_id FROM tenants WHERE id = $1', [tenantId])).rows[0]!;
  const session = async (planId: string) => {
    const r = await http().post('/api/v1/billing/checkout').set(auth(admin)).send({ planId }).expect(200);
    return new URL(r.body.url).searchParams.get('session')!;
  };

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();
    const res = await http().post('/api/v1/auth/signup').send({ workspaceName: 'Cobrança', slug: 'e2e-cobranca', name: 'Admin', email: `admin-bill@${E2E_DOMAIN}`, password: PW }).expect(201);
    admin = res.body.accessToken;
    tenantId = (await http().get('/api/v1/auth/me').set(auth(admin))).body.tenant.id;
    await addMember(db, tenantId, `agente-bill@${E2E_DOMAIN}`, 'agent');
    agent = (await login(app, `agente-bill@${E2E_DOMAIN}`, PW)).token;
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM billing_events WHERE tenant_id = $1 OR payload::text LIKE $2`, [tenantId, `%${tenantId}%`]);
    await cleanup(db);
    await db.end();
  });

  it('planos públicos para a página de preços', async () => {
    const r = await http().get('/api/v1/billing/plans').expect(200);
    expect(r.body.provider).toBe('fake');
    expect(r.body.plans.map((p: { id: string }) => p.id)).toEqual(['starter', 'pro', 'business']);
  });

  it('só admin inicia checkout; plano inexistente → 422', async () => {
    await http().post('/api/v1/billing/checkout').set(auth(agent)).send({ planId: 'pro' }).expect(403);
    await http().post('/api/v1/billing/checkout').set(auth(admin)).send({ planId: 'nao-existe' }).expect(422);
    const r = await http().post('/api/v1/billing/checkout').set(auth(admin)).send({ planId: 'pro' }).expect(200);
    expect(r.body.url).toMatch(/^http:\/\/localhost:5173\/assinatura\/simulada\?session=/);
    expect(await tenant()).toEqual({ status: 'trial', plan_id: 'starter' }); // checkout não muda nada sozinho
  });

  it('pagamento aprovado ativa o plano Pro; reenvio do mesmo evento não reprocessa', async () => {
    const s = await session('pro');
    expect((await http().post('/api/v1/billing/fake/simulate').set(auth(admin)).send({ session: s, outcome: 'paid' }).expect(200)).body).toEqual({ status: 'processed' });
    expect(await tenant()).toEqual({ status: 'active', plan_id: 'pro' });
    const sub = (await db.query('SELECT plan_id, status, provider, provider_subscription_id FROM subscriptions WHERE tenant_id = $1', [tenantId])).rows[0];
    expect(sub).toMatchObject({ plan_id: 'pro', status: 'active', provider: 'fake' });
    const me = await http().get('/api/v1/tenant').set(auth(admin)).expect(200);
    expect(me.body.plan.id).toBe('pro');

    // o mesmo corpo assinado chegando de novo (retentativa do provedor)
    const { rows } = await db.query<{ payload: unknown }>(`SELECT payload FROM billing_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [tenantId]);
    const body = JSON.stringify(rows[0]!.payload);
    const { FakeBillingProvider } = await import('../src/billing/fake.provider.js');
    const signature = (new FakeBillingProvider(process.env['BILLING_FAKE_SECRET'] ?? 'dev-only-fake-billing-secret', '') as unknown as { hmac(b: string): string }).hmac(body);
    const dup = await http().post('/api/v1/billing/webhook/fake').set('Content-Type', 'application/json').set('x-fake-signature', signature).send(body).expect(200);
    expect(dup.body).toEqual({ status: 'duplicate' });
    expect((await db.query('SELECT count(*)::int AS n FROM billing_events WHERE tenant_id = $1', [tenantId])).rows[0].n).toBe(1);
  });

  it('assinatura inválida → 401 e nada é gravado', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM billing_events')).rows[0].n;
    const body = JSON.stringify({ id: 'evt_forjado', event: 'PAYMENT_CONFIRMED', externalReference: `${tenantId}:business` });
    await http().post('/api/v1/billing/webhook/fake').set('Content-Type', 'application/json').set('x-fake-signature', 'a'.repeat(64)).send(body).expect(401);
    await http().post('/api/v1/billing/webhook/fake').set('Content-Type', 'application/json').send(body).expect(401);
    expect((await db.query('SELECT count(*)::int AS n FROM billing_events')).rows[0].n).toBe(before);
    expect((await tenant()).plan_id).toBe('pro');
  });

  it('provedor desconhecido → 404; sessão adulterada → 400; sessão de outro workspace → 403', async () => {
    await http().post('/api/v1/billing/webhook/stripe').set('Content-Type', 'application/json').send('{}').expect(404);
    await http().post('/api/v1/billing/fake/simulate').set(auth(admin)).send({ session: 'lixo.lixo', outcome: 'paid' }).expect(400);
    const s = await session('business');
    const otherAdmin = (await http().post('/api/v1/auth/signup').send({ workspaceName: 'Outro', slug: 'e2e-cobranca-2', name: 'Outro', email: `outro-bill@${E2E_DOMAIN}`, password: PW }).expect(201)).body.accessToken;
    await http().post('/api/v1/billing/fake/simulate').set(auth(otherAdmin)).send({ session: s, outcome: 'paid' }).expect(403);
  });

  it('atraso → past_due; cancelamento → canceled (conta passa a recusar chamados com 402)', async () => {
    const s1 = await session('pro');
    await http().post('/api/v1/billing/fake/simulate').set(auth(admin)).send({ session: s1, outcome: 'overdue' }).expect(200);
    expect((await tenant()).status).toBe('past_due');
    const s2 = await session('pro');
    await http().post('/api/v1/billing/fake/simulate').set(auth(admin)).send({ session: s2, outcome: 'canceled' }).expect(200);
    expect((await tenant()).status).toBe('canceled');
    const requesterId = (await http().get('/api/v1/auth/me').set(auth(admin))).body.user.id;
    const r = await http().post('/api/v1/tickets').set(auth(agent)).send({ subject: 'Depois do cancelamento', requesterId }).expect(402);
    expect(r.body.code).toBe('tenant_inactive');
  });
});
