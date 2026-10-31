import type pg from 'pg';
import {
  API, createTestApp, inviteAndAccept, invitationToken, newTenant, PASSWORD, superPool, uniq, type TestApp,
} from './helpers.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- corpo JSON dos testes

let t: TestApp;
let su: pg.Pool;
const tenants: string[] = [];
const plans: string[] = [];
const extraEmails: string[] = [];

/** Workspace com admin, agente e cliente (todos entrando por convite, como na vida real). */
let ws: { tenantId: string; admin: string; agent: string; client: string; agentId: string; clientId: string };

const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', token: string, path: string, body?: object) => {
  const r = t.http()[method](`${API}${path}`).set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};

beforeAll(async () => {
  t = await createTestApp();
  su = superPool();
  const a = await newTenant(t, 'cat', tenants);
  const agent = await inviteAndAccept(t, su, a.accessToken, `agente-${a.slug}@e2e.test.local`, 'agent');
  const client = await inviteAndAccept(t, su, a.accessToken, `cliente-${a.slug}@e2e.test.local`, 'requester');
  expect(agent.status).toBe(201);
  expect(client.status).toBe(201);
  ws = {
    tenantId: a.tenantId, admin: a.accessToken,
    agent: agent.body.accessToken, client: client.body.accessToken,
    agentId: agent.body.userId, clientId: client.body.userId,
  };
});

afterAll(async () => {
  for (const id of tenants) await su.query('SELECT delete_tenant($1)', [id]);
  await su.query('DELETE FROM plans WHERE id = ANY($1)', [plans]);
  await su.query(`DELETE FROM email_outbox WHERE tenant_id IS NULL AND to_email LIKE '%e2e.test.local'`);
  await su.query('DELETE FROM users WHERE email = ANY($1)', [extraEmails]);
  await su.end();
  await t.close();
});

