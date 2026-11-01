import type { TestingModule } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import { AutomationsProcessor } from '../src/worker/automations.processor.js';
import { OutboxProcessor } from '../src/worker/outbox.processor.js';
import { SlaJobs } from '../src/worker/sla.jobs.js';
import { WorkerDbService } from '../src/worker/worker-db.service.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import {
  API, assertMailpitUp, createTestApp, createWorkerCore, demoFixtures, inviteAndAccept, mailpitMessage, mailpitSearch,
  newTenant, superPool, tokenFor, uniq, type DemoFixtures, type TestApp,
} from './helpers.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- corpo JSON dos testes

let t: TestApp;
let su: pg.Pool;
let fx: DemoFixtures;
let w: TestingModule;
let outbox: OutboxProcessor;
let automations: AutomationsProcessor;
let sla: SlaJobs;
const tickets: string[] = [];
const tenants: string[] = [];

const post = (token: string, path: string, body: object) => t.http().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);
const patch = (token: string, path: string, body: object) => t.http().patch(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);
const get = (token: string, path: string) => t.http().get(`${API}${path}`).set('Authorization', `Bearer ${token}`);

async function createTicket(token: string, body: object): Promise<Body> {
  const r = await post(token, '/tickets', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  tickets.push(r.body.id);
  return r.body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await assertMailpitUp();
  t = await createTestApp();
  su = superPool();
  fx = await demoFixtures(su);
  w = await createWorkerCore();
  outbox = w.get(OutboxProcessor);
  automations = w.get(AutomationsProcessor);
  sla = w.get(SlaJobs);
  await outbox.drain(); // o que já estava na fila (seed, outros testes)
  await automations.drain();
});

afterAll(async () => {
  await su.query(`DELETE FROM email_outbox WHERE payload->>'ticket_id' = ANY($1)`, [tickets]);
  await su.query('DELETE FROM tickets WHERE id = ANY($1)', [tickets]);
  for (const id of tenants) await su.query('SELECT delete_tenant($1)', [id]);
  await su.query(`DELETE FROM email_outbox WHERE to_email LIKE '%.e2e-mail.test'`);
  await w.close();
  await su.end();
  await t.close();
});

describe('separação API x worker', () => {
  it('a aplicação HTTP não tem acesso à conexão sd_worker', () => {
    expect(() => t.app.get(WorkerDbService, { strict: false })).toThrow();
  });
});

