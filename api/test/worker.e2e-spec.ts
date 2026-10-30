import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { validateWorkerEnv, type WorkerEnv } from '../src/worker/worker.env.js';
import { WorkerJobsModule, WorkerModule } from '../src/worker/worker.module.js';
import { OutboxJob } from '../src/worker/email/outbox.job.js';
import { SlaJob } from '../src/worker/sla.job.js';
import { AutomationJob } from '../src/worker/automation/automation.job.js';
import { addMember, auth, cleanup, createApp, E2E_DOMAIN, login, superDb } from './helpers.js';

const PW = 'senha-123456';
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';

/** Contexto de worker isolado (pool próprio), com configuração sobrescrita só para ele. */
async function worker(overrides: Partial<Record<keyof WorkerEnv, string>> = {}, mod: typeof WorkerJobsModule | typeof WorkerModule = WorkerJobsModule) {
  const env = validateWorkerEnv({
    ...process.env,
    WORKER_SLA_INTERVAL_MS: '0',
    WORKER_EMAIL_INTERVAL_MS: '0',
    WORKER_AUTOMATION_INTERVAL_MS: '0',
    ...overrides,
  });
  const ref: TestingModule = await Test.createTestingModule({ imports: [mod] })
    .overrideProvider(ConfigService)
    .useValue({ get: (k: keyof WorkerEnv) => env[k] })
    .compile();
  await ref.init();
  return ref;
}