describe('catálogo: só admin altera', () => {
  // terceiro elemento: o cliente nem enxerga o recurso (só equipe lê) => 404 em vez de 403
  const resources: [string, object, object, boolean?][] = [
    ['queues', { name: 'N2' }, { description: 'Segundo nível' }],
    ['categories', { name: 'Hardware' }, { active: false }],
    ['priorities', { name: 'Crítica', level: 5, color: '#ff0000' }, { level: 6 }],
    ['statuses', { name: 'Em análise', kind: 'open', position: 9 }, { slaPauses: true }],
    ['business-hours', { name: 'Plantão', timezone: 'America/Manaus' }, { name: 'Plantão 24h' }, true],
    ['sla-policies', { name: 'SLA Ouro', firstResponseMinutes: 15, resolutionMinutes: 120 }, { active: false }, true],
  ];

  it.each(resources)('%s: admin cria/edita/apaga; agente e cliente recebem 403', async (path, create, patch, staffOnly) => {
    for (const tok of [ws.agent, ws.client]) {
      const r = await call('post', tok, `/${path}`, create);
      expect({ path, status: r.status, code: r.body.code }).toEqual({ path, status: 403, code: 'forbidden' });
    }
    const created = await call('post', ws.admin, `/${path}`, create);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;

    for (const [tok, expected] of [[ws.agent, 403], [ws.client, staffOnly ? 404 : 403]] as const) {
      expect((await call('patch', tok, `/${path}/${id}`, patch)).status).toBe(expected);
      expect((await call('delete', tok, `/${path}/${id}`)).status).toBe(expected);
    }
    const updated = await call('patch', ws.admin, `/${path}/${id}`, patch);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject(patch);
    expect((await call('get', ws.agent, `/${path}/${id}`)).status).toBe(200); // equipe lê

    expect((await call('delete', ws.admin, `/${path}/${id}`)).status).toBe(204);
    expect((await call('get', ws.admin, `/${path}/${id}`)).status).toBe(404);
  });

  it('leitura: cliente vê status/prioridades/categorias, mas não SLA nem horário comercial', async () => {
    for (const path of ['statuses', 'priorities', 'categories', 'queues']) {
      const r = await call('get', ws.client, `/${path}`);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
      expect(r.body.length).toBeGreaterThan(0);
    }
    for (const path of ['sla-policies', 'business-hours', 'automation-rules']) {
      expect((await call('get', ws.client, `/${path}`)).status).toBe(403);
      expect((await call('get', ws.agent, `/${path}`)).status).toBe(200);
    }
  });

  it('padrão único: marcar outra prioridade como padrão desmarca a anterior; não dá para ficar sem', async () => {
    const list = (await call('get', ws.admin, '/priorities')).body as Body[];
    const oldDefault = list.find((p) => p.isDefault)!;
    const alta = list.find((p) => p.name === 'Alta')!;
    expect((await call('patch', ws.admin, `/priorities/${alta.id}`, { isDefault: true })).body.isDefault).toBe(true);
    const after = (await call('get', ws.admin, '/priorities')).body as Body[];
    expect(after.filter((p) => p.isDefault).map((p) => p.id)).toEqual([alta.id]);

    const unset = await call('patch', ws.admin, `/priorities/${alta.id}`, { isDefault: false });
    expect(unset.status).toBe(422);
    expect(unset.body.code).toBe('default_required');
    expect((await call('delete', ws.admin, `/priorities/${alta.id}`)).body.code).toBe('default_required');
    await call('patch', ws.admin, `/priorities/${oldDefault.id}`, { isDefault: true }).expect(200);
  });

  it('status em uso não pode ser apagado (409 in_use); validação e fuso inválido (400)', async () => {
    await call('post', ws.admin, '/tickets', { subject: 'usa o status padrão' }).expect(201);
    const novo = ((await call('get', ws.admin, '/statuses')).body as Body[]).find((s) => s.name === 'Em atendimento')!;
    const tk = await call('post', ws.admin, '/tickets', { subject: 'em atendimento', statusId: novo.id });
    expect(tk.status).toBe(201);
    const del = await call('delete', ws.admin, `/statuses/${novo.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('in_use');

    expect((await call('post', ws.admin, '/statuses', { name: 'x', kind: 'nope' })).status).toBe(400);
    expect((await call('post', ws.admin, '/business-hours', { name: 'x', timezone: 'Marte/Olympus' })).status).toBe(400);
    expect((await call('post', ws.admin, '/priorities', { name: 'Normal', level: 2 })).body.code).toBe('conflict');
  });

  it('horário comercial: faixas e feriados', async () => {
    const bh = (await call('post', ws.admin, '/business-hours', { name: `BH ${uniq()}` })).body as Body;
    const slots = [{ weekday: 1, start: '08:00', end: '12:00' }, { weekday: 1, start: '13:00', end: '18:00' }];
    const set = await call('put', ws.admin, `/business-hours/${bh.id}/slots`, { slots });
    expect(set.status).toBe(200);
    expect(set.body.slots).toEqual(slots);

    const overlap = await call('put', ws.admin, `/business-hours/${bh.id}/slots`, { slots: [...slots, { weekday: 1, start: '11:00', end: '14:00' }] });
    expect(overlap.body.code).toBe('slots_overlap');
    expect((await call('put', ws.agent, `/business-hours/${bh.id}/slots`, { slots: [] })).status).toBe(403);

    const hol = await call('post', ws.admin, `/business-hours/${bh.id}/holidays`, { date: '2026-12-25', name: 'Natal' });
    expect(hol.body.holidays).toEqual([{ date: '2026-12-25', name: 'Natal' }]);
    expect((await call('delete', ws.agent, `/business-hours/${bh.id}/holidays/2026-12-25`)).status).toBe(403);
    expect((await call('delete', ws.admin, `/business-hours/${bh.id}/holidays/2026-12-25`)).status).toBe(204);
    expect((await call('get', ws.agent, `/business-hours/${bh.id}/schedule`)).body.holidays).toEqual([]);
  });

  it('filas: membros só da equipe', async () => {
    const q = (await call('post', ws.admin, '/queues', { name: `Fila ${uniq()}` })).body as Body;
    expect((await call('put', ws.admin, `/queues/${q.id}/members`, { userIds: [ws.agentId, ws.clientId] })).body.code)
      .toBe('queue_member_must_be_staff');
    await call('put', ws.admin, `/queues/${q.id}/members`, { userIds: [ws.agentId] }).expect(200);
    expect(((await call('get', ws.agent, `/queues/${q.id}/members`)).body as Body[]).map((m) => m.id)).toEqual([ws.agentId]);
    expect((await call('put', ws.agent, `/queues/${q.id}/members`, { userIds: [] })).status).toBe(403);
  });
});

describe('automações', () => {
  const rule = { name: 'VIP', event: 'ticket_created', conditions: [{ field: 'subject', op: 'contains', value: 'urgente' }],
    actions: [{ type: 'add_tag', value: 'VIP ' }] };

  it('plano Starter não tem automações (402); no Pro funciona', async () => {
    const r = await call('post', ws.admin, '/automation-rules', rule);
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('plan_feature_unavailable');

    await su.query("UPDATE tenants SET plan_id = 'pro' WHERE id = $1", [ws.tenantId]);
    const ok = await call('post', ws.admin, '/automation-rules', rule);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.actions).toEqual([{ type: 'add_tag', value: 'vip' }]);
    expect((await call('post', ws.agent, '/automation-rules', rule)).status).toBe(403);
  });

  it('formato e referências validados', async () => {
    const bad = await call('post', ws.admin, '/automation-rules', { ...rule, conditions: [{ field: 'password', op: 'eq', value: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_failed');
    expect((await call('post', ws.admin, '/automation-rules', { ...rule, actions: [] })).status).toBe(400);
    const ghost = await call('post', ws.admin, '/automation-rules',
      { ...rule, actions: [{ type: 'assign_queue', queue_id: '00000000-0000-4000-8000-000000000000' }] });
    expect(ghost.status).toBe(422);
    const notStaff = await call('post', ws.admin, '/automation-rules', { ...rule, actions: [{ type: 'assign_agent', user_id: ws.clientId }] });
    expect(notStaff.status).toBe(422);
  });
});

describe('convites', () => {
  it('token é de uso único', async () => {
    const email = `uso-unico-${uniq()}@e2e.test.local`;
    await call('post', ws.admin, '/invitations', { email, role: 'requester' }).expect(201);
    const token = await invitationToken(su, email);
    const first = await t.http().post(`${API}/auth/accept-invite`).send({ token, name: 'Primeira', password: PASSWORD });
    expect(first.status).toBe(201);
    expect(first.body.tenantId).toBe(ws.tenantId);
    const again = await t.http().post(`${API}/auth/accept-invite`).send({ token, name: 'De novo', password: PASSWORD });
    expect(again.status).toBe(410);
    expect(again.body.code).toBe('invitation_invalid');
    // quem aceitou entra com a senha escolhida
    expect((await t.http().post(`${API}/auth/login`).send({ email, password: PASSWORD })).status).toBe(200);
  });

  it('convite expirado => 410; convite revogado => 410; novo convite invalida o anterior', async () => {
    const email = `expira-${uniq()}@e2e.test.local`;
    const inv = await call('post', ws.admin, '/invitations', { email, role: 'requester' });
    const token = await invitationToken(su, email);
    await su.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [inv.body.id]);
    expect((await t.http().post(`${API}/auth/accept-invite`).send({ token, name: 'Fulano', password: PASSWORD })).status).toBe(410);

    const inv2 = await call('post', ws.admin, '/invitations', { email, role: 'requester' });
    const token2 = await invitationToken(su, email);
    await call('post', ws.admin, '/invitations', { email, role: 'requester' }).expect(201); // substitui o inv2
    expect((await t.http().post(`${API}/auth/accept-invite`).send({ token: token2, name: 'Fulano', password: PASSWORD })).status).toBe(410);

    const pending = (await call('get', ws.admin, '/invitations')).body as Body[];
    const current = pending.find((i) => i.email === email)!;
    expect(current.id).not.toBe(inv2.body.id);
    await call('delete', ws.admin, `/invitations/${current.id}`).expect(204);
    const token3 = await invitationToken(su, email);
    expect((await t.http().post(`${API}/auth/accept-invite`).send({ token: token3, name: 'Fulano', password: PASSWORD })).status).toBe(410);
  });

  it('só admin convida; quem já é membro não é convidado de novo', async () => {
    expect((await call('post', ws.agent, '/invitations', { email: `x-${uniq()}@e2e.test.local`, role: 'agent' })).status).toBe(403);
    expect((await call('get', ws.agent, '/invitations')).status).toBe(403);
    const dup = await call('post', ws.admin, '/invitations', { email: `agente-${(await me(ws.admin)).tenant.slug}@e2e.test.local`, role: 'agent' });
    expect(dup.body.code).toBe('already_member');
  });

  it('limite de agentes do plano => 402 (no aceite e na promoção)', async () => {
    const s = await newTenant(t, 'lim', tenants);
    const plan = `e2e-ag-${uniq()}`;
    plans.push(plan);
    await su.query("INSERT INTO plans (id, name, price_cents, max_agents, max_tickets_per_month) VALUES ($1, 'Lim', 0, 2, NULL)", [plan]);
    await su.query('UPDATE tenants SET plan_id = $2 WHERE id = $1', [s.tenantId, plan]);

    expect((await inviteAndAccept(t, su, s.accessToken, `ag1-${s.slug}@e2e.test.local`, 'agent')).status).toBe(201);
    const over = await inviteAndAccept(t, su, s.accessToken, `ag2-${s.slug}@e2e.test.local`, 'agent');
    expect(over.status).toBe(402);
    expect(over.body.code).toBe('agent_limit_reached');

    const cli = await inviteAndAccept(t, su, s.accessToken, `cli-${s.slug}@e2e.test.local`, 'requester');
    const promote = await call('patch', s.accessToken, `/members/${cli.body.userId}`, { role: 'agent' });
    expect(promote.status).toBe(402);
    expect(promote.body.code).toBe('agent_limit_reached');

    const usage = (await call('get', s.accessToken, '/tenant')).body;
    expect(usage.usage.agents).toEqual({ used: 2, limit: 2 });
  });
});

describe('equipe e clientes', () => {
  it('admin altera papel/ativo; desativado perde acesso; não pode sobrar sem admin', async () => {
    const members = (await call('get', ws.admin, '/members?limit=100')).body.items as Body[];
    expect(members.map((m) => m.role).toSorted()).toEqual(expect.arrayContaining(['admin', 'agent', 'requester']));
    expect((await call('get', ws.client, '/members')).status).toBe(403);
    expect((await call('patch', ws.agent, `/members/${ws.clientId}`, { jobTitle: 'Gerente' })).status).toBe(403);

    const adminId = members.find((m) => m.role === 'admin')!.id;
    const last = await call('patch', ws.admin, `/members/${adminId}`, { role: 'agent' });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('last_admin');

    const email = `desligar-${uniq()}@e2e.test.local`;
    const p = await inviteAndAccept(t, su, ws.admin, email, 'requester');
    await call('get', p.body.accessToken, '/auth/me').expect(200);
    const off = await call('patch', ws.admin, `/members/${p.body.userId}`, { active: false });
    expect(off.body.active).toBe(false);
    expect((await call('get', p.body.accessToken, '/auth/me')).status).toBe(401);

    const agents = (await call('get', ws.client, '/agents')).body as Body[];
    expect(agents.every((a) => ['admin', 'agent'].includes(a.role))).toBe(true);
    expect(agents[0]).not.toHaveProperty('email');
  });

  it('paginação de membros por cursor', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = await call('get', ws.admin, `/members?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...(r.body.items as Body[]).map((m) => m.id));
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe((await call('get', ws.admin, '/members?limit=100')).body.items.length);
  });

  it('organizações: equipe gerencia; cliente não vê', async () => {
    const name = `Cliente ${uniq()}`;
    const org = await call('post', ws.agent, '/organizations', { name, document: '00.000.000/0001-00' });
    expect(org.status).toBe(201);
    expect((await call('patch', ws.agent, `/organizations/${org.body.id}`, { notes: 'VIP' })).body.notes).toBe('VIP');
    expect((await call('get', ws.admin, `/organizations?q=${encodeURIComponent(name)}`)).body.items.map((o: Body) => o.id)).toEqual([org.body.id]);
    expect((await call('get', ws.client, '/organizations')).status).toBe(403);
    expect((await call('post', ws.agent, '/organizations', { name })).body.code).toBe('conflict');

    await call('patch', ws.admin, `/members/${ws.clientId}`, { organizationId: org.body.id }).expect(200);
    expect((await call('get', ws.agent, `/organizations/${org.body.id}`)).body.members.map((m: Body) => m.id)).toEqual([ws.clientId]);
  });
});

