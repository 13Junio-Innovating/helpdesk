import type pg from 'pg';
import { JwtService } from '@nestjs/jwt';
import { DbService } from '../src/common/db/db.service.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/common/auth/tokens.service.js';
import { API, createTestApp, PASSWORD, rawAppPool, rawSetCookie, refreshCookie, superPool, uniq, type TestApp } from './helpers.js';

const SEED_USERS = [
  { email: 'admin@demo.local', role: 'admin' },
  { email: 'carlos@demo.local', role: 'agent' },
  { email: 'bia@demo.local', role: 'agent' },
  { email: 'joao@acme.local', role: 'requester' },
  { email: 'maria@acme.local', role: 'requester' },
  { email: 'pedro@globex.local', role: 'requester' },
] as const;

let t: TestApp;
let su: pg.Pool;
let demoId: string;
const createdTenants: string[] = [];
const createdEmails: string[] = [];

async function login(email: string, password = PASSWORD) {
  return t.http().post(`${API}/auth/login`).send({ email, password });
}

async function signup(prefix: string) {
  const slug = `e2e-${prefix}-${uniq()}`;
  const email = `${slug}@e2e.test.local`;
  const res = await t.http().post(`${API}/auth/signup`)
    .send({ workspaceName: `E2E ${prefix}`, slug, name: `Admin ${prefix}`, email, password: PASSWORD });
  expect(res.status).toBe(201);
  createdTenants.push(res.body.tenantId);
  createdEmails.push(email);
  return { ...res.body, slug, email } as { tenantId: string; userId: string; accessToken: string; slug: string; email: string };
}

beforeAll(async () => {
  t = await createTestApp();
  su = superPool();
  const { rows } = await su.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'demo'");
  if (!rows[0]) throw new Error('Rode ./db/dev-reset.sh antes dos testes e2e (seed "demo" ausente).');
  demoId = rows[0].id;
});

afterAll(async () => {
  await su.query(`DELETE FROM memberships m USING users u WHERE u.id = m.user_id AND u.email = ANY($1)`, [createdEmails]);
  for (const id of createdTenants) await su.query('SELECT delete_tenant($1)', [id]);
  await su.query('DELETE FROM users WHERE email = ANY($1)', [createdEmails]);
  await su.end();
  await t.close();
});

describe('health', () => {
  it('GET /health e /health/ready checam o banco', async () => {
    await t.http().get(`${API}/health`).expect(200, { status: 'ok' });
    await t.http().get(`${API}/health/ready`).expect(200, { status: 'ready' });
  });
});