describe('outbox de e-mail', () => {
  it('abrir chamado gera mensagem no Mailpit; resposta pública também; nota interna não', async () => {
    const subject = `Monitor piscando ${uniq()}`;
    const joao = await tokenFor(t, 'joao@acme.local');
    const tk = await createTicket(joao, { subject });
    await outbox.drain();

    const created = await mailpitSearch(`subject:"${subject}"`);
    expect(created.length).toBe(1);
    expect(created[0]!.To[0]!.Address).toBe('joao@acme.local');
    expect(created[0]!.Subject).toBe(`[Demo Suporte] Chamado #${tk.number} recebido: ${subject}`);
    const body = await mailpitMessage(created[0]!.ID);
    expect(body.Text).toContain(`/tickets/${tk.id}`);

    const carlos = await tokenFor(t, 'carlos@demo.local');
    await post(carlos, `/tickets/${tk.id}/messages`, { kind: 'internal_note', body: 'NOTA-SECRETA cliente chato' }).expect(201);
    await post(carlos, `/tickets/${tk.id}/messages`, { kind: 'public_reply', body: 'Já vamos trocar o cabo.' }).expect(201);
    await outbox.drain();
    const all = await mailpitSearch(`subject:"${subject}"`);
    expect(all.length).toBe(2);
    const reply = all.find((m) => m.Subject.includes('Re:'))!;
    const replyBody = await mailpitMessage(reply.ID);
    expect(replyBody.Text).toContain('Já vamos trocar o cabo.');
    expect((await mailpitSearch('NOTA-SECRETA')).length).toBe(0);
  });

  it('dois workers simultâneos não enviam o mesmo e-mail duas vezes', async () => {
    const run = uniq();
    const N = 40;
    for (let i = 0; i < N; i++) {
      await su.query(
        `INSERT INTO email_outbox (tenant_id, to_email, template, payload)
         VALUES ($1, $2, 'ticket_created', jsonb_build_object('ticket_id', gen_random_uuid(), 'number', $3::int, 'subject', $4::text))`,
        [fx.tenant, `p${i}@${run}.e2e-mail.test`, i, `Paralelo ${run} ${i}`],
      );
    }
    const a = await createWorkerCore({ OUTBOX_BATCH: 3 });
    const b = await createWorkerCore({ OUTBOX_BATCH: 3 });
    try {
      const [ca, cb] = await Promise.all([a.get(OutboxProcessor).drain(), b.get(OutboxProcessor).drain()]);
      expect(ca + cb).toBe(N);
    } finally {
      await a.close();
      await b.close();
    }
    const msgs = await mailpitSearch(`subject:"Paralelo ${run}"`);
    expect(msgs.length).toBe(N);
    expect(new Set(msgs.map((m) => m.To[0]!.Address)).size).toBe(N);
    expect(new Set(msgs.map((m) => m.MessageID)).size).toBe(N);
    const { rows } = await su.query<{ status: string; attempts: number; n: string }>(
      `SELECT status, attempts, count(*) AS n FROM email_outbox WHERE to_email LIKE $1 GROUP BY 1, 2`, [`%@${run}.e2e-mail.test`]);
    expect(rows).toEqual([{ status: 'sent', attempts: 1, n: String(N) }]);
  });

  it('falha no SMTP: tenta de novo com backoff e desiste após o limite', async () => {
    const run = uniq();
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO email_outbox (tenant_id, to_email, template, payload)
       VALUES ($1, $2, 'ticket_created', '{"number": 1, "subject": "x"}') RETURNING id::text`, [fx.tenant, `falha@${run}.e2e-mail.test`]);
    const id = rows[0]!.id;
    const bad = await createWorkerCore({ SMTP_PORT: 1, OUTBOX_MAX_ATTEMPTS: 2, OUTBOX_BACKOFF_BASE_SECONDS: 60 });
    const read = async () => (await su.query<{ status: string; attempts: number; last_error: string | null; wait: number }>(
      `SELECT status, attempts, last_error, extract(epoch FROM scheduled_at - now())::int AS wait FROM email_outbox WHERE id = $1`, [id])).rows[0]!;
    try {
      await bad.get(OutboxProcessor).processBatch();
      let r = await read();
      expect(r).toMatchObject({ status: 'failed', attempts: 1 });
      expect(r.last_error).toBeTruthy();
      expect(r.wait).toBeGreaterThan(50); // 60 s de espera

      await su.query('UPDATE email_outbox SET scheduled_at = now() WHERE id = $1', [id]);
      await bad.get(OutboxProcessor).processBatch();
      r = await read();
      expect(r).toMatchObject({ status: 'failed', attempts: 2 });
      expect(r.wait).toBeGreaterThan(110); // backoff dobrou: 120 s

      await su.query('UPDATE email_outbox SET scheduled_at = now() WHERE id = $1', [id]);
      expect((await bad.get(OutboxProcessor).processBatch()).claimed).toBe(0); // desistiu
    } finally {
      await bad.close();
    }
    // o limite usado foi o deste worker (2); remove para o worker padrão (limite 5) não tentar de novo
    await su.query('DELETE FROM email_outbox WHERE id = $1', [id]);
  });

  it('template desconhecido desiste na hora; reserva vencida (worker caiu) é retomada', async () => {
    const run = uniq();
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO email_outbox (tenant_id, to_email, template, payload) VALUES ($1, $2, 'nao_existe', '{}') RETURNING id::text`,
      [fx.tenant, `tpl@${run}.e2e-mail.test`]);
    await outbox.processBatch();
    const r = (await su.query('SELECT status, attempts FROM email_outbox WHERE id = $1', [rows[0]!.id])).rows[0];
    expect(r).toEqual({ status: 'failed', attempts: 5 });

    const stuck = await su.query<{ id: string }>(
      `INSERT INTO email_outbox (tenant_id, to_email, template, payload, status, attempts, scheduled_at)
       VALUES ($1, $2, 'ticket_created', '{"number": 2, "subject": "retomado"}', 'sending', 1, now() - interval '1 minute')
       RETURNING id::text`, [fx.tenant, `lease@${run}.e2e-mail.test`]);
    await outbox.drain();
    expect((await su.query('SELECT status, attempts FROM email_outbox WHERE id = $1', [stuck.rows[0]!.id])).rows[0])
      .toEqual({ status: 'sent', attempts: 2 });
  });

  it('convite: e-mail com link e o token sai do banco depois do envio', async () => {
    const s = await newTenant(t, 'mail', tenants);
    const email = `convidado-${s.slug}@e2e.test.local`;
    await post(s.accessToken, '/invitations', { email, role: 'agent' }).expect(201);
    const pending = await su.query(`SELECT payload ? 'token' AS has FROM email_outbox WHERE to_email = $1`, [email]);
    expect(pending.rows[0]).toEqual({ has: true });
    await outbox.drain();
    const msgs = await mailpitSearch(`to:"${email}"`);
    expect(msgs.length).toBe(1);
    expect((await mailpitMessage(msgs[0]!.ID)).Text).toMatch(/\/accept-invite\?token=[A-Za-z0-9_-]{30,}/);
    const sent = await su.query(`SELECT status, payload ? 'token' AS has FROM email_outbox WHERE to_email = $1`, [email]);
    expect(sent.rows[0]).toEqual({ status: 'sent', has: false });
  });
});