describe('base de conhecimento', () => {
  it('cliente só vê artigos publicados no portal; equipe vê tudo', async () => {
    const pub = await call('post', ws.agent, '/kb', { title: 'Como trocar o toner da impressora', body: 'Abra a tampa e troque o toner.', status: 'published', visibility: 'portal' });
    expect(pub.status).toBe(201);
    expect(pub.body.slug).toBe('como-trocar-o-toner-da-impressora');
    expect(pub.body.publishedAt).not.toBeNull();
    const internal = await call('post', ws.agent, '/kb', { title: 'Senha do roteador', body: 'segredo', status: 'published', visibility: 'internal' });
    const draft = await call('post', ws.agent, '/kb', { title: 'Rascunho de impressoras', body: 'impressoras', status: 'draft', visibility: 'portal' });

    const clientList = (await call('get', ws.client, '/kb')).body.items as Body[];
    expect(clientList.map((a) => a.id)).toEqual([pub.body.id]);
    expect((await call('get', ws.client, `/kb/${internal.body.slug}`)).status).toBe(404);
    expect((await call('get', ws.client, `/kb/${draft.body.slug}`)).status).toBe(404);
    expect((await call('get', ws.client, `/kb/${pub.body.slug}`)).body.body).toContain('toner');

    // busca full-text: "impressoras" acha "impressora"; cliente não acha o rascunho
    expect(((await call('get', ws.client, '/kb?q=impressoras')).body.items as Body[]).map((a) => a.id)).toEqual([pub.body.id]);
    expect(((await call('get', ws.agent, '/kb?q=impressoras')).body.items as Body[]).length).toBe(2);
    expect((await call('get', ws.agent, '/kb?status=draft')).body.items.map((a: Body) => a.id)).toEqual([draft.body.id]);

    expect((await call('post', ws.client, '/kb', { title: 'x' })).status).toBe(403);
    expect((await call('patch', ws.client, `/kb/${pub.body.id}`, { title: 'x' })).status).toBe(403);
  });

  it('slug único por workspace e publicação', async () => {
    const a = await call('post', ws.agent, '/kb', { title: 'Política de Férias' });
    const b = await call('post', ws.agent, '/kb', { title: 'Política de férias!' });
    expect([a.body.slug, b.body.slug]).toEqual(['politica-de-ferias', 'politica-de-ferias-2']);
    expect(a.body.publishedAt).toBeNull();
    const pub = await call('patch', ws.agent, `/kb/${a.body.id}`, { status: 'published' });
    expect(pub.body.publishedAt).not.toBeNull();
    expect((await call('post', ws.agent, '/kb', { title: 'x', slug: 'politica-de-ferias' })).body.code).toBe('conflict');
    await call('delete', ws.agent, `/kb/${b.body.id}`).expect(204);
  });
});

