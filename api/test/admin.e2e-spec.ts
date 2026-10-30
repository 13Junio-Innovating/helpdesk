import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import request from 'supertest';
import type { Invitation, KbArticle, Member, Paginated, KbArticleSummary, ReportsOverview, TenantInfo } from '@helpdesk/shared';
import { DbService } from '../src/common/db/db.service.js';
import { addMember, auth, cleanup, createApp, E2E_DOMAIN, login, superDb } from './helpers.js';

const PW = 'senha-123456';

describe('Catálogo, equipe, convites, KB, relatórios e tenant (e2e)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  const http = () => request(app.getHttpServer());

  let tenantId: string;
  let admin: string;
  let agent: string;
  let cli: string;
  let ids: { admin: string; agent: string; cli: string };

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();
    const res = await http()
      .post('/api/v1/auth/signup')
      .send({ workspaceName: 'Admin E2E', slug: 'e2e-admin', name: 'Dona Admin', email: `admin@${E2E_DOMAIN}`, password: PW })
      .expect(201);
    admin = res.body.accessToken;
    const me = await http().get('/api/v1/auth/me').set(auth(admin)).expect(200);
    tenantId = me.body.tenant.id;
    ids = {
      admin: me.body.user.id,
      agent: await addMember(db, tenantId, `agente@${E2E_DOMAIN}`, 'agent', { name: 'Agente' }),
      cli: await addMember(db, tenantId, `cli@${E2E_DOMAIN}`, 'requester', { name: 'Cliente' }),
    };
    agent = (await login(app, `agente@${E2E_DOMAIN}`, PW)).token;
    cli = (await login(app, `cli@${E2E_DOMAIN}`, PW)).token;
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db);
    await db.end();
  });

  // ======================================================================
  describe('catálogo: só admin escreve', () => {
    it('admin cria fila, categoria, prioridade, status e política de SLA', async () => {
      const q = await http().post('/api/v1/catalog/queues').set(auth(admin)).send({ name: 'Financeiro', description: 'Cobrança' }).expect(201);
      expect(q.body).toMatchObject({ name: 'Financeiro', description: 'Cobrança' });
      const c = await http().post('/api/v1/catalog/categories').set(auth(admin)).send({ name: 'Boleto', defaultQueueId: q.body.id }).expect(201);
      expect(c.body).toMatchObject({ name: 'Boleto', defaultQueueId: q.body.id, active: true });
      const p = await http().post('/api/v1/catalog/priorities').set(auth(admin)).send({ name: 'Crítica', level: 9, color: '#ff0000' }).expect(201);
      expect(p.body).toMatchObject({ name: 'Crítica', level: 9, isDefault: false });
      const s = await http().post('/api/v1/catalog/statuses').set(auth(admin)).send({ name: 'Aguardando fornecedor', kind: 'on_hold', slaPauses: true, position: 7 }).expect(201);
      expect(s.body).toMatchObject({ kind: 'on_hold', slaPauses: true });
      const sla = await http()
        .post('/api/v1/catalog/sla-policies')
        .set(auth(admin))
        .send({ name: 'SLA Crítica', priorityId: p.body.id, firstResponseMinutes: 15, resolutionMinutes: 60 })
        .expect(201);
      expect(sla.body).toMatchObject({ firstResponseMinutes: 15, businessHoursId: null, active: true });

      // novo chamado com essa prioridade usa a política nova (24x7: 15 min)
      const t = await http().post('/api/v1/tickets').set(auth(agent)).send({ subject: 'Teste SLA', requesterId: ids.cli, priorityId: p.body.id, categoryId: c.body.id }).expect(201);
      expect(t.body.queue.name).toBe('Financeiro');
      const minutes = (Date.parse(t.body.sla.firstResponse.dueAt) - Date.parse(t.body.createdAt)) / 60_000;
      expect(Math.round(minutes)).toBe(15);
    });

    it('agente recebe 403 em toda escrita do catálogo', async () => {
      const bodies: Array<[string, Record<string, unknown>]> = [
        ['queues', { name: 'X' }],
        ['categories', { name: 'X' }],
        ['priorities', { name: 'X', level: 1 }],
        ['statuses', { name: 'X', kind: 'open' }],
        ['business-hours', { name: 'X' }],
        ['sla-policies', { name: 'X', firstResponseMinutes: 1, resolutionMinutes: 2 }],
        ['automation-rules', { name: 'X', event: 'ticket_created', conditions: [], actions: [{ type: 'notify_staff' }] }],
      ];
      for (const [path, body] of bodies) {
        const res = await http().post(`/api/v1/catalog/${path}`).set(auth(agent)).send(body);
        expect([path, res.status, res.body.code]).toEqual([path, 403, 'forbidden']);
      }
      const statuses = (await http().get('/api/v1/catalog/statuses').set(auth(agent)).expect(200)).body;
      await http().patch(`/api/v1/catalog/statuses/${statuses[0].id}`).set(auth(agent)).send({ name: 'Hack' }).expect(403);
      await http().delete(`/api/v1/catalog/statuses/${statuses[0].id}`).set(auth(agent)).expect(403);
    });

    it('mesmo se a API deixasse passar, a RLS barra o agente (42501)', async () => {
      const dbs = app.get(DbService);
      await expect(
        dbs.withTenant({ tenantId, userId: ids.agent }, (tx) => tx.query(`INSERT INTO sla_policies (tenant_id, name, first_response_minutes, resolution_minutes) VALUES ($1, 'x', 1, 2)`, [tenantId])),
      ).rejects.toMatchObject({ code: '42501' });
      const changed = await dbs.withTenant({ tenantId, userId: ids.agent }, (tx) => tx.query(`UPDATE statuses SET name = 'hack'`));
      expect(changed.rowCount).toBe(0);
    });

    it('cliente lê status/prioridades/categorias, mas não SLA, horário comercial nem automações', async () => {
      await http().get('/api/v1/catalog/statuses').set(auth(cli)).expect(200);
      await http().get('/api/v1/catalog/priorities').set(auth(cli)).expect(200);
      await http().get('/api/v1/catalog/categories').set(auth(cli)).expect(200);
      await http().get('/api/v1/catalog/sla-policies').set(auth(cli)).expect(403);
      await http().get('/api/v1/catalog/business-hours').set(auth(cli)).expect(403);
      await http().get('/api/v1/catalog/automation-rules').set(auth(cli)).expect(403);
    });

    it('padrão é exclusivo e não pode ficar sem padrão', async () => {
      const before = (await http().get('/api/v1/catalog/priorities').set(auth(admin)).expect(200)).body as Array<{ id: string; name: string; isDefault: boolean }>;
      const oldDefault = before.find((p) => p.isDefault)!;
      await http().delete(`/api/v1/catalog/priorities/${oldDefault.id}`).set(auth(admin)).expect(409);
      await http().patch(`/api/v1/catalog/priorities/${oldDefault.id}`).set(auth(admin)).send({ isDefault: false }).expect(409);

      const low = before.find((p) => p.name === 'Baixa')!;
      await http().patch(`/api/v1/catalog/priorities/${low.id}`).set(auth(admin)).send({ isDefault: true }).expect(200);
      const after = (await http().get('/api/v1/catalog/priorities').set(auth(admin)).expect(200)).body as Array<{ name: string; isDefault: boolean }>;
      expect(after.filter((p) => p.isDefault).map((p) => p.name)).toEqual(['Baixa']);
      await http().patch(`/api/v1/catalog/priorities/${oldDefault.id}`).set(auth(admin)).send({ isDefault: true }).expect(200);
    });

    it('remover registro em uso → 409 in_use; nome repetido → 409 conflict', async () => {
      const statuses = (await http().get('/api/v1/catalog/statuses').set(auth(admin)).expect(200)).body as Array<{ id: string; name: string }>;
      const inUse = statuses.find((s) => s.name === 'Novo')!;
      await http().patch(`/api/v1/catalog/statuses/${statuses.find((s) => s.name === 'Em atendimento')!.id}`).set(auth(admin)).send({ isDefault: true }).expect(200);
      const res = await http().delete(`/api/v1/catalog/statuses/${inUse.id}`).set(auth(admin)).expect(409);
      expect(res.body.code).toBe('in_use');
      await http().patch(`/api/v1/catalog/statuses/${inUse.id}`).set(auth(admin)).send({ isDefault: true }).expect(200);

      const dup = await http().post('/api/v1/catalog/queues').set(auth(admin)).send({ name: 'Suporte' }).expect(409);
      expect(dup.body.code).toBe('conflict');
    });

    it('horário comercial: faixas, sobreposição, feriados e fuso', async () => {
      const bh = await http().post('/api/v1/catalog/business-hours').set(auth(admin)).send({ name: 'Plantão', timezone: 'America/Manaus' }).expect(201);
      expect(bh.body).toMatchObject({ timezone: 'America/Manaus', slots: [], holidays: [] });
      await http().post('/api/v1/catalog/business-hours').set(auth(admin)).send({ name: 'Y', timezone: 'Marte/Base' }).expect(400);

      const overlap = await http()
        .put(`/api/v1/catalog/business-hours/${bh.body.id}/slots`)
        .set(auth(admin))
        .send({ slots: [{ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '11:00', endTime: '13:00' }] })
        .expect(400);
      expect(overlap.body.details[0].message).toMatch(/sobrepostas/);

      const ok = await http()
        .put(`/api/v1/catalog/business-hours/${bh.body.id}/slots`)
        .set(auth(admin))
        .send({ slots: [{ weekday: 2, startTime: '13:00', endTime: '18:00' }, { weekday: 1, startTime: '08:00', endTime: '12:00' }] })
        .expect(200);
      expect(ok.body.slots).toEqual([
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
        { weekday: 2, startTime: '13:00', endTime: '18:00' },
      ]);

      const hol = await http().post(`/api/v1/catalog/business-hours/${bh.body.id}/holidays`).set(auth(admin)).send({ date: '2026-12-25', name: 'Natal' }).expect(201);
      expect(hol.body.holidays).toEqual([{ date: '2026-12-25', name: 'Natal' }]);
      await http().post(`/api/v1/catalog/business-hours/${bh.body.id}/holidays`).set(auth(admin)).send({ date: '2026-12-25' }).expect(409);
      await http().delete(`/api/v1/catalog/business-hours/${bh.body.id}/holidays/2026-12-25`).set(auth(admin)).expect(204);
      await http().delete(`/api/v1/catalog/business-hours/${bh.body.id}/holidays/2026-12-25`).set(auth(admin)).expect(404);
    });

    it('automações: formato validado (condições/ações)', async () => {
      const bad = await http()
        .post('/api/v1/catalog/automation-rules')
        .set(auth(admin))
        .send({ name: 'Ruim', event: 'ticket_created', conditions: [{ field: 'senha', op: 'regex', value: '.*' }], actions: [{ type: 'delete_all' }] })
        .expect(400);
      expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['conditions.0.field', 'conditions.0.op', 'actions.0.type']));

      const queues = (await http().get('/api/v1/catalog/queues').set(auth(admin)).expect(200)).body;
      const good = await http()
        .post('/api/v1/catalog/automation-rules')
        .set(auth(admin))
        .send({
          name: 'VIP vai para o Financeiro',
          event: 'ticket_created',
          conditions: [{ field: 'tags', op: 'contains', value: 'vip' }, { field: 'priority.name', op: 'in', value: ['Alta', 'Urgente'] }],
          actions: [{ type: 'assign_queue', queueId: queues[0].id }, { type: 'add_tag', value: 'prioritario' }],
        })
        .expect(201);
      expect(good.body.conditions).toHaveLength(2);
      const off = await http().patch(`/api/v1/catalog/automation-rules/${good.body.id}`).set(auth(admin)).send({ active: false }).expect(200);
      expect(off.body.active).toBe(false);
      await http().get('/api/v1/catalog/automation-rules').set(auth(agent)).expect(200);
    });

    it('membros de fila: só equipe ativa', async () => {
      const queues = (await http().get('/api/v1/catalog/queues').set(auth(admin)).expect(200)).body;
      const qid = queues[0].id;
      await http().put(`/api/v1/catalog/queues/${qid}/members`).set(auth(admin)).send({ userIds: [ids.cli] }).expect(422);
      const res = await http().put(`/api/v1/catalog/queues/${qid}/members`).set(auth(admin)).send({ userIds: [ids.agent, ids.admin] }).expect(200);
      expect(res.body.map((m: { userId: string }) => m.userId).sort()).toEqual([ids.admin, ids.agent].sort());
    });
  });

  // ======================================================================
  describe('equipe e convites', () => {
    async function inviteToken(email: string): Promise<string> {
      const { rows } = await db.query<{ token: string }>(
        `SELECT payload->>'token' AS token FROM email_outbox WHERE template = 'invitation' AND to_email = $1 ORDER BY id DESC LIMIT 1`,
        [email],
      );
      return rows[0]!.token;
    }

    it('admin convida: resposta sem token, e-mail enfileirado; aceite cria o membro', async () => {
      const res = await http().post('/api/v1/invitations').set(auth(admin)).send({ email: `Novo.Cliente@${E2E_DOMAIN}`, role: 'requester' }).expect(201);
      const inv = res.body as Invitation;
      expect(inv.email).toBe(`novo.cliente@${E2E_DOMAIN}`);
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);
      expect((await http().get('/api/v1/invitations').set(auth(admin)).expect(200)).body.map((i: Invitation) => i.id)).toContain(inv.id);

      const token = await inviteToken(inv.email);
      const { rows } = await db.query<{ payload: Record<string, string> }>(`SELECT payload FROM email_outbox WHERE template = 'invitation' AND to_email = $1`, [inv.email]);
      expect(rows[0]!.payload).toMatchObject({ tenant_name: 'Admin E2E', inviter_name: 'Dona Admin', role: 'requester' });

      const accepted = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Novo Cliente', password: PW }).expect(200);
      const me = await http().get('/api/v1/auth/me').set(auth(accepted.body.accessToken)).expect(200);
      expect(me.body).toMatchObject({ role: 'requester', tenant: { id: tenantId } });

      // uso único
      await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Novo Cliente', password: PW }).expect(410);
      expect((await http().get('/api/v1/invitations').set(auth(admin)).expect(200)).body.map((i: Invitation) => i.id)).not.toContain(inv.id);
    });

    it('convite expirado ou revogado → 410; reenviar invalida o anterior', async () => {
      const email = `expira@${E2E_DOMAIN}`;
      await http().post('/api/v1/invitations').set(auth(admin)).send({ email, role: 'requester' }).expect(201);
      const first = await inviteToken(email);
      const second = (await http().post('/api/v1/invitations').set(auth(admin)).send({ email, role: 'requester' }).expect(201)).body as Invitation;
      await http().post('/api/v1/auth/accept-invite').send({ token: first, name: 'X y', password: PW }).expect(410);

      await db.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [second.id]);
      const expired = await http().post('/api/v1/auth/accept-invite').send({ token: await inviteToken(email), name: 'X y', password: PW }).expect(410);
      expect(expired.body.code).toBe('invitation_invalid');

      const third = (await http().post('/api/v1/invitations').set(auth(admin)).send({ email, role: 'requester' }).expect(201)).body as Invitation;
      await http().delete(`/api/v1/invitations/${third.id}`).set(auth(admin)).expect(204);
      await http().post('/api/v1/auth/accept-invite').send({ token: await inviteToken(email), name: 'X y', password: PW }).expect(410);
    });

    it('convidar quem já é membro → 409; agente e cliente não convidam (403)', async () => {
      const res = await http().post('/api/v1/invitations').set(auth(admin)).send({ email: `agente@${E2E_DOMAIN}`, role: 'agent' }).expect(409);
      expect(res.body.code).toBe('already_member');
      await http().post('/api/v1/invitations').set(auth(agent)).send({ email: `x@${E2E_DOMAIN}`, role: 'agent' }).expect(403);
      await http().post('/api/v1/invitations').set(auth(cli)).send({ email: `x@${E2E_DOMAIN}`, role: 'admin' }).expect(403);
    });

    it('limite de agentes do plano (Starter = 3) → 402 na promoção e no aceite do convite', async () => {
      const second = await addMember(db, tenantId, `agente2@${E2E_DOMAIN}`, 'agent'); // admin + 2 agentes = 3
      const promote = await http().patch(`/api/v1/members/${ids.cli}`).set(auth(admin)).send({ role: 'agent' }).expect(402);
      expect(promote.body.code).toBe('agent_limit_reached');

      await http().post('/api/v1/invitations').set(auth(admin)).send({ email: `quarto@${E2E_DOMAIN}`, role: 'agent' }).expect(201);
      const token = await inviteToken(`quarto@${E2E_DOMAIN}`);
      const accept = await http().post('/api/v1/auth/accept-invite').send({ token, name: 'Quarto Agente', password: PW }).expect(402);
      expect(accept.body.code).toBe('agent_limit_reached');

      const tenant = (await http().get('/api/v1/tenant').set(auth(admin)).expect(200)).body as TenantInfo;
      expect(tenant.usage.agents).toBe(3);

      // desativar um agente libera a vaga
      await http().patch(`/api/v1/members/${second}`).set(auth(admin)).send({ active: false }).expect(200);
      await http().patch(`/api/v1/members/${ids.cli}`).set(auth(admin)).send({ role: 'agent' }).expect(200);
      await http().patch(`/api/v1/members/${ids.cli}`).set(auth(admin)).send({ role: 'requester' }).expect(200);
    });

    it('o workspace não fica sem admin ativo', async () => {
      const res = await http().patch(`/api/v1/members/${ids.admin}`).set(auth(admin)).send({ role: 'agent' }).expect(409);
      expect(res.body.code).toBe('last_admin');
      await http().patch(`/api/v1/members/${ids.admin}`).set(auth(admin)).send({ active: false }).expect(409);
      expect((await http().get('/api/v1/auth/me').set(auth(admin)).expect(200)).body.role).toBe('admin');
    });

    it('membro desativado perde acesso; lista e filtros de membros', async () => {
      const temp = await addMember(db, tenantId, `temp@${E2E_DOMAIN}`, 'requester');
      const tok = (await login(app, `temp@${E2E_DOMAIN}`, PW)).token;
      await http().patch(`/api/v1/members/${temp}`).set(auth(admin)).send({ active: false, jobTitle: 'Ex-cliente' }).expect(200);
      await http().get('/api/v1/tickets').set(auth(tok)).expect(401);

      const inactive = (await http().get('/api/v1/members').set(auth(agent)).query({ active: 'false' }).expect(200)).body as Member[];
      expect(inactive.find((m) => m.userId === temp)).toMatchObject({ active: false, jobTitle: 'Ex-cliente' });
      const search = (await http().get('/api/v1/members').set(auth(agent)).query({ q: 'temp@' }).expect(200)).body as Member[];
      expect(search.map((m) => m.userId)).toEqual([temp]);
      await http().patch(`/api/v1/members/${temp}`).set(auth(agent)).send({ active: true }).expect(403);
      await http().get('/api/v1/members').set(auth(cli)).expect(403);

      const agentsList = (await http().get('/api/v1/agents').set(auth(agent)).expect(200)).body as Array<{ id: string }>;
      expect(agentsList.map((a) => a.id)).toEqual(expect.arrayContaining([ids.admin, ids.agent]));
      expect(agentsList.map((a) => a.id)).not.toContain(ids.cli);
    });
  });

  // ======================================================================
  describe('organizações', () => {
    it('CRUD com contagens; nome repetido 409; em uso 409', async () => {
      const org = await http().post('/api/v1/organizations').set(auth(agent)).send({ name: 'Globo Ltda', document: '00.000.000/0001-00' }).expect(201);
      expect(org.body).toMatchObject({ name: 'Globo Ltda', memberCount: 0, ticketCount: 0 });
      await http().post('/api/v1/organizations').set(auth(agent)).send({ name: 'Globo Ltda' }).expect(409);
      const upd = await http().patch(`/api/v1/organizations/${org.body.id}`).set(auth(agent)).send({ notes: 'Cliente desde 2020' }).expect(200);
      expect(upd.body.notes).toBe('Cliente desde 2020');

      await http().patch(`/api/v1/members/${ids.cli}`).set(auth(admin)).send({ organizationId: org.body.id }).expect(200);
      const busy = await http().delete(`/api/v1/organizations/${org.body.id}`).set(auth(agent)).expect(409);
      expect(busy.body.code).toBe('in_use');
      await http().patch(`/api/v1/members/${ids.cli}`).set(auth(admin)).send({ organizationId: null }).expect(200);
      await http().delete(`/api/v1/organizations/${org.body.id}`).set(auth(agent)).expect(204);

      expect((await http().get('/api/v1/organizations').set(auth(agent)).query({ q: 'globo' }).expect(200)).body).toEqual([]);
      await http().get('/api/v1/organizations').set(auth(cli)).expect(403);
    });
  });

  // ======================================================================
  describe('base de conhecimento', () => {
    let published: KbArticle;

    it('equipe cria; slug gerado do título e único', async () => {
      const a = await http()
        .post('/api/v1/kb')
        .set(auth(agent))
        .send({ title: 'Como trocar as senhas da VPN', body: 'Acesse o portal e clique em **Trocar senha**.', status: 'published', visibility: 'portal' })
        .expect(201);
      published = a.body;
      expect(published).toMatchObject({ slug: 'como-trocar-as-senhas-da-vpn', status: 'published', author: { id: ids.agent } });
      expect(published.publishedAt).not.toBeNull();

      const dup = await http().post('/api/v1/kb').set(auth(agent)).send({ title: 'Como trocar as senhas da VPN!' }).expect(201);
      expect(dup.body).toMatchObject({ slug: 'como-trocar-as-senhas-da-vpn-2', status: 'draft', visibility: 'internal', publishedAt: null });

      await http().post('/api/v1/kb').set(auth(agent)).send({ title: 'Procedimento interno de backup', status: 'published', visibility: 'internal' }).expect(201);
    });

    it('cliente só vê publicados no portal; busca em português', async () => {
      const list = (await http().get('/api/v1/kb').set(auth(cli)).expect(200)).body as Paginated<KbArticleSummary>;
      expect(list.items.map((a) => a.slug)).toEqual(['como-trocar-as-senhas-da-vpn']);
      await http().get('/api/v1/kb/como-trocar-as-senhas-da-vpn-2').set(auth(cli)).expect(404);
      await http().get('/api/v1/kb/procedimento-interno-de-backup').set(auth(cli)).expect(404);
      const full = (await http().get('/api/v1/kb/como-trocar-as-senhas-da-vpn').set(auth(cli)).expect(200)).body as KbArticle;
      expect(full.body).toContain('Trocar senha');

      const search = (await http().get('/api/v1/kb').set(auth(cli)).query({ q: 'senha' }).expect(200)).body as Paginated<KbArticleSummary>;
      expect(search.items.map((a) => a.slug)).toEqual(['como-trocar-as-senhas-da-vpn']);
      const staffSearch = (await http().get('/api/v1/kb').set(auth(agent)).query({ q: 'senha' }).expect(200)).body as Paginated<KbArticleSummary>;
      expect(staffSearch.items).toHaveLength(2);

      // frase inteira digitada pelo cliente: basta um termo relevante casar ("consigo" não está no artigo)
      const phrase = (await http().get('/api/v1/kb').set(auth(cli)).query({ q: 'não consigo trocar minha senha' }).expect(200)).body as Paginated<KbArticleSummary>;
      expect(phrase.items.map((a) => a.slug)).toEqual(['como-trocar-as-senhas-da-vpn']);
      const nothing = (await http().get('/api/v1/kb').set(auth(cli)).query({ q: 'impressora' }).expect(200)).body as Paginated<KbArticleSummary>;
      expect(nothing.items).toEqual([]);
    });

    it('cliente não escreve; equipe edita, arquiva e remove', async () => {
      await http().post('/api/v1/kb').set(auth(cli)).send({ title: 'x' }).expect(403);
      await http().patch(`/api/v1/kb/${published.id}`).set(auth(cli)).send({ title: 'x' }).expect(403);

      const edited = await http().patch(`/api/v1/kb/${published.id}`).set(auth(agent)).send({ title: 'Trocar senha da VPN' }).expect(200);
      expect(edited.body.slug).toBe('como-trocar-as-senhas-da-vpn'); // slug estável
      const archived = await http().patch(`/api/v1/kb/${published.id}`).set(auth(agent)).send({ status: 'archived' }).expect(200);
      expect(archived.body.publishedAt).toBe(published.publishedAt);
      expect((await http().get('/api/v1/kb').set(auth(cli)).expect(200)).body.items).toEqual([]);

      await http().patch(`/api/v1/kb/${published.id}`).set(auth(agent)).send({ slug: 'Slug Inválido' }).expect(400);
      await http().delete(`/api/v1/kb/${published.id}`).set(auth(agent)).expect(204);
      await http().delete(`/api/v1/kb/${published.id}`).set(auth(agent)).expect(404);
    });

    it('paginação por cursor', async () => {
      for (let i = 0; i < 4; i++) await http().post('/api/v1/kb').set(auth(agent)).send({ title: `Artigo ${i}` }).expect(201);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Paginated<KbArticleSummary> = (await http().get('/api/v1/kb').set(auth(agent)).query({ limit: 2, ...(cursor ? { cursor } : {}) }).expect(200)).body;
        seen.push(...page.items.map((a) => a.id));
        cursor = page.nextCursor;
      } while (cursor);
      const all = (await http().get('/api/v1/kb').set(auth(agent)).query({ limit: 100 }).expect(200)).body.items.map((a: KbArticleSummary) => a.id);
      expect(seen).toEqual(all);
    });
  });

  // ======================================================================
  describe('tenant', () => {
    it('plano, uso e assinatura (só admin vê a assinatura)', async () => {
      const t = (await http().get('/api/v1/tenant').set(auth(admin)).expect(200)).body as TenantInfo;
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
        [tenantId],
      );
      expect(t).toMatchObject({ slug: 'e2e-admin', status: 'trial', plan: { id: 'starter', priceCents: 4900, maxAgents: 3 }, usage: { ticketsThisMonth: rows[0]!.n } });
      expect(t.subscription).toMatchObject({ status: 'trialing' });
      expect(((await http().get('/api/v1/tenant').set(auth(agent)).expect(200)).body as TenantInfo).subscription).toBeNull();
      await http().get('/api/v1/tenant').set(auth(cli)).expect(403);
    });

    it('só admin altera nome/fuso; fuso validado', async () => {
      await http().patch('/api/v1/tenant').set(auth(agent)).send({ name: 'Hack' }).expect(403);
      await http().patch('/api/v1/tenant').set(auth(admin)).send({ timezone: 'Lua/Crateras' }).expect(400);
      const t = await http().patch('/api/v1/tenant').set(auth(admin)).send({ name: 'Admin E2E Renomeado', timezone: 'America/Recife' }).expect(200);
      expect(t.body).toMatchObject({ name: 'Admin E2E Renomeado', timezone: 'America/Recife' });
      await http().patch('/api/v1/tenant').set(auth(admin)).send({ name: 'Admin E2E', timezone: 'America/Sao_Paulo' }).expect(200);
    });
  });

  // ======================================================================
  describe('relatórios', () => {
    it('cliente não acessa', async () => {
      await http().get('/api/v1/reports/overview').set(auth(cli)).expect(403);
    });

    it('números do workspace demo batem com contagens feitas direto no SQL', async () => {
      const { token } = await login(app, 'admin@demo.local');
      const r = (await http().get('/api/v1/reports/overview').set(auth(token)).expect(200)).body as ReportsOverview;
      const demo = (await db.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'demo'`)).rows[0]!.id;
      const one = async <T>(sql: string): Promise<T> => (await db.query(sql, [demo])).rows[0].v as T;

      // estado atual por status (não resolvidos/fechados)
      const open = await db.query<{ name: string; n: number }>(
        `SELECT s.name, count(t.id)::int AS n FROM statuses s LEFT JOIN tickets t ON t.status_id = s.id
          WHERE s.tenant_id = $1 AND s.kind NOT IN ('resolved', 'closed') GROUP BY s.name`,
        [demo],
      );
      expect(Object.fromEntries(r.openByStatus.map((s) => [s.name, s.count]))).toEqual(Object.fromEntries(open.rows.map((x) => [x.name, x.n])));
      // seed: Novo 3, Em atendimento 2, Aguardando cliente 1, Em espera 1
      expect(Object.fromEntries(r.openByStatus.map((s) => [s.name, s.count]))).toEqual({ Novo: 3, 'Em atendimento': 2, 'Aguardando cliente': 1, 'Em espera': 1 });

      expect(r.overdue).toBe(
        await one<number>(`SELECT count(DISTINCT st.ticket_id)::int AS v FROM sla_timers st
                            WHERE st.tenant_id = $1 AND st.met_at IS NULL AND st.paused_at IS NULL AND st.due_at < now()`),
      );
      expect(r.avgFirstResponseMinutes).toBeCloseTo(
        await one<number>(`SELECT round(avg(extract(epoch FROM first_response_at - created_at) / 60)::numeric, 1)::float AS v
                             FROM tickets WHERE tenant_id = $1 AND first_response_at IS NOT NULL AND created_at > now() - interval '30 days'`),
        1,
      );
      expect(r.avgFirstResponseMinutes).toBeCloseTo(20, 0); // seed: resposta 20 min após abrir
      expect(r.ticketsPerDay).toHaveLength(30);
      expect(r.ticketsPerDay.reduce((a, d) => a + d.created, 0)).toBe(await one<number>(`SELECT count(*)::int AS v FROM tickets WHERE tenant_id = $1`));
      expect(Object.fromEntries(r.byCategory.map((c) => [c.name, c.count]))).toEqual({ Incidente: 4, 'Solicitação': 3, 'Dúvida': 3 });
      const carlos = r.byAgent.find((a) => a.name === 'Carlos Souza')!;
      expect(carlos.open).toBe(
        await one<number>(`SELECT count(*)::int AS v FROM tickets t JOIN statuses s ON s.id = t.status_id JOIN users u ON u.id = t.assignee_id
                            WHERE t.tenant_id = $1 AND u.email = 'carlos@demo.local' AND s.kind NOT IN ('resolved', 'closed')`),
      );
      expect(r.minutesTracked).toBe(await one<number>(`SELECT COALESCE(sum(minutes), 0)::int AS v FROM time_entries WHERE tenant_id = $1`));
      expect(r.slaCompliancePct === null || (r.slaCompliancePct >= 0 && r.slaCompliancePct <= 100)).toBe(true);
    });
  });
});
