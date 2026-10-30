import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import request from 'supertest';
import type { Paginated, TicketDetail, TicketListItem } from '@helpdesk/shared';
import { addMember, auth, cleanup, createApp, E2E_DOMAIN, login, superDb } from './helpers.js';

const PW = 'senha-123456';

describe('Chamados (e2e)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  const http = () => request(app.getHttpServer());

  let tenantId: string;
  let admin: string; // tokens
  let agent: string;
  let agent2: string;
  let cli1: string;
  let cli2: string;
  let ids: { admin: string; agent: string; agent2: string; cli1: string; cli2: string; org: string };
  let statuses: Record<string, string>; // nome → id
  let priorities: Record<string, string>;
  let categoryId: string;

  const byName = (list: Array<{ id: string; name: string }>) => Object.fromEntries(list.map((x) => [x.name, x.id]));
  const get = (token: string, id: string) => http().get(`/api/v1/tickets/${id}`).set(auth(token));
  const create = (token: string, body: Record<string, unknown>) => http().post('/api/v1/tickets').set(auth(token)).send(body);
  const patch = (token: string, id: string, body: Record<string, unknown>) => http().patch(`/api/v1/tickets/${id}`).set(auth(token)).send(body);
  const list = async (token: string, query: Record<string, string | number> = {}) =>
    (await http().get('/api/v1/tickets').set(auth(token)).query(query).expect(200)).body as Paginated<TicketListItem>;

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();

    const res = await http()
      .post('/api/v1/auth/signup')
      .send({ workspaceName: 'Chamados E2E', slug: 'e2e-chamados', name: 'Admin', email: `admin@${E2E_DOMAIN}`, password: PW })
      .expect(201);
    admin = res.body.accessToken;
    const me = await http().get('/api/v1/auth/me').set(auth(admin)).expect(200);
    tenantId = me.body.tenant.id;

    const org = await db.query<{ id: string }>(`INSERT INTO organizations (tenant_id, name) VALUES ($1, 'Cliente SA') RETURNING id`, [tenantId]);
    ids = {
      admin: me.body.user.id,
      agent: await addMember(db, tenantId, `agente@${E2E_DOMAIN}`, 'agent', { name: 'Agente Um' }),
      agent2: await addMember(db, tenantId, `agente2@${E2E_DOMAIN}`, 'agent', { name: 'Agente Dois' }),
      cli1: await addMember(db, tenantId, `cli1@${E2E_DOMAIN}`, 'requester', { name: 'Cliente Um', organizationId: org.rows[0]!.id }),
      cli2: await addMember(db, tenantId, `cli2@${E2E_DOMAIN}`, 'requester', { name: 'Cliente Dois' }),
      org: org.rows[0]!.id,
    };
    agent = (await login(app, `agente@${E2E_DOMAIN}`, PW)).token;
    agent2 = (await login(app, `agente2@${E2E_DOMAIN}`, PW)).token;
    cli1 = (await login(app, `cli1@${E2E_DOMAIN}`, PW)).token;
    cli2 = (await login(app, `cli2@${E2E_DOMAIN}`, PW)).token;

    statuses = byName((await http().get('/api/v1/catalog/statuses').set(auth(agent)).expect(200)).body);
    priorities = byName((await http().get('/api/v1/catalog/priorities').set(auth(agent)).expect(200)).body);
    const cats = (await http().get('/api/v1/catalog/categories').set(auth(agent)).expect(200)).body as Array<{ id: string; name: string }>;
    categoryId = cats.find((c) => c.name === 'Incidente')!.id;
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db);
    await db.end();
  });

  describe('criação', () => {
    it('cliente abre chamado: banco aplica padrões e ignora prioridade/responsável/status/fila', async () => {
      const res = await create(cli1, {
        subject: 'Computador não liga',
        description: 'Desde hoje cedo',
        categoryId,
        priorityId: priorities['Urgente'],
        assigneeId: ids.agent,
        statusId: statuses['Resolvido'],
        tags: ['vip'],
        organizationId: ids.org,
      }).expect(201);
      const t = res.body as TicketDetail;
      expect(t.number).toBeGreaterThan(0);
      expect(t.priority.name).toBe('Normal');
      expect(t.assignee).toBeNull();
      expect(t.status.name).toBe('Novo');
      expect(t.queue?.name).toBe('Suporte'); // fila padrão da categoria
      expect(t.tags).toEqual([]);
      expect(t.requester.id).toBe(ids.cli1);
      // cliente não recebe dados internos
      expect(t.sla).toBeNull();
      expect(t).not.toHaveProperty('events');
      expect(t).not.toHaveProperty('timeSpentMinutes');
    });

    it('cliente não abre chamado em nome de outro → 403', async () => {
      const res = await create(cli1, { subject: 'Em nome do outro', requesterId: ids.cli2 }).expect(403);
      expect(res.body.code).toBe('forbidden');
    });

    it('agente abre em nome do cliente com prioridade, responsável e tags; SLA começa a correr', async () => {
      const res = await create(agent, {
        subject: 'Telefone da recepção mudo',
        requesterId: ids.cli2,
        priorityId: priorities['Alta'],
        assigneeId: ids.agent,
        tags: ['Telefonia', 'telefonia', ' recepcao '],
        channel: 'phone',
      }).expect(201);
      const t = res.body as TicketDetail;
      expect(t).toMatchObject({ priority: { name: 'Alta' }, assignee: { id: ids.agent }, channel: 'phone', requester: { id: ids.cli2 } });
      expect(t.tags.sort()).toEqual(['recepcao', 'telefonia']);
      expect(t.sla?.state).toBe('running');
      expect(t.sla?.firstResponse?.state).toBe('running');
      expect(t.events?.map((e) => e.type)).toContain('created');
    });

    it('responsável precisa ser da equipe → 422 assignee_must_be_staff', async () => {
      const res = await create(agent, { subject: 'x', requesterId: ids.cli1, assigneeId: ids.cli2 }).expect(422);
      expect(res.body.code).toBe('assignee_must_be_staff');
    });

    it('referência de outro tenant → 422 invalid_reference', async () => {
      const { rows } = await db.query<{ id: string }>(`SELECT s.id FROM statuses s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = 'demo' LIMIT 1`);
      const res = await create(agent, { subject: 'x', requesterId: ids.cli1, statusId: rows[0]!.id }).expect(422);
      expect(res.body.code).toBe('invalid_reference');
    });

    it('validação: assunto vazio e campos desconhecidos → 400 com detalhes em pt-BR', async () => {
      const res = await create(agent, { subject: '   ', number: 99 }).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'number', message: 'campo não permitido' },
          { field: 'subject', message: 'muito curto' },
        ]),
      );
    });
  });

  describe('visibilidade', () => {
    it('cliente lista só os próprios chamados e não abre o de outro cliente (404)', async () => {
      const mine = await list(cli1);
      expect(mine.items.length).toBeGreaterThan(0);
      expect(mine.items.every((t) => t.requester.id === ids.cli1)).toBe(true);
      expect(mine.items.every((t) => t.sla === null)).toBe(true);

      const other = (await list(cli2)).items[0]!;
      await get(cli1, other.id).expect(404);
    });

    it('agente vê os chamados de todos os clientes', async () => {
      const all = await list(agent, { limit: 100 });
      const requesters = new Set(all.items.map((t) => t.requester.id));
      expect(requesters).toEqual(new Set([ids.cli1, ids.cli2]));
    });

    it('chamado de outro tenant → 404', async () => {
      const { rows } = await db.query<{ id: string }>(`SELECT t.id FROM tickets t JOIN tenants x ON x.id = t.tenant_id WHERE x.slug = 'demo' LIMIT 1`);
      await get(agent, rows[0]!.id).expect(404);
      await patch(agent, rows[0]!.id, { subject: 'invasão' }).expect(404);
    });

    it('no workspace demo, João (cliente) só vê os 4 chamados dele', async () => {
      const joao = await login(app, 'joao@acme.local');
      const res = await list(joao.token, { limit: 100 });
      expect(res.items).toHaveLength(4);
      expect(new Set(res.items.map((t) => t.requester.name))).toEqual(new Set(['João Pereira']));
    });
  });

  describe('mensagens', () => {
    let ticketId: string;

    beforeAll(async () => {
      ticketId = (await create(cli1, { subject: 'Erro ao imprimir boleto' }).expect(201)).body.id;
    });

    it('nota interna da equipe nunca aparece para o cliente; resposta pública sim', async () => {
      await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(agent)).send({ kind: 'internal_note', body: 'Suspeita: driver antigo' }).expect(201);
      const reply = await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(agent)).send({ kind: 'public_reply', body: 'Olá! Vamos verificar.' }).expect(201);
      expect(reply.body).toMatchObject({ kind: 'public_reply', author: { id: ids.agent } });

      const staffView = (await get(agent, ticketId).expect(200)).body as TicketDetail;
      expect(staffView.messages.map((m) => m.kind)).toEqual(['internal_note', 'public_reply']);
      expect(staffView.firstResponseAt).not.toBeNull();
      expect(staffView.sla?.firstResponse?.state).toBe('met');

      const clientView = (await get(cli1, ticketId).expect(200)).body as TicketDetail;
      expect(clientView.messages.map((m) => m.body)).toEqual(['Olá! Vamos verificar.']);
      expect(JSON.stringify(clientView)).not.toContain('driver antigo');
    });

    it('cliente não cria nota interna (403) e não responde chamado alheio (404)', async () => {
      const res = await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(cli1)).send({ kind: 'internal_note', body: 'x' }).expect(403);
      expect(res.body.code).toBe('forbidden');
      await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(cli2)).send({ kind: 'public_reply', body: 'x' }).expect(404);
    });

    it('mensagem vazia ou tipo "system" → 400', async () => {
      await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(agent)).send({ kind: 'public_reply', body: '   ' }).expect(400);
      await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(agent)).send({ kind: 'system', body: 'x' }).expect(400);
    });
  });

  describe('SLA: pausa e reabertura', () => {
    let ticketId: string;

    beforeAll(async () => {
      ticketId = (await create(cli1, { subject: 'Acesso ao ERP bloqueado' }).expect(201)).body.id;
    });

    it('"Aguardando cliente" pausa o SLA e a resposta do cliente reabre o chamado', async () => {
      const paused = (await patch(agent, ticketId, { statusId: statuses['Aguardando cliente'], assigneeId: ids.agent }).expect(200)).body as TicketDetail;
      expect(paused.status.name).toBe('Aguardando cliente');
      expect(paused.sla?.state).toBe('paused');
      expect(paused.sla?.resolution?.state).toBe('paused');
      expect(paused.sla?.resolution?.minutesRemaining).toBeNull();

      const again = (await get(agent, ticketId).expect(200)).body as TicketDetail;
      expect(again.sla?.resolution?.state).toBe('paused');

      await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(cli1)).send({ kind: 'public_reply', body: 'Enviei o print.' }).expect(201);
      const reopened = (await get(agent, ticketId).expect(200)).body as TicketDetail;
      expect(reopened.status.name).toBe('Novo');
      expect(reopened.sla?.resolution?.state).toBe('running');
      expect(reopened.events?.filter((e) => e.type === 'status_changed').map((e) => e.data['to'])).toEqual(['Aguardando cliente', 'Novo']);
    });

    it('resolver + mudar prioridade numa só requisição; reabrir pela resposta do cliente', async () => {
      const resolved = (await patch(agent, ticketId, { statusId: statuses['Resolvido'], priorityId: priorities['Urgente'], tags: ['erp'] }).expect(200)).body as TicketDetail;
      expect(resolved).toMatchObject({ status: { kind: 'resolved' }, priority: { name: 'Urgente' }, tags: ['erp'] });
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.events?.map((e) => e.type)).toEqual(expect.arrayContaining(['status_changed', 'priority_changed']));

      await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(cli1)).send({ kind: 'public_reply', body: 'Voltou a acontecer.' }).expect(201);
      const reopened = (await get(cli1, ticketId).expect(200)).body as TicketDetail;
      expect(reopened.status.name).toBe('Novo');
      expect(reopened.resolvedAt).toBeNull();
    });

    it('chamado vencido aparece no filtro sla=breached e primeiro na ordenação por prazo', async () => {
      await db.query(`UPDATE sla_timers SET due_at = now() - interval '1 hour' WHERE ticket_id = $1 AND kind = 'resolution'`, [ticketId]);
      const breached = await list(agent, { sla: 'breached', limit: 100 });
      expect(breached.items.map((t) => t.id)).toContain(ticketId);
      expect(breached.items.every((t) => t.sla?.state === 'breached')).toBe(true);
      const byDue = await list(agent, { sort: 'due', limit: 1 });
      expect(byDue.items[0]!.id).toBe(ticketId);
      const running = await list(agent, { sla: 'running', limit: 100 });
      expect(running.items.map((t) => t.id)).not.toContain(ticketId);
    });
  });

  describe('edição', () => {
    let ticketId: string;

    beforeAll(async () => {
      ticketId = (await create(cli2, { subject: 'Mouse com defeito' }).expect(201)).body.id;
    });

    it('cliente não edita chamado (nem o próprio) → 403', async () => {
      const res = await patch(cli2, ticketId, { subject: 'Mudando o assunto' }).expect(403);
      expect(res.body.code).toBe('forbidden');
      await patch(cli2, ticketId, { priorityId: priorities['Urgente'] }).expect(403);
      expect(((await get(agent, ticketId)).body as TicketDetail).priority.name).toBe('Normal');
    });

    it('colunas do banco não são editáveis (número, datas, SLA)', async () => {
      const res = await patch(agent, ticketId, { number: 1, resolvedAt: new Date().toISOString(), slaPolicyId: ticketId }).expect(400);
      expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['number', 'resolvedAt', 'slaPolicyId']);
    });

    it('campo obrigatório não aceita null; anulável aceita', async () => {
      await patch(agent, ticketId, { priorityId: null }).expect(400);
      await patch(agent, ticketId, { assigneeId: ids.agent2 }).expect(200);
      const t = (await patch(agent, ticketId, { assigneeId: null }).expect(200)).body as TicketDetail;
      expect(t.assignee).toBeNull();
      expect(t.events?.filter((e) => e.type === 'assigned')).toHaveLength(2);
    });

    it('PATCH vazio → 400', async () => {
      await patch(agent, ticketId, {}).expect(400);
    });
  });

  describe('em lote', () => {
    it('atribui, muda status e adiciona tags; IDs alheios são ignorados', async () => {
      const a = (await create(cli1, { subject: 'Lote A' }).expect(201)).body.id as string;
      const b = (await create(cli2, { subject: 'Lote B' }).expect(201)).body.id as string;
      const { rows } = await db.query<{ id: string }>(`SELECT t.id FROM tickets t JOIN tenants x ON x.id = t.tenant_id WHERE x.slug = 'demo' LIMIT 1`);
      const foreign = rows[0]!.id;

      const res = await http()
        .post('/api/v1/tickets/bulk')
        .set(auth(agent))
        .send({ ids: [a, b, foreign], changes: { assigneeId: ids.agent2, statusId: statuses['Em atendimento'], addTags: ['lote'] } })
        .expect(200);
      expect(res.body).toEqual({ updated: [a, b], skipped: [foreign] });
      for (const id of [a, b]) {
        const t = (await get(agent, id)).body as TicketDetail;
        expect(t).toMatchObject({ assignee: { id: ids.agent2 }, status: { name: 'Em atendimento' }, tags: ['lote'] });
      }

      const removed = await http().post('/api/v1/tickets/bulk').set(auth(agent)).send({ ids: [a], changes: { removeTags: ['lote'] } }).expect(200);
      expect(removed.body.updated).toEqual([a]);
      expect(((await get(agent, a)).body as TicketDetail).tags).toEqual([]);
    });

    it('erro em um item desfaz o lote inteiro', async () => {
      const a = (await create(cli1, { subject: 'Lote atômico' }).expect(201)).body.id as string;
      const res = await http().post('/api/v1/tickets/bulk').set(auth(agent)).send({ ids: [a], changes: { assigneeId: ids.cli1 } }).expect(422);
      expect(res.body.code).toBe('assignee_must_be_staff');
      expect(((await get(agent, a)).body as TicketDetail).assignee).toBeNull();
    });

    it('cliente não usa ações em lote → 403', async () => {
      const mine = (await list(cli1)).items[0]!.id;
      await http().post('/api/v1/tickets/bulk').set(auth(cli1)).send({ ids: [mine], changes: { statusId: statuses['Fechado'] } }).expect(403);
    });
  });

  describe('apontamento de horas', () => {
    let ticketId: string;

    beforeAll(async () => {
      ticketId = (await create(cli1, { subject: 'Configurar VPN' }).expect(201)).body.id;
    });

    it('agente aponta, lista e o total aparece no detalhe', async () => {
      const e1 = await http().post(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(agent)).send({ minutes: 30, note: 'Diagnóstico' }).expect(201);
      expect(e1.body).toMatchObject({ minutes: 30, note: 'Diagnóstico', user: { id: ids.agent } });
      expect(e1.body.workedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await http().post(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(agent2)).send({ minutes: 15, workedOn: '2026-10-01' }).expect(201);

      const listRes = await http().get(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(agent)).expect(200);
      expect(listRes.body).toHaveLength(2);
      expect(((await get(agent, ticketId)).body as TicketDetail).timeSpentMinutes).toBe(45);
    });

    it('limites: 0 ou mais de 24h → 400', async () => {
      await http().post(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(agent)).send({ minutes: 0 }).expect(400);
      await http().post(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(agent)).send({ minutes: 1441 }).expect(400);
    });

    it('só o autor ou admin remove; cliente não acessa', async () => {
      const entry = (await http().post(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(agent)).send({ minutes: 5 }).expect(201)).body.id;
      const denied = await http().delete(`/api/v1/time-entries/${entry}`).set(auth(agent2)).expect(403);
      expect(denied.body.code).toBe('forbidden');
      await http().delete(`/api/v1/time-entries/${entry}`).set(auth(admin)).expect(204);
      await http().delete(`/api/v1/time-entries/${entry}`).set(auth(admin)).expect(404);

      await http().get(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(cli1)).expect(403);
      await http().post(`/api/v1/tickets/${ticketId}/time-entries`).set(auth(cli1)).send({ minutes: 5 }).expect(403);
    });
  });

  describe('listagem: filtros, busca e paginação', () => {
    let printer: TicketListItem;

    beforeAll(async () => {
      printer = (await create(agent, { subject: 'Impressora da recepção travou', description: 'Papel enroscado', requesterId: ids.cli2, tags: ['hardware'], priorityId: priorities['Baixa'] }).expect(201)).body;
    });

    it('busca full-text em português: "impressoras" encontra "Impressora"', async () => {
      const res = await list(agent, { q: 'impressoras' });
      expect(res.items.map((t) => t.id)).toContain(printer.id);
      expect(res.items.every((t) => /imprim|impress/i.test(t.subject))).toBe(true);
    });

    it('busca na descrição, por número e por trecho de palavra', async () => {
      expect((await list(agent, { q: 'enroscado' })).items.map((t) => t.id)).toEqual([printer.id]);
      expect((await list(agent, { q: `#${printer.number}` })).items.map((t) => t.id)).toEqual([printer.id]);
      expect((await list(agent, { q: 'recep' })).items.map((t) => t.id)).toContain(printer.id);
    });

    it('caracteres especiais na busca não quebram nem viram curinga', async () => {
      expect((await list(agent, { q: '%' })).items).toEqual([]);
      expect((await list(agent, { q: "'); DROP TABLE tickets; --" })).items).toEqual([]);
    });

    it('filtros por tag, prioridade, solicitante, responsável, status e período', async () => {
      expect((await list(agent, { tag: 'hardware' })).items.map((t) => t.id)).toEqual([printer.id]);
      expect((await list(agent, { priority: priorities['Baixa']! })).items.map((t) => t.id)).toEqual([printer.id]);
      expect((await list(agent, { requester: ids.cli2, limit: 100 })).items.every((t) => t.requester.id === ids.cli2)).toBe(true);

      const none = await list(agent, { assignee: 'none', limit: 100 });
      expect(none.items.every((t) => t.assignee === null)).toBe(true);
      const mine = await list(agent, { assignee: 'me', limit: 100 });
      expect(mine.items.length).toBeGreaterThan(0);
      expect(mine.items.every((t) => t.assignee?.id === ids.agent)).toBe(true);

      const open = await list(agent, { status: 'open,pending', limit: 100 });
      expect(open.items.every((t) => ['open', 'pending'].includes(t.status.kind))).toBe(true);
      const byId = await list(agent, { status: statuses['Em atendimento']!, limit: 100 });
      expect(byId.items.every((t) => t.status.name === 'Em atendimento')).toBe(true);

      const future = await list(agent, { createdFrom: new Date(Date.now() + 3_600_000).toISOString() });
      expect(future.items).toEqual([]);
      const today = await list(agent, { createdFrom: new Date(Date.now() - 3_600_000).toISOString(), limit: 100 });
      expect(today.items.length).toBeGreaterThan(5);
    });

    it('filtros inválidos → 400', async () => {
      await http().get('/api/v1/tickets').set(auth(agent)).query({ assignee: 'alguem' }).expect(400);
      await http().get('/api/v1/tickets').set(auth(agent)).query({ sort: 'id; drop' }).expect(400);
      await http().get('/api/v1/tickets').set(auth(agent)).query({ limit: 101 }).expect(400);
      await http().get('/api/v1/tickets').set(auth(agent)).query({ cursor: 'lixo' }).expect(400);
      await http().get('/api/v1/tickets').set(auth(agent)).query({ status: 'inexistente' }).expect(400);
    });

    it.each(['updated', 'created', 'priority', 'due'])('paginação por cursor (sort=%s) percorre tudo sem repetir', async (sort) => {
      const all = await list(agent, { sort, limit: 100 });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Paginated<TicketListItem> = await list(agent, { sort, limit: 3, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items.map((t) => t.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.items.map((t) => t.id));
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('ordenação por prioridade: maior nível primeiro', async () => {
      const levels = (await list(agent, { sort: 'priority', limit: 100 })).items.map((t) => t.priority.level);
      expect(levels).toEqual([...levels].sort((a, b) => b - a));
    });
  });

  describe('limites do plano', () => {
    it('cota mensal esgotada → 402 ticket_quota_exceeded; conta suspensa → 402 tenant_inactive', async () => {
      await db.query(`INSERT INTO plans (id, name, price_cents, max_tickets_per_month) VALUES ('e2e-mini', 'Mini', 0, 1)`);
      await db.query(`UPDATE tenants SET plan_id = 'e2e-mini' WHERE id = $1`, [tenantId]);
      try {
        const quota = await create(cli1, { subject: 'Além da cota' }).expect(402);
        expect(quota.body).toEqual({ code: 'ticket_quota_exceeded', message: expect.stringContaining('limite') });

        await db.query(`UPDATE tenants SET plan_id = 'starter', status = 'suspended' WHERE id = $1`, [tenantId]);
        const inactive = await create(agent, { subject: 'Conta suspensa', requesterId: ids.cli1 }).expect(402);
        expect(inactive.body.code).toBe('tenant_inactive');
        // leitura continua liberada
        await list(agent);
      } finally {
        await db.query(`UPDATE tenants SET plan_id = 'starter', status = 'trial' WHERE id = $1`, [tenantId]);
      }
    });
  });
});
