import type pg from 'pg';
import { API, createTestApp, demoFixtures, superPool, tokenFor, type DemoFixtures, type TestApp } from './helpers.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- corpo JSON dos testes

let t: TestApp;
let su: pg.Pool;
let fx: DemoFixtures;
let agent: string;

beforeAll(async () => {
  t = await createTestApp();
  su = superPool();
  fx = await demoFixtures(su);
  agent = await tokenFor(t, 'carlos@demo.local');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const n = async (sql: string, args: unknown[] = []) => Number((await su.query<{ n: string }>(sql, args)).rows[0]!.n);

describe('relatórios batem com contagens feitas direto no SQL do seed', () => {
  it('visão geral dos últimos 30 dias', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const r = await t.http().get(`${API}/reports/overview?from=${from.toISOString()}&to=${to.toISOString()}`)
      .set('Authorization', `Bearer ${agent}`);
    expect(r.status).toBe(200);
    const rep = r.body as Body;
    const T = fx.tenant;

    expect(rep.totals.created).toBe(await n('SELECT count(*) AS n FROM tickets WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3', [T, from, to]));
    expect(rep.totals.open).toBe(await n(
      `SELECT count(*) AS n FROM tickets t JOIN statuses s ON s.id = t.status_id
        WHERE t.tenant_id = $1 AND s.kind IN ('open','pending','on_hold')`, [T]));
    expect(rep.totals.unassigned_open).toBe(await n(
      `SELECT count(*) AS n FROM tickets t JOIN statuses s ON s.id = t.status_id
        WHERE t.tenant_id = $1 AND s.kind IN ('open','pending','on_hold') AND t.assignee_id IS NULL`, [T]));
    expect(rep.totals.resolved).toBe(await n('SELECT count(*) AS n FROM tickets WHERE tenant_id = $1 AND resolved_at >= $2 AND resolved_at < $3', [T, from, to]));

    for (const row of rep.open_by_status as Body[]) {
      expect({ status: row.status, count: row.count }).toEqual({
        status: row.status,
        count: await n('SELECT count(*) AS n FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE t.tenant_id = $1 AND s.name = $2', [T, row.status]),
      });
    }
    const carlos = (rep.by_agent as Body[]).find((a) => a.user_id === fx.users.carlos)!;
    expect(carlos.open).toBe(await n(
      `SELECT count(*) AS n FROM tickets t JOIN statuses s ON s.id = t.status_id
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND s.kind IN ('open','pending','on_hold')`, [T, fx.users.carlos]));
    const daily = (rep.daily as Body[]).reduce((a, d) => a + (d.created as number), 0);
    expect(daily).toBe(rep.totals.created);
  });

  it('cliente não acessa; período inválido => 400', async () => {
    const client = await tokenFor(t, 'joao@acme.local');
    expect((await t.http().get(`${API}/reports/overview`).set('Authorization', `Bearer ${client}`)).status).toBe(403);
    const bad = await t.http().get(`${API}/reports/overview?from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z`).set('Authorization', `Bearer ${agent}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_period');
    const long = await t.http().get(`${API}/reports/overview?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`).set('Authorization', `Bearer ${agent}`);
    expect(long.status).toBe(400);
  });
});
