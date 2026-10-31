import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { AppConfig } from '../src/config/app-config.js';
import type { Env } from '../src/config/env.js';

export const PASSWORD = 'demo1234';
export const API = '/api/v1';

export interface TestApp {
  app: NestExpressApplication;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/** Sobe a aplicação real (mesma configuração do main.ts). `overrides` troca valores da config. */
export async function createTestApp(overrides: Partial<Env> = {}): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (Object.keys(overrides).length) {
    builder.overrideProvider(AppConfig).useFactory({
      factory: (cs: ConfigService<Env, true>) => {
        const base = new AppConfig(cs);
        return { get: <K extends keyof Env>(k: K) => (k in overrides ? overrides[k] : base.get(k)) };
      },
      inject: [ConfigService],
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app);
  await app.init();
  return {
    app,
    http: () => request(app.getHttpServer() as App),
    close: () => app.close(),
  };
}

/**
 * Pool de superusuário, SÓ para preparar/limpar cenários (como db/tests). Nunca é o que a API usa.
 */
export function superPool(): pg.Pool {
  const url = process.env.PGSUPER_DB_URL;
  if (!url) throw new Error('PGSUPER_DB_URL não definido (veja .env.example)');
  return new pg.Pool({ connectionString: url, max: 2 });
}

/** Pool cru como sd_app, sem nenhum contexto — para provar a falha fechada da RLS. */
export function rawAppPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

export function refreshCookie(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const c = list.find((x) => x.startsWith('sd_rt='));
  return c?.split(';')[0];
}

export function rawSetCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? (raw as string[]) : [String(raw ?? '')]).find((x) => x.startsWith('sd_rt=')) ?? '';
}

export const uniq = () => Math.random().toString(36).slice(2, 8);

/** Faz login e devolve o access token (usuários com um único workspace). */
export async function tokenFor(t: TestApp, email: string, password = PASSWORD): Promise<string> {
  const res = await t.http().post(`${API}/auth/login`).send({ email, password });
  if (res.status !== 200 || !res.body.accessToken) throw new Error(`login falhou para ${email}: ${res.status}`);
  return res.body.accessToken as string;
}

/** Ids do workspace demo, lidos como superusuário (só para montar cenários). */
export async function demoFixtures(su: pg.Pool) {
  const one = async (sql: string, args: unknown[] = []) => {
    const { rows } = await su.query<{ id: string }>(sql, args);
    if (!rows[0]) throw new Error(`fixture ausente: ${sql} ${JSON.stringify(args)}`);
    return rows[0].id;
  };
  const tenant = await one("SELECT id FROM tenants WHERE slug = 'demo'");
  const user = (email: string) => one('SELECT id FROM users WHERE email = $1', [email]);
  const status = (name: string) => one('SELECT id FROM statuses WHERE tenant_id = $1 AND name = $2', [tenant, name]);
  const priority = (name: string) => one('SELECT id FROM priorities WHERE tenant_id = $1 AND name = $2', [tenant, name]);
  return {
    tenant,
    users: {
      admin: await user('admin@demo.local'), carlos: await user('carlos@demo.local'), bia: await user('bia@demo.local'),
      joao: await user('joao@acme.local'), maria: await user('maria@acme.local'), pedro: await user('pedro@globex.local'),
    },
    status: {
      novo: await status('Novo'), atendimento: await status('Em atendimento'), aguardando: await status('Aguardando cliente'),
      resolvido: await status('Resolvido'), fechado: await status('Fechado'),
    },
    priority: { baixa: await priority('Baixa'), normal: await priority('Normal'), alta: await priority('Alta'), urgente: await priority('Urgente') },
    category: await one("SELECT id FROM categories WHERE tenant_id = $1 AND name = 'Incidente'", [tenant]),
  };
}
export type DemoFixtures = Awaited<ReturnType<typeof demoFixtures>>;

/** Cria um workspace novo pelo cadastro público e registra o id para limpeza. */
export async function newTenant(t: TestApp, prefix: string, created: string[]) {
  const slug = `e2e-${prefix}-${uniq()}`;
  const email = `${slug}@e2e.test.local`;
  const res = await t.http().post(`${API}/auth/signup`)
    .send({ workspaceName: `E2E ${prefix}`, slug, name: `Admin ${prefix}`, email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`signup falhou: ${res.status} ${JSON.stringify(res.body)}`);
  created.push(res.body.tenantId);
  return { ...(res.body as { tenantId: string; userId: string; accessToken: string }), slug, email };
}

/** Lê da outbox (como superusuário) o token do último convite enviado para o e-mail. */
export async function invitationToken(su: pg.Pool, email: string): Promise<string> {
  const { rows } = await su.query<{ token: string }>(
    `SELECT payload->>'token' AS token FROM email_outbox WHERE template = 'invitation' AND to_email = $1 ORDER BY id DESC LIMIT 1`,
    [email],
  );
  if (!rows[0]) throw new Error(`nenhum convite na outbox para ${email}`);
  return rows[0].token;
}

/** Convida (como admin) e aceita o convite; devolve a resposta do aceite. */
export async function inviteAndAccept(t: TestApp, su: pg.Pool, adminToken: string, email: string, role: string) {
  const inv = await t.http().post(`${API}/invitations`).set('Authorization', `Bearer ${adminToken}`).send({ email, role });
  if (inv.status !== 201) throw new Error(`convite falhou: ${inv.status} ${JSON.stringify(inv.body)}`);
  const token = await invitationToken(su, email);
  return t.http().post(`${API}/auth/accept-invite`).send({ token, name: `Pessoa ${role}`, password: PASSWORD });
}
