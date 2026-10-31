import type pg from 'pg';
import { DbService } from '../src/common/db/db.service.js';
import { API, createTestApp, demoFixtures, PASSWORD, superPool, tokenFor, uniq, type DemoFixtures, type TestApp } from './helpers.js';

let t: TestApp;
let su: pg.Pool;
let fx: DemoFixtures;
const tok: Record<'admin' | 'carlos' | 'bia' | 'joao' | 'maria', string> = {} as never;
const createdTickets: string[] = [];
const createdTenants: string[] = [];
const createdPlans: string[] = [];

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- corpo JSON dos testes

const get = (token: string, path: string) => t.http().get(`${API}${path}`).set('Authorization', `Bearer ${token}`);
const post = (token: string, path: string, body: object) => t.http().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);
const patch = (token: string, path: string, body: object) => t.http().patch(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);

async function createTicket(token: string, body: object): Promise<Body> {
  const res = await post(token, '/tickets', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  createdTickets.push(res.body.id);
  return res.body;
}

async function listAll(token: string, query: string): Promise<Body[]> {
  const items: Body[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const res = await get(token, `/tickets?${query}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    items.push(...res.body.items);
    cursor = res.body.nextCursor;
    if (!cursor) return items;
  }
  throw new Error('paginação não terminou');
}

const count = async (sql: string, args: unknown[]) => Number((await su.query<{ n: string }>(sql, args)).rows[0]!.n);

async function newTenant(prefix: string) {
  const slug = `e2e-${prefix}-${uniq()}`;
  const res = await t.http().post(`${API}/auth/signup`)
    .send({ workspaceName: `E2E ${prefix}`, slug, name: 'Admin', email: `${slug}@e2e.test.local`, password: PASSWORD });
  expect(res.status).toBe(201);
  createdTenants.push(res.body.tenantId);
  return res.body as { tenantId: string; userId: string; accessToken: string };
}

beforeAll(async () => {
  t = await createTestApp();
  su = superPool();
  fx = await demoFixtures(su);
  for (const [k, email] of [['admin', 'admin@demo.local'], ['carlos', 'carlos@demo.local'], ['bia', 'bia@demo.local'],
    ['joao', 'joao@acme.local'], ['maria', 'maria@acme.local']] as const) tok[k] = await tokenFor(t, email);
});

afterAll(async () => {
  await su.query(`DELETE FROM email_outbox WHERE payload->>'ticket_id' = ANY($1)`, [createdTickets]);
  await su.query('DELETE FROM tickets WHERE id = ANY($1)', [createdTickets]);
  for (const id of createdTenants) await su.query('SELECT delete_tenant($1)', [id]);
  await su.query('DELETE FROM plans WHERE id = ANY($1)', [createdPlans]);
  await su.end();
  await t.close();
});

describe('listagem', () => {
  it('agente vê todos os chamados do workspace; cliente só os seus', async () => {
    const all = await listAll(tok.carlos, 'limit=100');
    expect(all.length).toBe(await count('SELECT count(*) AS n FROM tickets WHERE tenant_id = $1', [fx.tenant]));

    const mine = await listAll(tok.joao, 'limit=100');
    expect(mine.length).toBe(await count('SELECT count(*) AS n FROM tickets WHERE tenant_id = $1 AND requester_id = $2', [fx.tenant, fx.users.joao]));
    expect(mine.length).toBeGreaterThan(0);
    for (const tk of mine) {
      expect(tk.requester.id).toBe(fx.users.joao);
      // dados internos não vão para o cliente
      for (const k of ['sla', 'tags', 'queue', 'customFields', 'organization']) expect(tk).not.toHaveProperty(k);
    }
  });

  it.each(['updated', 'created', 'priority', 'due'])('paginação por cursor (sort=%s) percorre tudo sem repetir', async (sort) => {
    const pages = await listAll(tok.carlos, `limit=3&sort=${sort}`);
    const ids = pages.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(await count('SELECT count(*) AS n FROM tickets WHERE tenant_id = $1', [fx.tenant]));
    if (sort === 'priority') {
      const levels = pages.map((x) => x.priority.level as number);
      expect(levels).toEqual(levels.toSorted((a, b) => b - a));
    }
    if (sort === 'created') {
      const ts = pages.map((x) => Date.parse(x.createdAt));
      expect(ts).toEqual(ts.toSorted((a, b) => b - a));
    }
  });

  it('filtros de status, responsável, SLA, tag e período', async () => {
    const unresolved = await listAll(tok.carlos, 'status=unresolved&limit=100');
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((x) => ['open', 'pending', 'on_hold'].includes(x.status.kind))).toBe(true);

    const byId = await listAll(tok.carlos, `status=${fx.status.aguardando}`);
    expect(byId.length).toBeGreaterThan(0);
    expect(byId.every((x) => x.status.name === 'Aguardando cliente')).toBe(true);

    const meus = await listAll(tok.carlos, 'assignee=me');
    expect(meus.length).toBeGreaterThan(0);
    expect(meus.every((x) => x.assignee?.id === fx.users.carlos)).toBe(true);
    expect((await listAll(tok.carlos, 'assignee=none')).every((x) => x.assignee === null)).toBe(true);

    const breached = await listAll(tok.carlos, 'sla=breached');
    expect(breached.length).toBeGreaterThan(0);
    expect(breached.every((x) => Object.values(x.sla as Body).some((s) => s.state === 'breached'))).toBe(true);
    expect((await listAll(tok.carlos, 'sla=paused')).every((x) => Object.values(x.sla as Body).some((s) => s.state === 'paused'))).toBe(true);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await listAll(tok.carlos, `createdFrom=${future}`)).toEqual([]);
  });

  it('busca full-text em português: "impressoras" acha "Impressora do financeiro"', async () => {
    const found = await listAll(tok.carlos, 'q=impressoras');
    expect(found.map((x) => x.subject)).toContain('Impressora do financeiro não imprime');
    // por número e por trecho do assunto (fallback ILIKE)
    const n = found.find((x) => x.subject.startsWith('Impressora'))!.number;
    expect((await listAll(tok.carlos, `q=%23${n}`)).map((x) => x.number)).toContain(n);
    expect((await listAll(tok.carlos, 'q=financ')).length).toBeGreaterThan(0);
    // curingas do usuário são texto literal
    expect(await listAll(tok.carlos, 'q=%25%25%25')).toEqual([]);
  });

  it('parâmetros inválidos => 400', async () => {
    for (const q of ['status=nada', 'limit=101', 'sort=hack', 'cursor=xyz', 'assignee=1;drop', 'foo=1', 'sla=x']) {
      const r = await get(tok.carlos, `/tickets?${q}`);
      expect({ q, status: r.status }).toEqual({ q, status: 400 });
    }
  });
});

describe('abertura de chamado', () => {
  it('cliente abre chamado: vira solicitante, com status e prioridade padrão', async () => {
    const tk = await createTicket(tok.joao, { subject: 'Mouse parou', description: 'Não clica', categoryId: fx.category });
    expect(tk.requester.id).toBe(fx.users.joao);
    expect(tk.status.name).toBe('Novo');
    expect(tk.priority.name).toBe('Normal');
    expect(tk.category.id).toBe(fx.category);
    expect(tk.number).toBeGreaterThan(0);
  });

  it('cliente não define prioridade, responsável, status nem solicitante (403)', async () => {
    for (const extra of [{ priorityId: fx.priority.urgente }, { assigneeId: fx.users.carlos }, { statusId: fx.status.resolvido }, { requesterId: fx.users.maria }]) {
      const r = await post(tok.joao, '/tickets', { subject: 'Tentativa', ...extra });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('field_not_allowed');
    }
  });

  it('e o banco garante o mesmo mesmo se a API deixasse passar', async () => {
    const db = t.app.get(DbService);
    const row = await db.withTenant({ tenantId: fx.tenant, userId: fx.users.joao }, async (c) => {
      const { rows } = await c.query<{ id: string; priority_id: string; assignee_id: string | null; status_id: string }>(
        `INSERT INTO tickets (tenant_id, subject, requester_id, priority_id, assignee_id, status_id)
         VALUES ($1, 'direto no banco', $2, $3, $4, $5) RETURNING id, priority_id, assignee_id, status_id`,
        [fx.tenant, fx.users.joao, fx.priority.urgente, fx.users.carlos, fx.status.resolvido],
      );
      return rows[0]!;
    });
    createdTickets.push(row.id);
    expect(row).toMatchObject({ priority_id: fx.priority.normal, assignee_id: null, status_id: fx.status.novo });
  });

  it('agente abre em nome do cliente com prioridade e responsável', async () => {
    const tk = await createTicket(tok.carlos, {
      subject: 'Aberto por telefone', requesterId: fx.users.maria, priorityId: fx.priority.alta,
      assigneeId: fx.users.bia, channel: 'phone', tags: [' VIP ', 'vip', 'Financeiro'],
    });
    expect(tk).toMatchObject({ channel: 'phone', priority: { name: 'Alta' }, assignee: { id: fx.users.bia }, requester: { id: fx.users.maria } });
    expect(tk.organization.name).toBe('ACME Indústria'); // padrão do vínculo do cliente
    expect(tk.tags).toEqual(['vip', 'financeiro']);
    expect(tk.sla.first_response.state).toBe('running');
  });

  it('responsável precisa ser da equipe (422) e referência de outro tenant é recusada (422)', async () => {
    const r = await post(tok.carlos, '/tickets', { subject: 'x', requesterId: fx.users.maria, assigneeId: fx.users.joao });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('assignee_must_be_staff');

    const other = await newTenant('ref');
    const { rows } = await su.query<{ id: string }>('SELECT id FROM categories WHERE tenant_id = $1 LIMIT 1', [other.tenantId]);
    const r2 = await post(tok.carlos, '/tickets', { subject: 'x', categoryId: rows[0]!.id });
    expect(r2.status).toBe(422);
    expect(r2.body).toEqual({ code: 'invalid_reference', message: expect.any(String) });
  });
});

describe('detalhe, permissões e conversa', () => {
  it('cliente não enxerga chamado de outro cliente (404 em ler, alterar e responder)', async () => {
    const deMaria = await createTicket(tok.maria, { subject: 'Da Maria' });
    expect((await get(tok.joao, `/tickets/${deMaria.id}`)).status).toBe(404);
    expect((await patch(tok.joao, `/tickets/${deMaria.id}`, { subject: 'invadido' })).status).toBe(404);
    expect((await post(tok.joao, `/tickets/${deMaria.id}/messages`, { kind: 'public_reply', body: 'oi' })).status).toBe(404);
    expect((await listAll(tok.joao, 'limit=100')).map((x) => x.id)).not.toContain(deMaria.id);
  });

  it('cliente não altera o próprio chamado (RLS => 403)', async () => {
    const tk = await createTicket(tok.joao, { subject: 'Meu chamado' });
    for (const body of [{ priorityId: fx.priority.urgente }, { assigneeId: fx.users.carlos }, { subject: 'novo assunto' }]) {
      const r = await patch(tok.joao, `/tickets/${tk.id}`, body);
      expect(r.status).toBe(403);
    }
    const again = await get(tok.carlos, `/tickets/${tk.id}`);
    expect(again.body).toMatchObject({ subject: 'Meu chamado', priority: { name: 'Normal' }, assignee: null });
  });

  it('nota interna: cliente nunca vê e não consegue escrever', async () => {
    const tk = await createTicket(tok.joao, { subject: 'Com nota interna' });
    expect((await post(tok.carlos, `/tickets/${tk.id}/messages`, { kind: 'internal_note', body: 'cliente difícil' })).status).toBe(201);
    expect((await post(tok.carlos, `/tickets/${tk.id}/messages`, { kind: 'public_reply', body: 'Olá, João!' })).status).toBe(201);

    const staffView = await get(tok.carlos, `/tickets/${tk.id}`);
    expect(staffView.body.messages.map((m: Body) => m.kind)).toEqual(['internal_note', 'public_reply']);
    expect(staffView.body.events.length).toBeGreaterThan(0);

    const clientView = await get(tok.joao, `/tickets/${tk.id}`);
    expect(clientView.status).toBe(200);
    expect(clientView.body.messages.map((m: Body) => m.body)).toEqual(['Olá, João!']);
    expect(JSON.stringify(clientView.body)).not.toContain('cliente difícil');
    for (const k of ['events', 'sla', 'timeLoggedMinutes', 'tags']) expect(clientView.body).not.toHaveProperty(k);

    const sneak = await post(tok.joao, `/tickets/${tk.id}/messages`, { kind: 'internal_note', body: 'posso?' });
    expect(sneak.status).toBe(403);
    expect(sneak.body.code).toBe('forbidden');
  });

  it('primeira resposta pública da equipe cumpre o SLA de primeira resposta', async () => {
    const tk = await createTicket(tok.joao, { subject: 'Primeira resposta' });
    const r = await post(tok.bia, `/tickets/${tk.id}/messages`, { kind: 'public_reply', body: 'Recebido!' });
    expect(r.body.ticket.firstResponseAt).not.toBeNull();
    expect(r.body.ticket.sla.first_response.state).toBe('met');
    expect(r.body.ticket.sla.resolution.state).toBe('running');
  });

  it('"Aguardando cliente" pausa o SLA e a resposta do cliente reabre', async () => {
    const tk = await createTicket(tok.carlos, { subject: 'Pausa de SLA', requesterId: fx.users.joao });
    const p = await patch(tok.carlos, `/tickets/${tk.id}`, { statusId: fx.status.aguardando, assigneeId: fx.users.carlos });
    expect(p.status).toBe(200);
    expect(p.body.status.name).toBe('Aguardando cliente');

    const paused = await get(tok.carlos, `/tickets/${tk.id}`);
    expect(paused.body.sla.resolution.state).toBe('paused');
    expect(paused.body.sla.first_response.state).toBe('paused');
    expect(paused.body.sla.resolution.minutesRemaining).toBeNull();
    expect((await listAll(tok.carlos, 'sla=paused')).map((x) => x.id)).toContain(tk.id);

    const reply = await post(tok.joao, `/tickets/${tk.id}/messages`, { kind: 'public_reply', body: 'Segue o print.' });
    expect(reply.status).toBe(201);
    expect(reply.body.ticket.status.name).toBe('Novo');

    const resumed = await get(tok.carlos, `/tickets/${tk.id}`);
    expect(resumed.body.sla.resolution.state).toBe('running');
    expect(resumed.body.events.map((e: Body) => e.type)).toEqual(expect.arrayContaining(['created', 'status_changed', 'assigned']));
  });

  it('resolver e reabrir pelo cliente', async () => {
    const tk = await createTicket(tok.carlos, { subject: 'Resolver e reabrir', requesterId: fx.users.joao });
    const res = await patch(tok.carlos, `/tickets/${tk.id}`, { statusId: fx.status.resolvido });
    expect(res.body.resolvedAt).not.toBeNull();
    const again = await post(tok.joao, `/tickets/${tk.id}/messages`, { kind: 'public_reply', body: 'Voltou a dar erro' });
    expect(again.body.ticket.status.name).toBe('Novo');
    expect(again.body.ticket.resolvedAt).toBeNull();
  });

  it('PATCH altera vários campos de uma vez; vazio => 400; id inválido => 400', async () => {
    const tk = await createTicket(tok.carlos, { subject: 'Lote de campos', requesterId: fx.users.maria });
    const r = await patch(tok.carlos, `/tickets/${tk.id}`, {
      subject: 'Lote de campos (editado)', priorityId: fx.priority.urgente, assigneeId: fx.users.bia, tags: ['x'], categoryId: null,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ subject: 'Lote de campos (editado)', priority: { name: 'Urgente' }, assignee: { id: fx.users.bia }, tags: ['x'], category: null });
    expect((await patch(tok.carlos, `/tickets/${tk.id}`, {})).body.code).toBe('nothing_to_update');
    expect((await patch(tok.carlos, `/tickets/${tk.id}`, { number: 1 })).status).toBe(400);
    expect((await get(tok.carlos, '/tickets/nao-e-uuid')).status).toBe(400);
    expect((await get(tok.carlos, '/tickets/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('ações em lote', () => {
  it('atribui e etiqueta vários chamados numa transação', async () => {
    const a = await createTicket(tok.carlos, { subject: 'Lote A', requesterId: fx.users.maria });
    const b = await createTicket(tok.carlos, { subject: 'Lote B', requesterId: fx.users.maria, tags: ['velha'] });
    const ghost = '00000000-0000-4000-8000-000000000000';
    const r = await post(tok.carlos, '/tickets/bulk', { ids: [a.id, b.id, ghost], changes: { assigneeId: fx.users.bia, addTags: ['lote'] } });
    expect(r.status).toBe(201);
    expect(r.body.updated.toSorted()).toEqual([a.id, b.id].toSorted());
    expect(r.body.notFound).toEqual([ghost]);
    const b2 = await get(tok.carlos, `/tickets/${b.id}`);
    expect(b2.body.assignee.id).toBe(fx.users.bia);
    expect(b2.body.tags).toEqual(['lote', 'velha']);
  });

  it('erro em um chamado desfaz o lote inteiro', async () => {
    const a = await createTicket(tok.carlos, { subject: 'Lote atômico', requesterId: fx.users.maria });
    const r = await post(tok.carlos, '/tickets/bulk', { ids: [a.id], changes: { assigneeId: fx.users.joao } });
    expect(r.status).toBe(422);
    expect((await get(tok.carlos, `/tickets/${a.id}`)).body.assignee).toBeNull();
  });

  it('cliente não usa ações em lote', async () => {
    expect((await post(tok.joao, '/tickets/bulk', { ids: [fx.tenant], changes: { statusId: fx.status.fechado } })).status).toBe(403);
  });
});

describe('apontamento de horas', () => {
  it('equipe aponta, lista e apaga; cliente não', async () => {
    const tk = await createTicket(tok.carlos, { subject: 'Horas', requesterId: fx.users.joao });
    const e1 = await post(tok.carlos, `/tickets/${tk.id}/time-entries`, { minutes: 30, note: 'diagnóstico' });
    expect(e1.status).toBe(201);
    expect(e1.body).toMatchObject({ minutes: 30, note: 'diagnóstico', user: { id: fx.users.carlos } });
    expect(e1.body.workedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await post(tok.bia, `/tickets/${tk.id}/time-entries`, { minutes: 15, workedOn: '2026-10-01' }).expect(201);

    const list = await get(tok.carlos, `/tickets/${tk.id}/time-entries`);
    expect(list.body.totalMinutes).toBe(45);
    expect((await get(tok.carlos, `/tickets/${tk.id}`)).body.timeLoggedMinutes).toBe(45);

    expect((await post(tok.joao, `/tickets/${tk.id}/time-entries`, { minutes: 10 })).status).toBe(403);
    expect((await get(tok.joao, `/tickets/${tk.id}/time-entries`)).status).toBe(403);
    expect((await post(tok.carlos, `/tickets/${tk.id}/time-entries`, { minutes: 2000 })).status).toBe(400);

    const del = () => t.http().delete(`${API}/time-entries/${e1.body.id}`).set('Authorization', `Bearer ${tok.carlos}`);
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
  });
});

describe('limites do plano e tenant inativo', () => {
  it('cota mensal de chamados => 402 ticket_quota_exceeded', async () => {
    const tn = await newTenant('quota');
    const plan = `e2e-quota-${uniq()}`;
    createdPlans.push(plan);
    await su.query("INSERT INTO plans (id, name, price_cents, max_agents, max_tickets_per_month) VALUES ($1, 'Quota', 0, 5, 2)", [plan]);
    await su.query('UPDATE tenants SET plan_id = $2 WHERE id = $1', [tn.tenantId, plan]);

    await post(tn.accessToken, '/tickets', { subject: 'um' }).expect(201);
    await post(tn.accessToken, '/tickets', { subject: 'dois' }).expect(201);
    const r = await post(tn.accessToken, '/tickets', { subject: 'três' });
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ code: 'ticket_quota_exceeded', message: 'O limite de chamados do seu plano neste mês foi atingido.' });
  });

  it('workspace suspenso não abre chamado => 402 tenant_inactive', async () => {
    const tn = await newTenant('susp');
    await su.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tn.tenantId]);
    const r = await post(tn.accessToken, '/tickets', { subject: 'bloqueado' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('tenant_inactive');
  });
});

describe('isolamento entre tenants nos chamados', () => {
  it('admin de outro workspace não lê, não altera e não responde chamados do demo', async () => {
    const other = await newTenant('cross');
    const { rows } = await su.query<{ id: string }>('SELECT id FROM tickets WHERE tenant_id = $1 LIMIT 1', [fx.tenant]);
    const demoTicket = rows[0]!.id;
    expect((await get(other.accessToken, `/tickets/${demoTicket}`)).status).toBe(404);
    expect((await patch(other.accessToken, `/tickets/${demoTicket}`, { subject: 'x' })).status).toBe(404);
    expect((await post(other.accessToken, `/tickets/${demoTicket}/messages`, { kind: 'public_reply', body: 'x' })).status).toBe(404);
    expect((await post(other.accessToken, `/tickets/${demoTicket}/time-entries`, { minutes: 5 })).status).toBe(404);
    const bulk = await post(other.accessToken, '/tickets/bulk', { ids: [demoTicket], changes: { addTags: ['x'] } });
    expect(bulk.body).toEqual({ updated: [], notFound: [demoTicket] });
    expect((await listAll(other.accessToken, 'limit=100')).length).toBe(0);
    // e não consegue apontar o demo como referência ao abrir chamado no próprio workspace
    const r = await post(other.accessToken, '/tickets', { subject: 'x', requesterId: fx.users.joao });
    // FK composta (tenant_id, requester_id): o solicitante precisa ser membro DESTE workspace
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('invalid_reference');
  });
});
