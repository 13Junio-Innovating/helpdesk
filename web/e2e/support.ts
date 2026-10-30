import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { expect, type Page } from '@playwright/test';

const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DOMAIN = 'e2e.test.local';
export const API = 'http://localhost:3000/api/v1';
export const PW = 'senha-forte-123';

/** Superusuário: só para preparar/inspecionar cenários (ler tokens da outbox, limpar dados de teste). */
export const db = new pg.Pool({ connectionString: process.env['PGSUPER_DB_URL'], max: 2 });

export async function cleanup(): Promise<void> {
  await db.query(`SELECT delete_tenant(t.id) FROM tenants t WHERE t.slug LIKE 'e2e-%'`);
  await db.query(`DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%@${DOMAIN}`]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
  await db.query(`DELETE FROM email_outbox WHERE to_email LIKE $1`, [`%@${DOMAIN}`]);
  await db.query(`DELETE FROM plans WHERE id LIKE 'e2e-%'`);
}

/** Chamada direta à API (setup dos cenários, papel da equipe). */
export async function call<T = Record<string, unknown>>(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

export async function apiLogin(email: string, password: string): Promise<string> {
  return (await call<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email, password } })).accessToken;
}

/** Workspace novo (admin) direto pela API. */
export async function createWorkspace(slug: string, adminEmail: string): Promise<{ token: string; tenantId: string }> {
  const r = await call<{ accessToken: string }>('/auth/signup', {
    method: 'POST',
    body: { workspaceName: `Empresa ${slug}`, slug, name: 'Admin Teste', email: adminEmail, password: PW },
  });
  const me = await call<{ tenant: { id: string } }>('/auth/me', { token: r.accessToken });
  return { token: r.accessToken, tenantId: me.tenant.id };
}

export async function lastToken(template: 'invitation' | 'password_reset', email: string): Promise<string> {
  const { rows } = await db.query<{ token: string }>(
    `SELECT payload->>'token' AS token FROM email_outbox WHERE template = $1 AND to_email = $2 ORDER BY id DESC LIMIT 1`,
    [template, email],
  );
  if (!rows[0]) throw new Error(`nenhum e-mail ${template} para ${email}`);
  return rows[0].token;
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export async function uiLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

export async function uiLogout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu da conta' }).click();
  await page.getByRole('menuitem', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
}
