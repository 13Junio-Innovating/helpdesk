import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

export const E2E_DOMAIN = 'e2e.test.local';
export const SEED_PASSWORD = 'demo1234';

export async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}

/** Conexão de SUPERUSUÁRIO, só para preparar/inspecionar cenários nos testes (nunca usada pela API). */
export function superDb(): pg.Pool {
  const url = process.env['PGSUPER_DB_URL'];
  if (!url) throw new Error('PGSUPER_DB_URL não definido (.env)');
  return new pg.Pool({ connectionString: url, max: 2 });
}

export async function cleanup(db: pg.Pool): Promise<void> {
  await db.query(`SELECT delete_tenant(t.id) FROM tenants t WHERE t.slug LIKE 'e2e-%'`);
  await db.query(`DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%@${E2E_DOMAIN}`]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${E2E_DOMAIN}`]);
  await db.query(`DELETE FROM email_outbox WHERE to_email LIKE $1`, [`%@${E2E_DOMAIN}`]);
  await db.query(`DELETE FROM plans WHERE id LIKE 'e2e-%'`);
}

/** Cria usuário + membership direto no banco (até existir convite via API). Senha bcrypt via pgcrypto. */
export async function addMember(
  db: pg.Pool,
  tenantId: string,
  email: string,
  role: 'admin' | 'agent' | 'requester',
  opts: { name?: string; password?: string; organizationId?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, crypt($3, gen_salt('bf', 10))) RETURNING id`,
    [email, opts.name ?? email.split('@')[0], opts.password ?? 'senha-123456'],
  );
  const id = rows[0]!.id;
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role, organization_id) VALUES ($1, $2, $3, $4)`, [
    tenantId,
    id,
    role,
    opts.organizationId ?? null,
  ]);
  return id;
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export interface Session {
  token: string;
  cookie: string;
  body: Record<string, unknown>;
}

export async function login(app: NestExpressApplication, email: string, password = SEED_PASSWORD): Promise<Session> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
  return { token: res.body.accessToken, cookie: refreshCookie(res), body: res.body };
}

/** Extrai `hd_rt=...` do Set-Cookie (para reenviar em /refresh e /logout). */
export function refreshCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((h) => h.startsWith('hd_rt='));
  return c ? c.split(';')[0]! : '';
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
