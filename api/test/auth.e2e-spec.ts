import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import type pg from 'pg';
import request from 'supertest';
import { auth, cleanup, createApp, E2E_DOMAIN, login, refreshCookie, sha256, superDb } from './helpers.js';

const SEED_USERS = [
  ['admin@demo.local', 'admin'],
  ['carlos@demo.local', 'agent'],
  ['bia@demo.local', 'agent'],
  ['joao@acme.local', 'requester'],
  ['maria@acme.local', 'requester'],
  ['pedro@globex.local', 'requester'],
] as const;

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db);
    await db.end();
  });

  function signup(slug: string, email: string, password = 'senha-forte-123') {
    return http()
      .post('/api/v1/auth/signup')
      .send({ workspaceName: `Empresa ${slug}`, slug, name: 'Pessoa Teste', email, password });
  }

  describe('health', () => {
    it('GET /health e /health/ready respondem sem autenticação', async () => {
      await http().get('/api/v1/health').expect(200, { status: 'ok' });
      await http().get('/api/v1/health/ready').expect(200, { status: 'ready' });
    });
  });

  describe('login', () => {
    it.each(SEED_USERS)('%s entra com a senha do seed (papel %s)', async (email, role) => {
      const res = await http().post('/api/v1/auth/login').send({ email, password: 'demo1234' }).expect(200);
      expect(res.body.needsTenantSelection).toBe(false);
      expect(res.body.workspaces).toEqual([expect.objectContaining({ slug: 'demo', role })]);
      expect(res.body).not.toHaveProperty('refreshToken');

      const me = await http().get('/api/v1/auth/me').set(auth(res.body.accessToken)).expect(200);
      expect(me.body.role).toBe(role);
      expect(me.body.user.email).toBe(email);
      expect(me.body.tenant.slug).toBe('demo');
    });

    it('define o refresh token em cookie httpOnly; Secure; SameSite=Lax restrito a /api/v1/auth', async () => {
      const res = await http().post('/api/v1/auth/login').send({ email: 'admin@demo.local', password: 'demo1234' }).expect(200);
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('hd_rt='))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    });

    it('e-mail normalizado (maiúsculas/espaços) funciona', async () => {
      await http().post('/api/v1/auth/login').send({ email: '  ADMIN@Demo.Local ', password: 'demo1234' }).expect(200);
    });

    it('senha errada e e-mail inexistente devolvem a mesma resposta 401', async () => {
      const wrong = await http().post('/api/v1/auth/login').send({ email: 'admin@demo.local', password: 'errada' }).expect(401);
      const unknown = await http().post('/api/v1/auth/login').send({ email: 'ninguem@demo.local', password: 'errada' }).expect(401);
      expect(wrong.body).toEqual({ code: 'invalid_credentials', message: 'E-mail ou senha incorretos.' });
      expect(unknown.body).toEqual(wrong.body);
    });

    it('e-mail inexistente também executa bcrypt (tempo semelhante ao de senha errada)', async () => {
      const time = async (email: string) => {
        const t = performance.now();
        await http().post('/api/v1/auth/login').send({ email, password: 'errada' });
        return performance.now() - t;
      };
      await time('admin@demo.local'); // aquece
      const known = Math.min(await time('admin@demo.local'), await time('admin@demo.local'));
      const unknown = Math.min(await time('nao-existe@demo.local'), await time('nao-existe@demo.local'));
      // sem o compare "fantasma", o caso inexistente seria ~10x mais rápido
      expect(unknown).toBeGreaterThan(known * 0.4);
    });

    it('corpo inválido → 400 validation_failed, campo extra é rejeitado', async () => {
      const res = await http().post('/api/v1/auth/login').send({ email: 'x', password: 'y', admin: true }).expect(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  describe('token', () => {
    it('sem token → 401', async () => {
      const res = await http().get('/api/v1/auth/me').expect(401);
      expect(res.body).toEqual({ code: 'unauthorized', message: 'Autenticação necessária.' });
      await http().get('/api/v1/catalog/statuses').expect(401);
    });

    it('token inválido, adulterado ou assinado com outra chave → 401', async () => {
      const { token } = await login(app, 'joao@acme.local');
      await http().get('/api/v1/auth/me').set(auth('lixo')).expect(401);

      // troca o papel no payload mantendo a assinatura antiga
      const [h, p, s] = token.split('.');
      const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
      payload.role = 'admin';
      const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
      await http().get('/api/v1/auth/me').set(auth(tampered)).expect(401);

      const forged = await new JwtService({ secret: 'outra-chave-com-mais-de-32-caracteres!!' }).signAsync(
        { sub: payload.sub, typ: payload.typ, tid: payload.tid, role: payload.role },
        { issuer: 'helpdesk-api', audience: 'helpdesk' },
      );
      await http().get('/api/v1/auth/me').set(auth(forged)).expect(401);
    });

    it('papel do JWT não é fonte de verdade: o /me reflete o papel atual do banco', async () => {
      const { token } = await login(app, 'bia@demo.local');
      await db.query(
        `UPDATE memberships SET role = 'requester' WHERE user_id = (SELECT id FROM users WHERE email = 'bia@demo.local')`,
      );
      try {
        const me = await http().get('/api/v1/auth/me').set(auth(token)).expect(200);
        expect(me.body.role).toBe('requester');
      } finally {
        await db.query(
          `UPDATE memberships SET role = 'agent' WHERE user_id = (SELECT id FROM users WHERE email = 'bia@demo.local')`,
        );
      }
    });
  });

  describe('refresh e logout', () => {
    it('refresh rotaciona o cookie; reapresentar o antigo revoga a sessão inteira', async () => {
      const s = await login(app, 'carlos@demo.local');
      const r1 = await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).expect(200);
      const c1 = refreshCookie(r1);
      expect(c1).not.toBe(s.cookie);
      await http().get('/api/v1/auth/me').set(auth(r1.body.accessToken)).expect(200);

      // cookie antigo reaparece (roubo): 401 e a cadeia toda morre
      const reuse = await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
      expect(reuse.body.code).toBe('session_invalid');
      await http().post('/api/v1/auth/refresh').set('Cookie', c1).expect(401);
    });

    it('sem cookie → 401 session_invalid', async () => {
      const res = await http().post('/api/v1/auth/refresh').expect(401);
      expect(res.body.code).toBe('session_invalid');
    });

    it('logout revoga o refresh e limpa o cookie', async () => {
      const s = await login(app, 'carlos@demo.local');
      const out = await http().post('/api/v1/auth/logout').set('Cookie', s.cookie).expect(204);
      expect(String(out.headers['set-cookie'])).toMatch(/hd_rt=;/);
      await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
    });
  });

  describe('cadastro (signup)', () => {
    it('cria workspace em trial com o usuário como admin e já autentica', async () => {
      const res = await signup('e2e-acme', `dono@${E2E_DOMAIN}`).expect(201);
      expect(res.body.needsTenantSelection).toBe(false);
      expect(refreshCookie(res)).toMatch(/^hd_rt=/);
      const me = await http().get('/api/v1/auth/me').set(auth(res.body.accessToken)).expect(200);
      expect(me.body).toMatchObject({ role: 'admin', tenant: { slug: 'e2e-acme', status: 'trial' }, plan: { id: 'starter' } });
      const trialDays = (Date.parse(me.body.tenant.trialEndsAt) - Date.now()) / 86_400_000;
      expect(trialDays).toBeGreaterThan(13.9);
      expect(trialDays).toBeLessThanOrEqual(14);
      // defaults do workspace (criados pelo banco)
      const statuses = await http().get('/api/v1/catalog/statuses').set(auth(res.body.accessToken)).expect(200);
      expect(statuses.body).toHaveLength(6);
    });

    it('e-mail já cadastrado → 409 email_already_registered', async () => {
      const res = await signup('e2e-outro', 'ADMIN@demo.local').expect(409);
      expect(res.body.code).toBe('email_already_registered');
    });

    it('slug em uso → 409 slug_taken', async () => {
      const res = await signup('demo', `x@${E2E_DOMAIN}`).expect(409);
      expect(res.body.code).toBe('slug_taken');
    });

    it.each(['api', 'www', 'ab', '-abc', 'abc-', 'a'.repeat(41), 'com_underscore'])('slug "%s" é rejeitado', async (slug) => {
      const res = await signup(slug, `slug@${E2E_DOMAIN}`).expect(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('senha curta → 400', async () => {
      await signup('e2e-curta', `curta@${E2E_DOMAIN}`, '1234567').expect(400);
    });
  });

  describe('vários workspaces', () => {
    let tenantB: string;

    beforeAll(async () => {
      const res = await signup('e2e-multi', `multi@${E2E_DOMAIN}`).expect(201);
      const me = await http().get('/api/v1/auth/me').set(auth(res.body.accessToken)).expect(200);
      tenantB = me.body.tenant.id;
      // joão (cliente no demo) também passa a ser cliente do e2e-multi
      await db.query(
        `INSERT INTO memberships (tenant_id, user_id, role) SELECT $1, id, 'requester' FROM users WHERE email = 'joao@acme.local'`,
        [tenantB],
      );
    });

    it('login devolve token pré-tenant + lista; o token pré-tenant não acessa dados', async () => {
      const res = await http().post('/api/v1/auth/login').send({ email: 'joao@acme.local', password: 'demo1234' }).expect(200);
      expect(res.body.needsTenantSelection).toBe(true);
      expect(res.body.workspaces).toHaveLength(2);
      expect(refreshCookie(res)).toBe('');
      const pre = res.body.accessToken as string;

      const blocked = await http().get('/api/v1/catalog/statuses').set(auth(pre)).expect(403);
      expect(blocked.body.code).toBe('forbidden');
      await http().get('/api/v1/auth/me').set(auth(pre)).expect(403);

      const sel = await http().post('/api/v1/auth/select-tenant').set(auth(pre)).send({ tenantId: tenantB }).expect(200);
      expect(refreshCookie(sel)).toMatch(/^hd_rt=/);
      const me = await http().get('/api/v1/auth/me').set(auth(sel.body.accessToken)).expect(200);
      expect(me.body.tenant.id).toBe(tenantB);
      expect(me.body.role).toBe('requester');
    });

    it('select-tenant para workspace sem vínculo → 403', async () => {
      const res = await http().post('/api/v1/auth/login').send({ email: 'joao@acme.local', password: 'demo1234' }).expect(200);
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'e2e-acme'`);
      await http().post('/api/v1/auth/select-tenant').set(auth(res.body.accessToken)).send({ tenantId: rows[0]!.id }).expect(403);
    });

    it('select-tenant sem token → 401', async () => {
      await http().post('/api/v1/auth/select-tenant').send({ tenantId: tenantB }).expect(401);
    });
  });

  describe('perda de acesso', () => {
    it('usuário desativado perde acesso na próxima requisição (mesmo com token válido)', async () => {
      const res = await signup('e2e-desat', `desat@${E2E_DOMAIN}`).expect(201);
      const token = res.body.accessToken as string;
      await http().get('/api/v1/auth/me').set(auth(token)).expect(200);

      await db.query(`UPDATE users SET disabled_at = now() WHERE email = $1`, [`desat@${E2E_DOMAIN}`]);
      const me = await http().get('/api/v1/auth/me').set(auth(token)).expect(401);
      expect(me.body.code).toBe('session_invalid');
      await http().post('/api/v1/auth/refresh').set('Cookie', refreshCookie(res)).expect(401);
      await http().post('/api/v1/auth/login').send({ email: `desat@${E2E_DOMAIN}`, password: 'senha-forte-123' }).expect(401);
    });

    it('membership desativado perde acesso imediatamente', async () => {
      const s = await login(app, 'maria@acme.local');
      await db.query(`UPDATE memberships SET active = false WHERE user_id = (SELECT id FROM users WHERE email = 'maria@acme.local')`);
      try {
        await http().get('/api/v1/catalog/statuses').set(auth(s.token)).expect(401);
        await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
      } finally {
        await db.query(`UPDATE memberships SET active = true WHERE user_id = (SELECT id FROM users WHERE email = 'maria@acme.local')`);
      }
    });
  });

  describe('convites', () => {
    let tenantId: string;
    let adminId: string;

    beforeAll(async () => {
      const res = await signup('e2e-convites', `admin-conv@${E2E_DOMAIN}`).expect(201);
      const me = await http().get('/api/v1/auth/me').set(auth(res.body.accessToken)).expect(200);
      tenantId = me.body.tenant.id;
      adminId = me.body.user.id;
    });

    // até a fase 3 (POST /invitations) o convite é criado direto no banco
    async function invite(email: string, token: string, opts: { expired?: boolean } = {}) {
      await db.query(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'agent', $3, $4, now() + $5::interval)`,
        [tenantId, email, sha256(token), adminId, opts.expired ? '-1 minute' : '7 days'],
      );
    }

    it('novo usuário aceita, entra como agente; token é de uso único', async () => {
      const token = 'convite-novo-usuario-0123456789';
      await invite(`novo@${E2E_DOMAIN}`, token);
      const res = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Novo Agente', password: 'senha-nova-123' }).expect(200);
      const me = await http().get('/api/v1/auth/me').set(auth(res.body.accessToken)).expect(200);
      expect(me.body).toMatchObject({ role: 'agent', tenant: { id: tenantId }, user: { email: `novo@${E2E_DOMAIN}`, name: 'Novo Agente' } });

      const again = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Xx', password: 'senha-nova-123' }).expect(410);
      expect(again.body.code).toBe('invitation_invalid');
      await login(app, `novo@${E2E_DOMAIN}`, 'senha-nova-123');
    });

    it('convite expirado → 410', async () => {
      const token = 'convite-expirado-0123456789abc';
      await invite(`expira@${E2E_DOMAIN}`, token, { expired: true });
      const res = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Xx', password: 'senha-nova-123' }).expect(410);
      expect(res.body.code).toBe('invitation_invalid');
    });

    it('conta existente: exige a senha atual; com senha errada o convite não é consumido', async () => {
      const token = 'convite-conta-existente-0123456';
      await invite('pedro@globex.local', token);
      const bad = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Pedro', password: 'tentativa-de-invasao' }).expect(401);
      expect(bad.body.code).toBe('invalid_credentials');
      const { rows } = await db.query(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'pedro@globex.local' AND m.tenant_id = $1`, [tenantId]);
      expect(rows).toHaveLength(0);

      const ok = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Pedro', password: 'demo1234' }).expect(200);
      const me = await http().get('/api/v1/auth/me').set(auth(ok.body.accessToken)).expect(200);
      expect(me.body.tenant.id).toBe(tenantId);
      expect(me.body.user.name).toBe('Pedro Almeida'); // nome da conta existente é preservado
    });
  });

  describe('esqueci / redefinir senha', () => {
    const email = `reset@${E2E_DOMAIN}`;

    beforeAll(async () => {
      await signup('e2e-reset', email, 'senha-antiga-123').expect(201);
    });

    it('resposta idêntica exista ou não o e-mail', async () => {
      const a = await http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const b = await http().post('/api/v1/auth/forgot-password').send({ email: `nao-existe@${E2E_DOMAIN}` }).expect(202);
      expect(a.body).toEqual(b.body);
      const { rows } = await db.query(`SELECT to_email FROM email_outbox WHERE template = 'password_reset' AND to_email LIKE $1`, [`%@${E2E_DOMAIN}`]);
      expect(rows.map((r) => r.to_email)).toEqual([email]);
    });

    it('token do e-mail troca a senha, é de uso único e derruba as sessões', async () => {
      const s = await login(app, email, 'senha-antiga-123');
      await http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const { rows } = await db.query<{ token: string }>(
        `SELECT payload->>'token' AS token FROM email_outbox WHERE template = 'password_reset' AND to_email = $1 ORDER BY id DESC LIMIT 1`,
        [email],
      );
      const token = rows[0]!.token;
      await http().post('/api/v1/auth/reset-password').send({ token, password: 'senha-nova-456' }).expect(204);

      const reused = await http().post('/api/v1/auth/reset-password').send({ token, password: 'outra-senha-789' }).expect(410);
      expect(reused.body.code).toBe('reset_token_invalid');
      await http().post('/api/v1/auth/login').send({ email, password: 'senha-antiga-123' }).expect(401);
      await login(app, email, 'senha-nova-456');
      await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
    });

    it('token desconhecido → 410', async () => {
      await http().post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(43), password: 'senha-nova-456' }).expect(410);
    });
  });
});
