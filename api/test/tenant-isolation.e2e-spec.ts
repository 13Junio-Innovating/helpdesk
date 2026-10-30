import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import request from 'supertest';
import { DbService } from '../src/common/db/db.service.js';
import { auth, cleanup, createApp, E2E_DOMAIN, login, superDb } from './helpers.js';

describe('Isolamento entre tenants e falha fechada (e2e)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  let dbService: DbService;
  let demoToken: string;
  let otherToken: string;
  let demo: { tenantId: string; userId: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();
    dbService = app.get(DbService);

    const s = await login(app, 'admin@demo.local');
    demoToken = s.token;
    const me = await http().get('/api/v1/auth/me').set(auth(demoToken)).expect(200);
    demo = { tenantId: me.body.tenant.id, userId: me.body.user.id };

    const other = await http()
      .post('/api/v1/auth/signup')
      .send({ workspaceName: 'Outra', slug: 'e2e-outra', name: 'Admin Outra', email: `admin@${E2E_DOMAIN}`, password: 'senha-forte-123' })
      .expect(201);
    otherToken = other.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db);
    await db.end();
  });

  it('sem contexto de tenant o banco devolve 0 linhas (sd_app)', async () => {
    const counts = await dbService.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ tenants: string; tickets: string; statuses: string; users: string; memberships: string }>(
        `SELECT (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM tickets) AS tickets,
                (SELECT count(*) FROM statuses) AS statuses, (SELECT count(*) FROM users) AS users,
                (SELECT count(*) FROM memberships) AS memberships`,
      );
      return rows[0];
    });
    expect(counts).toEqual({ tenants: '0', tickets: '0', statuses: '0', users: '0', memberships: '0' });
  });

  it('o contexto é LOCAL: a mesma conexão (pool de 1) volta a enxergar 0 linhas depois do COMMIT', async () => {
    const inside = await dbService.withTenant(demo, async (tx) => Number((await tx.query('SELECT count(*) AS n FROM tickets')).rows[0]!.n));
    expect(inside).toBeGreaterThan(0);
    const after = await dbService.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ tid: string | null; n: string }>(`SELECT app_tenant_id() AS tid, (SELECT count(*) FROM tickets) AS n`);
      return rows[0];
    });
    expect(after).toEqual({ tid: null, n: '0' });
  });

  it('erro dentro da transação faz ROLLBACK e libera a conexão (pool de 1 continua utilizável)', async () => {
    await expect(dbService.withTenant(demo, (tx) => tx.query('SELECT 1/0'))).rejects.toThrow();
    const ok = await dbService.withTenant(demo, async (tx) => (await tx.query('SELECT 1 AS one')).rows[0]!.one);
    expect(ok).toBe(1);
  });

  it('a API usa sd_app (sujeita a RLS, sem BYPASSRLS)', async () => {
    const role = await dbService.withoutTenant(async (tx) => {
      const { rows } = await tx.query<{ usr: string; bypass: boolean }>(
        `SELECT current_user AS usr, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
      );
      return rows[0];
    });
    expect(role).toEqual({ usr: 'sd_app', bypass: false });
  });

  it('cada tenant só lista o próprio catálogo', async () => {
    const a = await http().get('/api/v1/catalog/categories').set(auth(demoToken)).expect(200);
    const b = await http().get('/api/v1/catalog/categories').set(auth(otherToken)).expect(200);
    const idsA = new Set(a.body.map((c: { id: string }) => c.id));
    expect(b.body.length).toBeGreaterThan(0);
    expect(b.body.some((c: { id: string }) => idsA.has(c.id))).toBe(false);
  });

  it('forjar ID de outro tenant na URL → 404 (não vaza nem a existência)', async () => {
    const a = await http().get('/api/v1/catalog/categories').set(auth(demoToken)).expect(200);
    const demoCategory = a.body[0].id as string;
    await http().get(`/api/v1/catalog/categories/${demoCategory}`).set(auth(demoToken)).expect(200);
    const res = await http().get(`/api/v1/catalog/categories/${demoCategory}`).set(auth(otherToken)).expect(404);
    expect(res.body).toEqual({ code: 'not_found', message: 'Não encontramos a categoria.' });
  });

  it('ID malformado → 400', async () => {
    await http().get('/api/v1/catalog/categories/nao-e-uuid').set(auth(demoToken)).expect(400);
  });

  it('withTenant com tenant de outra pessoa (contexto forjado) é recusado antes de qualquer query', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'e2e-outra'`);
    await expect(
      dbService.withTenant({ tenantId: rows[0]!.id, userId: demo.userId }, (tx) => tx.query('SELECT count(*) FROM tickets')),
    ).rejects.toMatchObject({ code: 'session_invalid' });
  });

  it('RLS barra escrita em tenant alheio mesmo se a API errar o tenant_id', async () => {
    // INSERT direto num tenant alheio: a RLS barra com 42501 (o filtro traduz para 403, ver pg-errors.spec)
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'e2e-outra'`);
    const err = await dbService
      .withTenant(demo, (tx) => tx.query(`INSERT INTO queues (tenant_id, name) VALUES ($1, 'invasão')`, [rows[0]!.id]))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: '42501' });
  });
});