describe('SLA', () => {
  it('chamado vencido é marcado em até 1 minuto pelo worker agendado', async () => {
    const carlos = await tokenFor(t, 'carlos@demo.local');
    const tk = await createTicket(carlos, { subject: `Vai estourar ${uniq()}`, requesterId: fx.users.joao });
    await su.query(`UPDATE sla_timers SET due_at = now() - interval '1 second' WHERE ticket_id = $1 AND kind = 'resolution'`, [tk.id]);

    const app: INestApplicationContext = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    const start = Date.now();
    try {
      let breached: Date | null = null;
      while (Date.now() - start < 65_000) {
        const r = await su.query<{ breached_at: Date | null }>(
          `SELECT breached_at FROM sla_timers WHERE ticket_id = $1 AND kind = 'resolution'`, [tk.id]);
        breached = r.rows[0]!.breached_at;
        if (breached) break;
        await sleep(1000);
      }
      expect(breached).not.toBeNull();
      expect(Date.now() - start).toBeLessThanOrEqual(61_000);
    } finally {
      await app.close();
    }
    const detail = await get(carlos, `/tickets/${tk.id}`);
    expect(detail.body.sla.resolution.state).toBe('breached');
    expect(detail.body.events.map((e: Body) => e.type)).toContain('sla_breached');
  }, 90_000);

  it('alerta de 80% do prazo: uma vez, com e-mail para o responsável', async () => {
    const subject = `Quase vencendo ${uniq()}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO tickets (tenant_id, subject, requester_id, assignee_id, created_at)
       VALUES ($1, $2, $3, $4, now() - interval '90 minutes') RETURNING id`,
      [fx.tenant, subject, fx.users.maria, fx.users.carlos]);
    const id = rows[0]!.id;
    tickets.push(id);
    await su.query(`UPDATE sla_timers SET due_at = now() + interval '10 minutes' WHERE ticket_id = $1`, [id]);

    expect(await sla.warnNearDue()).toBeGreaterThanOrEqual(2); // primeira resposta e resolução
    const timers = await su.query(`SELECT kind, warned_at IS NOT NULL AS warned FROM sla_timers WHERE ticket_id = $1 ORDER BY kind`, [id]);
    expect(timers.rows.every((r) => r.warned)).toBe(true);
    const events = await su.query(`SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND event_type = 'sla_warning'`, [id]);
    expect(events.rows[0]).toEqual({ n: 2 });

    await sla.warnNearDue(); // não repete
    expect((await su.query(`SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND event_type = 'sla_warning'`, [id])).rows[0]).toEqual({ n: 2 });

    await outbox.drain();
    const msgs = await mailpitSearch(`subject:"perto de vencer" to:"carlos@demo.local"`);
    expect(msgs.some((m) => m.Subject.includes('SLA de resolução perto de vencer'))).toBe(true);
  });

  it('limpeza diária roda', async () => {
    const r = await sla.purge();
    expect(r.auth).toBeGreaterThanOrEqual(0);
  });
});