async function mailpitTo(address: string): Promise<Array<{ Subject: string; ID: string }>> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=200`);
  const body = (await res.json()) as { messages: Array<{ Subject: string; ID: string }> };
  return body.messages;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado esperando condição');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('Worker (e2e: Postgres + Mailpit reais)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  let w: TestingModule;
  const http = () => request(app.getHttpServer());

  let tenantId: string;
  let agentToken: string;
  let ids: { agent: string; cli: string };
  let priorities: Record<string, string>;

  /** Esvazia a outbox com o worker "bom" para os testes começarem sem pendências alheias. */
  const drain = async () => {
    while ((await w.get(OutboxJob).runOnce()).claimed > 0);
  };

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    await db.query(`DELETE FROM email_outbox WHERE tenant_id IS NULL AND to_email LIKE $1`, [`%@${E2E_DOMAIN}`]);
    // caixa do Mailpit limpa: as contagens por destinatário precisam começar do zero
    await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
    app = await createApp();
    w = await worker();

    const res = await http()
      .post('/api/v1/auth/signup')
      .send({ workspaceName: 'Worker E2E', slug: 'e2e-worker', name: 'Admin W', email: `admin-w@${E2E_DOMAIN}`, password: PW })
      .expect(201);
    tenantId = (await http().get('/api/v1/auth/me').set(auth(res.body.accessToken)).expect(200)).body.tenant.id;
    ids = {
      agent: await addMember(db, tenantId, `agente-w@${E2E_DOMAIN}`, 'agent', { name: 'Agente W' }),
      cli: await addMember(db, tenantId, `cli-w@${E2E_DOMAIN}`, 'requester', { name: 'Cliente W' }),
    };
    agentToken = (await login(app, `agente-w@${E2E_DOMAIN}`, PW)).token;
    priorities = Object.fromEntries(
      ((await http().get('/api/v1/catalog/priorities').set(auth(agentToken)).expect(200)).body as Array<{ id: string; name: string }>).map((p) => [p.name, p.id]),
    );
    await drain();
  });

  afterAll(async () => {
    await w.close();
    await app.close();
    await cleanup(db);
    await db.end();
  });

  // ======================================================================
  describe('outbox de e-mail', () => {
    it('abrir chamado gera e-mail no Mailpit e a linha fica "sent"', async () => {
      const cli = (await login(app, `cli-w@${E2E_DOMAIN}`, PW)).token;
      const t = (await http().post('/api/v1/tickets').set(auth(cli)).send({ subject: 'Monitor piscando' }).expect(201)).body;

      const r = await w.get(OutboxJob).runOnce();
      expect(r.sent).toBeGreaterThanOrEqual(1);
      const msgs = await waitFor(async () => {
        const m = await mailpitTo(`cli-w@${E2E_DOMAIN}`);
        return m.length ? m : null;
      });
      expect(msgs.map((m) => m.Subject)).toContain(`[Worker E2E] Chamado #${t.number} recebido: Monitor piscando`);

      const row = await db.query(`SELECT status, attempts, sent_at FROM email_outbox WHERE payload->>'ticket_id' = $1`, [t.id]);
      expect(row.rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('resposta da equipe vai por e-mail; nota interna nunca', async () => {
      const t = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Teste de resposta', requesterId: ids.cli }).expect(201)).body;
      await http().post(`/api/v1/tickets/${t.id}/messages`).set(auth(agentToken)).send({ kind: 'internal_note', body: 'SEGREDO-INTERNO' }).expect(201);
      await http().post(`/api/v1/tickets/${t.id}/messages`).set(auth(agentToken)).send({ kind: 'public_reply', body: 'Resposta pública ao cliente' }).expect(201);
      await drain();

      const msgs = await mailpitTo(`cli-w@${E2E_DOMAIN}`);
      const reply = msgs.find((m) => m.Subject.includes(`Re: #${t.number}`))!;
      expect(reply).toBeDefined();
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${reply.ID}`)).json()) as { Text: string; HTML: string };
      expect(full.Text).toContain('Resposta pública ao cliente');
      const all = await Promise.all(msgs.map(async (m) => (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Text: string }));
      expect(all.some((m) => m.Text.includes('SEGREDO-INTERNO'))).toBe(false);
    });

    it('dois workers simultâneos não enviam o mesmo e-mail duas vezes', async () => {
      const w1 = await worker({ EMAIL_BATCH_SIZE: '4' });
      const w2 = await worker({ EMAIL_BATCH_SIZE: '4' });
      try {
        const N = 40;
        const emails = Array.from({ length: N }, (_, i) => `concorrencia-${i}@${E2E_DOMAIN}`);
        await db.query(
          `INSERT INTO email_outbox (tenant_id, to_email, template, payload)
           SELECT $1, e, 'ticket_created', jsonb_build_object('ticket_id', gen_random_uuid(), 'number', 1, 'subject', 'Concorrência')
             FROM unnest($2::text[]) e`,
          [tenantId, emails],
        );

        let totalSent = 0;
        const perWorker = [0, 0];
        for (;;) {
          const [a, b] = await Promise.all([w1.get(OutboxJob).runOnce(), w2.get(OutboxJob).runOnce()]);
          perWorker[0]! += a.sent;
          perWorker[1]! += b.sent;
          totalSent += a.sent + b.sent;
          if (a.claimed + b.claimed === 0) break;
        }
        expect(totalSent).toBe(N);
        expect(perWorker[0]).toBeGreaterThan(0); // os dois trabalharam de fato
        expect(perWorker[1]).toBeGreaterThan(0);

        const rows = await db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM email_outbox WHERE to_email = ANY($1)`, [emails]);
        expect(rows.rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
        const counts = await Promise.all(emails.map(async (e) => (await mailpitTo(e)).length));
        expect(counts).toEqual(Array(N).fill(1));
      } finally {
        await w1.close();
        await w2.close();
      }
    });

    it('falha de SMTP: backoff exponencial, desiste após N tentativas e apaga o token', async () => {
      await drain();
      const bad = await worker({ SMTP_PORT: '1', EMAIL_MAX_ATTEMPTS: '2', EMAIL_BACKOFF_BASE_SECONDS: '30' });
      try {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO email_outbox (tenant_id, to_email, template, payload) VALUES (NULL, $1, 'password_reset', '{"name":"X","token":"segredo"}') RETURNING id`,
          [`falha@${E2E_DOMAIN}`],
        );
        const id = rows[0]!.id;
        const row = async () =>
          (await db.query<{ status: string; attempts: number; last_error: string | null; wait: number; has_token: boolean }>(
            `SELECT status, attempts, last_error, EXTRACT(epoch FROM scheduled_at - now())::int AS wait, payload ? 'token' AS has_token FROM email_outbox WHERE id = $1`,
            [id],
          )).rows[0]!;

        expect((await bad.get(OutboxJob).runOnce()).failed).toBe(1);
        let r = await row();
        expect(r).toMatchObject({ status: 'failed', attempts: 1, has_token: true });
        expect(r.last_error).toBeTruthy();
        expect(r.wait).toBeGreaterThanOrEqual(25); // 30 s
        expect((await bad.get(OutboxJob).runOnce()).claimed).toBe(0); // ainda em espera

        await db.query(`UPDATE email_outbox SET scheduled_at = now() WHERE id = $1`, [id]);
        await bad.get(OutboxJob).runOnce();
        r = await row();
        expect(r).toMatchObject({ status: 'failed', attempts: 2, has_token: false }); // desistiu e apagou o segredo
        expect(r.wait).toBeGreaterThanOrEqual(55); // 60 s (exponencial)

        await db.query(`UPDATE email_outbox SET scheduled_at = now() WHERE id = $1`, [id]);
        expect((await bad.get(OutboxJob).runOnce()).claimed).toBe(0); // não tenta mais
      } finally {
        await bad.close();
      }
    });

    it('linha presa em "sending" (worker morreu) é retomada quando a reserva expira; token apagado após envio', async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO email_outbox (tenant_id, to_email, template, payload, status, attempts, scheduled_at)
         VALUES (NULL, $1, 'password_reset', '{"name":"Y","token":"abc"}', 'sending', 1, now() - interval '1 second') RETURNING id`,
        [`preso@${E2E_DOMAIN}`],
      );
      await w.get(OutboxJob).runOnce();
      const r = await db.query(`SELECT status, attempts, payload FROM email_outbox WHERE id = $1`, [rows[0]!.id]);
      expect(r.rows[0]).toMatchObject({ status: 'sent', attempts: 2, payload: { name: 'Y' } });
      expect((await mailpitTo(`preso@${E2E_DOMAIN}`)).length).toBe(1);
    });
  });

  // ======================================================================
  describe('SLA', () => {
    it('chamado vencido é marcado pelo agendador em até 1 minuto (intervalo real do job)', async () => {
      const t = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Vai vencer', requesterId: ids.cli }).expect(201)).body;
      await db.query(`UPDATE sla_timers SET due_at = now() - interval '1 second' WHERE ticket_id = $1 AND kind = 'resolution'`, [t.id]);

      // o worker real com agendador (intervalo de 1 minuto em produção; aqui 1 s para o teste ser rápido)
      const scheduled = await worker({ WORKER_SLA_INTERVAL_MS: '1000' }, WorkerModule);
      try {
        const breachedAt = await waitFor(async () => {
          const r = await db.query<{ breached_at: Date | null }>(`SELECT breached_at FROM sla_timers WHERE ticket_id = $1 AND kind = 'resolution'`, [t.id]);
          return r.rows[0]?.breached_at;
        }, 5_000);
        expect(breachedAt).toBeInstanceOf(Date);
      } finally {
        await scheduled.close();
      }
      const ev = await db.query(`SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND event_type = 'sla_breached'`, [t.id]);
      expect(ev.rows[0].n).toBe(1);
      expect((await http().get('/api/v1/tickets').set(auth(agentToken)).query({ sla: 'breached', limit: 100 }).expect(200)).body.items.map((x: { id: string }) => x.id)).toContain(t.id);
    });

    it('padrão do agendador do SLA é 1 minuto', () => {
      expect(validateWorkerEnv({ DATABASE_URL_WORKER: 'postgresql://x@localhost/y' }).WORKER_SLA_INTERVAL_MS).toBe(60_000);
    });

    it('alerta de 80% do prazo: uma vez só, para o responsável, mesmo com dois workers', async () => {
      // chamado aberto há 1 h com prazo daqui a 10 min → 86% do prazo consumido
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO tickets (tenant_id, subject, requester_id, assignee_id, created_at)
         VALUES ($1, 'Quase vencendo', $2, $3, now() - interval '1 hour') RETURNING id`,
        [tenantId, ids.cli, ids.agent],
      );
      const ticketId = rows[0]!.id;
      await db.query(`UPDATE sla_timers SET due_at = now() + interval '10 minutes', breached_at = NULL WHERE ticket_id = $1`, [ticketId]);

      const w2 = await worker();
      try {
        const [a, b] = await Promise.all([w.get(SlaJob).runOnce(), w2.get(SlaJob).runOnce()]);
        const again = await w.get(SlaJob).runOnce();
        expect(a.warned + b.warned).toBeGreaterThanOrEqual(2); // 2 cronômetros deste chamado
        expect(again.warned).toBe(0);
      } finally {
        await w2.close();
      }
      const alerts = await db.query(`SELECT count(*)::int AS n FROM sla_alerts a JOIN sla_timers st ON st.id = a.timer_id WHERE st.ticket_id = $1`, [ticketId]);
      expect(alerts.rows[0].n).toBe(2);
      const ev = await db.query(`SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND event_type = 'sla_warning'`, [ticketId]);
      expect(ev.rows[0].n).toBe(2);
      const mails = await db.query<{ to_email: string }>(`SELECT to_email FROM email_outbox WHERE template = 'sla_warning' AND payload->>'ticket_id' = $1`, [ticketId]);
      expect(mails.rows.map((r) => r.to_email)).toEqual([`agente-w@${E2E_DOMAIN}`, `agente-w@${E2E_DOMAIN}`]);

      await drain();
      expect((await mailpitTo(`agente-w@${E2E_DOMAIN}`)).filter((m) => m.Subject.includes('SLA perto de vencer: #')).length).toBe(2);
    });
  });

  // ======================================================================
  describe('automações', () => {
    let adminToken: string;
    let queueId: string;

    const runs = async (eventId: string) =>
      (await db.query(`SELECT rules_matched, skipped, error FROM automation_runs WHERE event_id = $1`, [eventId])).rows[0];
    const automate = async () => {
      let total = 0;
      for (;;) {
        const r = await w.get(AutomationJob).runOnce();
        total += r.processed;
        if (!r.processed) return total;
      }
    };

    beforeAll(async () => {
      adminToken = (await login(app, `admin-w@${E2E_DOMAIN}`, PW)).token;
      queueId = (await http().post('/api/v1/catalog/queues').set(auth(adminToken)).send({ name: 'Plantão' }).expect(201)).body.id;
      await http()
        .post('/api/v1/catalog/automation-rules')
        .set(auth(adminToken))
        .send({
          name: 'Urgente vai para o plantão',
          event: 'ticket_created',
          conditions: [{ field: 'priority.name', op: 'eq', value: 'Urgente' }],
          actions: [{ type: 'assign_queue', queueId }, { type: 'add_tag', value: 'plantao' }, { type: 'notify_staff' }],
        })
        .expect(201);
      await automate(); // eventos anteriores deste e de outros tenants
    });

    afterEach(async () => {
      await db.query(`UPDATE tenants SET plan_id = 'starter' WHERE id = $1`, [tenantId]);
    });

    it('plano sem automações (Starter): evento é registrado mas nenhuma regra roda', async () => {
      const t = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Urgente no starter', requesterId: ids.cli, priorityId: priorities['Urgente'] }).expect(201)).body;
      await automate();
      const detail = (await http().get(`/api/v1/tickets/${t.id}`).set(auth(agentToken)).expect(200)).body;
      expect(detail.tags).toEqual([]);
      expect(await runs(detail.events[0].id)).toMatchObject({ rules_matched: 0, skipped: false });
    });

    it('plano Pro: regra casa, aplica ações, notifica a equipe; os eventos gerados não reentram', async () => {
      await db.query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [tenantId]);
      const t = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Servidor caiu', requesterId: ids.cli, priorityId: priorities['Urgente'] }).expect(201)).body;
      const normal = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Dúvida simples', requesterId: ids.cli }).expect(201)).body;
      expect(await automate()).toBeGreaterThanOrEqual(2);

      const d = (await http().get(`/api/v1/tickets/${t.id}`).set(auth(agentToken)).expect(200)).body;
      expect(d.queue).toMatchObject({ id: queueId, name: 'Plantão' });
      expect(d.tags).toEqual(['plantao']);
      const created = d.events.find((e: { type: string }) => e.type === 'created');
      const queueChanged = d.events.find((e: { type: string }) => e.type === 'queue_changed');
      expect(queueChanged.actor).toBeNull(); // feito pela automação
      expect(await runs(created.id)).toMatchObject({ rules_matched: 1, error: null });
      expect(await runs(queueChanged.id)).toMatchObject({ skipped: true });

      const n = (await http().get(`/api/v1/tickets/${normal.id}`).set(auth(agentToken)).expect(200)).body;
      expect(n.tags).toEqual([]);
      expect(n.queue?.id).not.toBe(queueId);

      const notified = await db.query<{ to_email: string }>(`SELECT to_email FROM email_outbox WHERE template = 'notify_staff' AND payload->>'ticket_id' = $1 ORDER BY to_email`, [t.id]);
      expect(notified.rows.map((r) => r.to_email)).toEqual([`admin-w@${E2E_DOMAIN}`, `agente-w@${E2E_DOMAIN}`]);
      expect(await automate()).toBe(0); // nada novo para processar
    });

    it('sem loop: duas regras que se desfazem mutuamente param após uma aplicação', async () => {
      await db.query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [tenantId]);
      const mk = (name: string, from: string, to: string) =>
        http()
          .post('/api/v1/catalog/automation-rules')
          .set(auth(adminToken))
          .send({ name, event: 'ticket_updated', conditions: [{ field: 'priority.name', op: 'eq', value: from }], actions: [{ type: 'set_priority', priorityId: priorities[to] }] })
          .expect(201);
      const r1 = (await mk('Alta vira Baixa', 'Alta', 'Baixa')).body.id;
      const r2 = (await mk('Baixa vira Alta', 'Baixa', 'Alta')).body.id;
      try {
        const t = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Pingue-pongue', requesterId: ids.cli }).expect(201)).body;
        await automate();
        await http().patch(`/api/v1/tickets/${t.id}`).set(auth(agentToken)).send({ priorityId: priorities['Alta'] }).expect(200);
        for (let i = 0; i < 3; i++) await automate();

        const d = (await http().get(`/api/v1/tickets/${t.id}`).set(auth(agentToken)).expect(200)).body;
        expect(d.priority.name).toBe('Baixa'); // aplicou uma vez e parou
        expect(d.events.filter((e: { type: string }) => e.type === 'priority_changed')).toHaveLength(2); // manual + automação
      } finally {
        await http().delete(`/api/v1/catalog/automation-rules/${r1}`).set(auth(adminToken)).expect(204);
        await http().delete(`/api/v1/catalog/automation-rules/${r2}`).set(auth(adminToken)).expect(204);
      }
    });

    it('ação inválida (responsável não é da equipe): erro registrado, chamado intacto', async () => {
      await db.query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [tenantId]);
      const rule = (
        await http()
          .post('/api/v1/catalog/automation-rules')
          .set(auth(adminToken))
          .send({ name: 'Atribui ao cliente (inválida)', event: 'ticket_created', conditions: [{ field: 'subject', op: 'contains', value: 'atribuir' }], actions: [{ type: 'assign_agent', userId: ids.cli }, { type: 'add_tag', value: 'nao-deve-ficar' }] })
          .expect(201)
      ).body.id;
      try {
        const t = (await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: 'Por favor atribuir', requesterId: ids.cli }).expect(201)).body;
        await automate();
        const d = (await http().get(`/api/v1/tickets/${t.id}`).set(auth(agentToken)).expect(200)).body;
        expect(d.assignee).toBeNull();
        expect(d.tags).toEqual([]);
        const run = await runs(d.events.find((e: { type: string }) => e.type === 'created').id);
        expect(run.rules_matched).toBe(1);
        expect(run.error).toMatch(/assignee_must_be_staff/);
      } finally {
        await http().delete(`/api/v1/catalog/automation-rules/${rule}`).set(auth(adminToken)).expect(204);
      }
    });

    it('dois workers simultâneos: cada evento é avaliado uma vez', async () => {
      await db.query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [tenantId]);
      const created = [];
      for (let i = 0; i < 6; i++) {
        created.push((await http().post('/api/v1/tickets').set(auth(agentToken)).send({ subject: `Urgente ${i}`, requesterId: ids.cli, priorityId: priorities['Urgente'] }).expect(201)).body.id as string);
      }
      const w2 = await worker();
      try {
        for (;;) {
          const [a, b] = await Promise.all([w.get(AutomationJob).runOnce(), w2.get(AutomationJob).runOnce()]);
          if (!a.processed && !b.processed) break;
        }
      } finally {
        await w2.close();
      }
      const notified = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_outbox WHERE template = 'notify_staff' AND payload->>'ticket_id' = ANY($1)`,
        [created],
      );
      expect(notified.rows[0]!.n).toBe(created.length * 2); // 2 membros da equipe, uma vez por chamado
      const tags = await db.query<{ tags: string[] }>(`SELECT tags FROM tickets WHERE id = ANY($1)`, [created]);
      expect(tags.rows.every((r) => r.tags.join() === 'plantao')).toBe(true);
    });
  });
});