describe('macros e visões salvas', () => {
  it('macro privada só para o dono; render substitui variáveis no servidor', async () => {
    const mine = await call('post', ws.agent, '/macros', { name: 'Saudação', body: 'Olá {{solicitante.primeiro_nome}}, sobre o chamado #{{chamado.numero}} ({{chamado.assunto}}). Att, {{agente.nome}} — {{empresa.nome}} {{x.y}}' });
    expect(mine.status).toBe(201);
    const shared = await call('post', ws.admin, '/macros', { name: 'Encerramento', body: 'Obrigado!', shared: true });
    const priv = await call('post', ws.admin, '/macros', { name: 'Só minha', body: 'privado' });
    const agentSees = ((await call('get', ws.agent, '/macros')).body as Body[]).map((m) => m.id);
    expect(agentSees).toEqual(expect.arrayContaining([mine.body.id, shared.body.id]));
    expect(agentSees).not.toContain(priv.body.id);
    expect((await call('patch', ws.agent, `/macros/${shared.body.id}`, { body: 'alterado' })).status).toBe(403);
    expect((await call('get', ws.client, '/macros')).status).toBe(403);

    const tk = (await call('post', ws.client, '/tickets', { subject: 'Teclado falhando' })).body as Body;
    const r = await call('post', ws.agent, `/macros/${mine.body.id}/render`, { ticketId: tk.id });
    expect(r.status).toBe(200);
    expect(r.body.body).toBe(`Olá Pessoa, sobre o chamado #${tk.number} (Teclado falhando). Att, Pessoa agent — E2E cat {{x.y}}`);
  });

  it('visões: prontas + salvas; filtros validados', async () => {
    const v = await call('post', ws.agent, '/saved-views', { name: 'Urgentes', filters: { sla: 'breached', sort: 'due' }, shared: true });
    expect(v.status).toBe(201);
    const list = (await call('get', ws.admin, '/saved-views')).body as Body[];
    expect(list.slice(0, 4).map((x) => x.name)).toEqual(['Meus abertos', 'Sem responsável', 'SLA vencido', 'Aguardando cliente']);
    expect(list.map((x) => x.id)).toContain(v.body.id);
    for (const filters of [{ sla: 'quase' }, { foo: 1 }, { cursor: 'x' }]) {
      expect((await call('post', ws.agent, '/saved-views', { name: `bad ${uniq()}`, filters })).status).toBe(400);
    }
    // os filtros de uma visão funcionam direto no GET /tickets
    const qs = new URLSearchParams(v.body.filters as Record<string, string>).toString();
    expect((await call('get', ws.agent, `/tickets?${qs}`)).status).toBe(200);
  });
});