describe('automações', () => {
  let admin: string;
  let queueId: string;
  let urgente: string;
  let tenantId: string;

  beforeAll(async () => {
    const s = await newTenant(t, 'auto', tenants);
    admin = s.accessToken;
    tenantId = s.tenantId;
    await su.query("UPDATE tenants SET plan_id = 'pro' WHERE id = $1", [s.tenantId]);
    queueId = (await post(admin, '/queues', { name: 'Plantão' })).body.id;
    urgente = ((await get(admin, '/priorities')).body as Body[]).find((p) => p.name === 'Urgente')!.id;
    await post(admin, '/automation-rules', {
      name: 'Urgente vai para o plantão', event: 'ticket_created', position: 1,
      conditions: [{ field: 'subject', op: 'contains', value: 'urgente' }],
      actions: [{ type: 'set_priority', priority_id: urgente }, { type: 'assign_queue', queue_id: queueId },
        { type: 'add_tag', value: 'plantao' }, { type: 'notify_staff' }],
    }).expect(201);
    // se a automação disparasse em cascata, esta regra rodaria por causa da mudança de prioridade acima
    await post(admin, '/automation-rules', {
      name: 'Prioridade urgente', event: 'ticket_updated', position: 2,
      conditions: [{ field: 'priority.name', op: 'eq', value: 'Urgente' }],
      actions: [{ type: 'add_tag', value: 'cascata' }],
    }).expect(201);
    const agent = await inviteAndAccept(t, su, admin, `ag-${s.slug}@e2e.test.local`, 'agent');
    expect(agent.status).toBe(201);
  });

  it('aplica as ações da regra e notifica a equipe, sem cascata', async () => {
    const tk = await createTicket(admin, { subject: 'URGENTE: servidor caiu' });
    await automations.drain();
    const d = (await get(admin, `/tickets/${tk.id}`)).body;
    expect(d.priority.name).toBe('Urgente');
    expect(d.queue.id).toBe(queueId);
    expect(d.tags).toEqual(['plantao']); // sem 'cascata'
    expect(d.events.filter((e: Body) => e.type === 'automation_applied').length).toBe(1);
    expect(d.events.find((e: Body) => e.type === 'automation_applied').data.rules[0].name).toBe('Urgente vai para o plantão');

    await automations.drain(); // nada novo
    const again = (await get(admin, `/tickets/${tk.id}`)).body;
    expect(again.events.filter((e: Body) => e.type === 'automation_applied').length).toBe(1);

    // fila sem membros => toda a equipe ativa é avisada (admin + agente)
    const notes = await su.query(`SELECT to_email FROM email_outbox WHERE template = 'staff_notification' AND payload->>'ticket_id' = $1 ORDER BY 1`, [tk.id]);
    expect(notes.rows.length).toBe(2);
  });

  it('mudança feita por pessoa dispara regra de ticket_updated (uma vez)', async () => {
    const tk = await createTicket(admin, { subject: 'Dúvida comum' });
    await automations.drain();
    expect((await get(admin, `/tickets/${tk.id}`)).body.tags).toEqual([]);
    await patch(admin, `/tickets/${tk.id}`, { priorityId: urgente }).expect(200);
    await automations.drain();
    const d = (await get(admin, `/tickets/${tk.id}`)).body;
    expect(d.tags).toEqual(['cascata']);
    expect(d.events.filter((e: Body) => e.type === 'automation_applied').length).toBe(1);
  });

  it('duas instâncias avaliando ao mesmo tempo aplicam a regra uma vez só', async () => {
    const tk = await createTicket(admin, { subject: 'urgente de novo' });
    const a = await createWorkerCore();
    const b = await createWorkerCore();
    try {
      await Promise.all([a.get(AutomationsProcessor).drain(), b.get(AutomationsProcessor).drain()]);
    } finally {
      await a.close();
      await b.close();
    }
    const n = await su.query(`SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND event_type = 'automation_applied'`, [tk.id]);
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it('plano sem automações: eventos são ignorados', async () => {
    await su.query("UPDATE tenants SET plan_id = 'starter' WHERE id = $1", [tenantId]);
    const tk = await createTicket(admin, { subject: 'urgente mas no starter' });
    await automations.drain();
    expect((await get(admin, `/tickets/${tk.id}`)).body.tags).toEqual([]);
    const run = await su.query(
      `SELECT r.outcome FROM automation_runs r JOIN ticket_events e ON e.id = r.event_id WHERE e.ticket_id = $1 AND e.event_type = 'created'`, [tk.id]);
    expect(run.rows[0]).toEqual({ outcome: 'skipped' });
    await su.query("UPDATE tenants SET plan_id = 'pro' WHERE id = $1", [tenantId]);
  });

  it('ação inválida no momento da execução vira erro registrado, sem travar a fila', async () => {
    const agentId = (await su.query<{ id: string }>(
      `SELECT m.user_id AS id FROM memberships m WHERE m.tenant_id = $1 AND m.role = 'agent'`, [tenantId])).rows[0]!.id;
    await post(admin, '/automation-rules', {
      name: 'Atribui ao agente', event: 'ticket_created', position: 3,
      conditions: [{ field: 'subject', op: 'contains', value: 'atribuir' }],
      actions: [{ type: 'assign_agent', user_id: agentId }],
    }).expect(201);
    await su.query('UPDATE memberships SET active = false WHERE tenant_id = $1 AND user_id = $2', [tenantId, agentId]);
    const tk = await createTicket(admin, { subject: 'atribuir por favor' });
    const ok = await createTicket(admin, { subject: 'urgente depois do erro' });
    await automations.drain();
    const run = await su.query(
      `SELECT r.outcome, r.error FROM automation_runs r JOIN ticket_events e ON e.id = r.event_id WHERE e.ticket_id = $1 AND e.event_type = 'created'`, [tk.id]);
    expect(run.rows[0].outcome).toBe('error');
    expect(run.rows[0].error).toContain('assignee_must_be_staff');
    expect((await get(admin, `/tickets/${ok.id}`)).body.tags).toEqual(['plantao']);
  });
});