describe('login com os usuários do seed', () => {
  it.each(SEED_USERS)('$email entra direto no workspace demo como $role', async ({ email, role }) => {
    const res = await login(email.toUpperCase()); // e-mail é normalizado
    expect(res.status).toBe(200);
    expect(res.body.needsTenantSelection).toBe(false);
    expect(res.body.tenantId).toBe(demoId);
    expect(res.body).not.toHaveProperty('refreshToken');

    const cookie = rawSetCookie(res);
    expect(cookie).toMatch(/^sd_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const me = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe(role);
    expect(me.body.user.email).toBe(email);
    expect(me.body.tenant.slug).toBe('demo');
    expect(me.body.plan.id).toBe('starter');
    expect(me.body.trial.active).toBe(true);
  });

  it('senha errada, e-mail inexistente e usuário desativado dão a MESMA resposta', async () => {
    const wrong = await login('admin@demo.local', 'errada123');
    const ghost = await login('ninguem@demo.local', 'errada123');
    await su.query("UPDATE users SET disabled_at = now() WHERE email = 'maria@acme.local'");
    try {
      const disabled = await login('maria@acme.local');
      for (const r of [wrong, ghost, disabled]) {
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ code: 'invalid_credentials', message: 'E-mail ou senha incorretos.' });
      }
    } finally {
      await su.query("UPDATE users SET disabled_at = NULL WHERE email = 'maria@acme.local'");
    }
  });

  it('e-mail inexistente gasta tempo comparável (bcrypt sempre roda)', async () => {
    const time = async (email: string) => {
      const s = performance.now();
      await login(email, 'errada123');
      return performance.now() - s;
    };
    const known = [] as number[];
    const unknown = [] as number[];
    for (let i = 0; i < 3; i++) {
      known.push(await time('admin@demo.local'));
      unknown.push(await time(`ghost${i}@demo.local`));
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(unknown)).toBeGreaterThan(avg(known) * 0.5);
  });

  it('corpo inválido ou com campos extras => 400 validation_failed', async () => {
    const r = await t.http().post(`${API}/auth/login`).send({ email: 'x', password: PASSWORD, role: 'admin' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_failed');
  });
});

describe('proteção das rotas', () => {
  it('sem token => 401', async () => {
    const r = await t.http().get(`${API}/auth/me`);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('unauthorized');
  });

  it('token adulterado ou assinado com outro segredo => 401', async () => {
    const ok = (await login('admin@demo.local')).body.accessToken as string;
    const tampered = ok.slice(0, -3) + (ok.endsWith('a') ? 'bbb' : 'aaa');
    const foreign = new JwtService({ secret: 'outro-segredo-qualquer-com-32-caracteres!!' })
      .sign({ sub: 'x', tid: demoId, typ: 'access' }, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    for (const tok of [tampered, foreign, 'lixo']) {
      const r = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${tok}`);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('token_invalid');
    }
  });
});

describe('falha fechada: sem contexto de tenant o banco devolve zero linhas', () => {
  it('conexão crua como sd_app, sem app_set_context', async () => {
    const pool = rawAppPool();
    try {
      for (const table of ['tenants', 'tickets', 'memberships', 'users', 'statuses', 'ticket_messages', 'kb_articles']) {
        const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect({ table, n: Number(rows[0]!.n) }).toEqual({ table, n: 0 });
      }
    } finally {
      await pool.end();
    }
  });

  it('DbService.anonymous não enxerga dados; withTenant com vínculo enxerga', async () => {
    const db = t.app.get(DbService);
    const count = (sql: string) => async (c: pg.PoolClient) => Number((await c.query<{ n: string }>(sql)).rows[0]!.n);
    expect(await db.anonymous(count('SELECT count(*) AS n FROM tickets'))).toBe(0);

    const { rows } = await su.query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@demo.local'");
    expect(await db.withTenant({ tenantId: demoId, userId: rows[0]!.id }, count('SELECT count(*) AS n FROM tickets'))).toBe(10);
  });

  it('o contexto é LOCAL: não vaza para a próxima transação da mesma conexão', async () => {
    const db = t.app.get(DbService);
    const { rows } = await su.query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@demo.local'");
    // app_set_context usa set_config(..., is_local = true): some no COMMIT, a conexão volta limpa ao pool
    await db.withTenant({ tenantId: demoId, userId: rows[0]!.id }, async () => undefined);
    for (let i = 0; i < 5; i++) {
      const tid = await db.anonymous(async (c) => (await c.query<{ t: string | null }>('SELECT app_tenant_id() AS t')).rows[0]!.t);
      expect(tid).toBeNull();
    }
  });
});

describe('isolamento entre tenants', () => {
  it('usuário do tenant B não lê o tenant A nem forjando o tid do JWT', async () => {
    const b = await signup('iso');
    const forged = new JwtService({ secret: process.env.JWT_SECRET })
      .sign({ sub: b.userId, tid: demoId, typ: 'access' }, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 60 });
    const r = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${forged}`);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('session_invalid');

    const sel = await t.http().post(`${API}/auth/select-tenant`).set('Authorization', `Bearer ${b.accessToken}`)
      .send({ tenantId: demoId });
    expect(sel.status).toBe(403);
    expect(sel.body.code).toBe('not_a_member');

    // e no banco, mesmo que a API errasse: contexto (demo, usuário B) não enxerga nada
    const db = t.app.get(DbService);
    const n = await db.withTenant({ tenantId: demoId, userId: b.userId }, async (c) =>
      Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM tickets')).rows[0]!.n));
    expect(n).toBe(0);
    const own = await db.withTenant({ tenantId: b.tenantId, userId: b.userId }, async (c) =>
      Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM statuses')).rows[0]!.n));
    expect(own).toBe(6);
  });

  it('admin do demo não entra no tenant B', async () => {
    const b = await signup('iso2');
    const admin = (await login('admin@demo.local')).body.accessToken as string;
    const r = await t.http().post(`${API}/auth/select-tenant`).set('Authorization', `Bearer ${admin}`).send({ tenantId: b.tenantId });
    expect(r.status).toBe(403);
  });
});

describe('vários workspaces: login em duas etapas', () => {
  it('login devolve token "pre" + lista; select-tenant emite o token final', async () => {
    const a = await signup('multi');
    await su.query(
      `INSERT INTO memberships (tenant_id, user_id, role) SELECT $1, id, 'requester' FROM users WHERE email = $2`,
      [demoId, a.email],
    );

    const res = await login(a.email);
    expect(res.status).toBe(200);
    expect(res.body.needsTenantSelection).toBe(true);
    expect(res.body.workspaces.map((w: { id: string }) => w.id).toSorted()).toEqual([a.tenantId, demoId].toSorted());
    expect(refreshCookie(res)).toBeUndefined();
    const pre = res.body.preTenantToken as string;

    const me = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${pre}`);
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('tenant_required');

    const sel = await t.http().post(`${API}/auth/select-tenant`).set('Authorization', `Bearer ${pre}`).send({ tenantId: demoId });
    expect(sel.status).toBe(200);
    expect(refreshCookie(sel)).toBeDefined();
    const me2 = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${sel.body.accessToken}`);
    expect(me2.body.role).toBe('requester');
    expect(me2.body.tenant.id).toBe(demoId);

    // trocar para o próprio workspace (como admin) com o token final
    const sw = await t.http().post(`${API}/auth/select-tenant`).set('Authorization', `Bearer ${sel.body.accessToken}`)
      .set('Cookie', refreshCookie(sel)!).send({ tenantId: a.tenantId });
    expect(sw.status).toBe(200);
    const me3 = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${sw.body.accessToken}`);
    expect(me3.body.role).toBe('admin');
    // a sessão anterior deste navegador foi encerrada na troca
    const old = await t.http().post(`${API}/auth/refresh`).set('Cookie', refreshCookie(sel)!);
    expect(old.status).toBe(401);
  });
});

describe('refresh token', () => {
  it('rotação: o novo funciona; reusar o antigo derruba a sessão inteira', async () => {
    const res = await login('carlos@demo.local');
    const c1 = refreshCookie(res)!;

    const r1 = await t.http().post(`${API}/auth/refresh`).set('Cookie', c1);
    expect(r1.status).toBe(200);
    expect(r1.body.tenantId).toBe(demoId);
    const c2 = refreshCookie(r1)!;
    expect(c2).not.toBe(c1);
    await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${r1.body.accessToken}`).expect(200);

    const reuse = await t.http().post(`${API}/auth/refresh`).set('Cookie', c1);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('refresh_reused');
    expect(rawSetCookie(reuse)).toMatch(/sd_rt=;/); // cookie limpo

    const after = await t.http().post(`${API}/auth/refresh`).set('Cookie', c2);
    expect(after.status).toBe(401);
  });

  it('sem cookie => 401 refresh_missing; token desconhecido => 401 refresh_invalid', async () => {
    expect((await t.http().post(`${API}/auth/refresh`)).body.code).toBe('refresh_missing');
    expect((await t.http().post(`${API}/auth/refresh`).set('Cookie', 'sd_rt=naoexiste')).body.code).toBe('refresh_invalid');
  });

  it('logout revoga a sessão; logout-all revoga todas', async () => {
    const a = refreshCookie(await login('bia@demo.local'))!;
    await t.http().post(`${API}/auth/logout`).set('Cookie', a).expect(204);
    expect((await t.http().post(`${API}/auth/refresh`).set('Cookie', a)).status).toBe(401);

    const s1 = await login('bia@demo.local');
    const s2 = await login('bia@demo.local');
    const out = await t.http().post(`${API}/auth/logout-all`).set('Authorization', `Bearer ${s1.body.accessToken}`);
    expect(out.status).toBe(200);
    expect(out.body.revokedSessions).toBeGreaterThanOrEqual(2);
    for (const s of [s1, s2]) expect((await t.http().post(`${API}/auth/refresh`).set('Cookie', refreshCookie(s)!)).status).toBe(401);
  });
});

describe('vínculo desativado perde acesso imediatamente', () => {
  it('access token deixa de valer e o refresh é recusado', async () => {
    const res = await login('pedro@globex.local');
    const token = res.body.accessToken as string;
    await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${token}`).expect(200);

    await su.query(`UPDATE memberships SET active = false WHERE user_id = (SELECT id FROM users WHERE email = 'pedro@globex.local')`);
    try {
      const me = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(401);
      expect(me.body.code).toBe('session_invalid');
      const rf = await t.http().post(`${API}/auth/refresh`).set('Cookie', refreshCookie(res)!);
      expect(rf.status).toBe(401);
    } finally {
      await su.query(`UPDATE memberships SET active = true WHERE user_id = (SELECT id FROM users WHERE email = 'pedro@globex.local')`);
    }
  });
});

describe('cadastro self-service', () => {
  it('cria workspace em trial com o usuário como admin', async () => {
    const s = await signup('new');
    const me = await t.http().get(`${API}/auth/me`).set('Authorization', `Bearer ${s.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('admin');
    expect(me.body.tenant.slug).toBe(s.slug);
    expect(me.body.tenant.status).toBe('trial');
    expect(me.body.trial.daysLeft).toBe(14);
    expect((await login(s.email)).status).toBe(200);
  });

  it('e-mail repetido => 409 email_already_registered; slug repetido => 409 slug_taken', async () => {
    const base = { workspaceName: 'Outro', name: 'Fulano', password: PASSWORD };
    const dupEmail = await t.http().post(`${API}/auth/signup`).send({ ...base, slug: `e2e-x-${uniq()}`, email: 'ADMIN@demo.local' });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.code).toBe('email_already_registered');

    const email = `dup-${uniq()}@e2e.test.local`;
    const dupSlug = await t.http().post(`${API}/auth/signup`).send({ ...base, slug: 'demo', email });
    expect(dupSlug.status).toBe(409);
    expect(dupSlug.body).toEqual({ code: 'slug_taken', message: 'Este endereço de workspace já está em uso.' });
    // a transação foi desfeita: o e-mail não ficou "meio cadastrado"
    expect((await su.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount).toBe(0);
  });

  it.each([
    ['slug reservado', { slug: 'admin' }],
    ['slug com maiúscula/espaço', { slug: 'Meu Time' }],
    ['slug curto', { slug: 'ab' }],
    ['senha curta', { password: '1234567' }],
    ['e-mail inválido', { email: 'nao-e-email' }],
  ])('validação: %s => 400', async (_label, patch) => {
    const r = await t.http().post(`${API}/auth/signup`).send({
      workspaceName: 'Teste', slug: `e2e-v-${uniq()}`, name: 'Fulano', email: `v-${uniq()}@e2e.test.local`, password: PASSWORD, ...patch,
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_failed');
  });
});