describe('workspace (tenant)', () => {
  it('equipe vê plano e uso; só admin altera nome/fuso; assinatura só para admin', async () => {
    const agentView = (await call('get', ws.agent, '/tenant')).body;
    expect(agentView.plan.id).toBeDefined();
    expect(agentView.usage.ticketsThisMonth.used).toBeGreaterThan(0);
    expect(agentView).not.toHaveProperty('subscription');
    expect((await call('get', ws.admin, '/tenant')).body.subscription.status).toBe('trialing');
    expect((await call('get', ws.client, '/tenant')).status).toBe(403);

    expect((await call('patch', ws.agent, '/tenant', { name: 'Hack' })).status).toBe(403);
    const ok = await call('patch', ws.admin, '/tenant', { name: 'Novo Nome', timezone: 'America/Recife' });
    expect(ok.body.tenant).toMatchObject({ name: 'Novo Nome', timezone: 'America/Recife' });
    expect((await call('patch', ws.admin, '/tenant', { plan_id: 'business' })).status).toBe(400);
  });
});

describe('recuperação de senha', () => {
  it('resposta idêntica exista o e-mail ou não; link é de uso único e troca a senha', async () => {
    const s = await newTenant(t, 'pwd', tenants);
    const known = await t.http().post(`${API}/auth/forgot-password`).send({ email: s.email.toUpperCase() });
    const unknown = await t.http().post(`${API}/auth/forgot-password`).send({ email: `ninguem-${uniq()}@e2e.test.local` });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);

    const { rows } = await su.query<{ token: string }>(
      `SELECT payload->>'token' AS token FROM email_outbox WHERE template = 'password_reset' AND to_email = $1`, [s.email]);
    expect(rows.length).toBe(1);
    const token = rows[0]!.token;

    expect((await t.http().post(`${API}/auth/reset-password`).send({ token, password: 'curta' })).status).toBe(400);
    await t.http().post(`${API}/auth/reset-password`).send({ token, password: 'nova-senha-123' }).expect(204);
    const again = await t.http().post(`${API}/auth/reset-password`).send({ token, password: 'outra-senha-123' });
    expect(again.status).toBe(410);
    expect(again.body.code).toBe('reset_invalid');

    expect((await t.http().post(`${API}/auth/login`).send({ email: s.email, password: PASSWORD })).status).toBe(401);
    expect((await t.http().post(`${API}/auth/login`).send({ email: s.email, password: 'nova-senha-123' })).status).toBe(200);
    // a sessão aberta antes do reset foi revogada pelo banco: o refresh antigo não vale mais
  });
});

async function me(token: string) {
  return (await call('get', token, '/auth/me')).body as Body;
}

