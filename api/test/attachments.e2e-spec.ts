import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import request from 'supertest';
import type { TicketDetail } from '@helpdesk/shared';
import { addMember, auth, cleanup, createApp, E2E_DOMAIN, login, superDb } from './helpers.js';

const PW = 'senha-123456';

describe('Anexos (e2e: Postgres + S3 reais)', () => {
  let app: NestExpressApplication;
  let db: pg.Pool;
  let agent: string;
  let cli: string;
  let other: string; // cliente 2
  let ticketId: string;
  const http = () => request(app.getHttpServer());

  /** Fluxo completo do navegador: presign → PUT direto no S3 → confirm. */
  async function upload(token: string, tId: string, content: Buffer | string, filename = 'relatório março.pdf', contentType = 'application/pdf', extra: Record<string, unknown> = {}) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const pre = await http().post(`/api/v1/tickets/${tId}/attachments/presign`).set(auth(token)).send({ filename, contentType, size: body.length }).expect(200);
    const put = await fetch(pre.body.uploadUrl, { method: 'PUT', body: new Uint8Array(body), headers: pre.body.headers });
    expect(put.status).toBe(200);
    return http().post(`/api/v1/tickets/${tId}/attachments/confirm`).set(auth(token)).send({ storageKey: pre.body.storageKey, filename, contentType, size: body.length, ...extra });
  }

  beforeAll(async () => {
    db = superDb();
    await cleanup(db);
    app = await createApp();
    const res = await http().post('/api/v1/auth/signup').send({ workspaceName: 'Anexos', slug: 'e2e-anexos', name: 'Admin', email: `admin-anx@${E2E_DOMAIN}`, password: PW }).expect(201);
    const tenantId = (await http().get('/api/v1/auth/me').set(auth(res.body.accessToken))).body.tenant.id;
    await addMember(db, tenantId, `agente-anx@${E2E_DOMAIN}`, 'agent');
    await addMember(db, tenantId, `cli-anx@${E2E_DOMAIN}`, 'requester');
    await addMember(db, tenantId, `cli2-anx@${E2E_DOMAIN}`, 'requester');
    agent = (await login(app, `agente-anx@${E2E_DOMAIN}`, PW)).token;
    cli = (await login(app, `cli-anx@${E2E_DOMAIN}`, PW)).token;
    other = (await login(app, `cli2-anx@${E2E_DOMAIN}`, PW)).token;
    ticketId = (await http().post('/api/v1/tickets').set(auth(cli)).send({ subject: 'Com anexo' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db);
    await db.end();
  });

  it('cliente envia, aparece no chamado e baixa o mesmo conteúdo', async () => {
    const res = await upload(cli, ticketId, '%PDF-1.4 conteúdo de teste');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ filename: 'relatório março.pdf', contentType: 'application/pdf', sizeBytes: Buffer.byteLength('%PDF-1.4 conteúdo de teste') });

    const detail = (await http().get(`/api/v1/tickets/${ticketId}`).set(auth(agent)).expect(200)).body as TicketDetail;
    expect(detail.attachments.map((a) => a.id)).toContain(res.body.id);

    const dl = await http().get(`/api/v1/attachments/${res.body.id}/download`).set(auth(agent)).expect(200);
    const file = await fetch(dl.body.url);
    expect(await file.text()).toBe('%PDF-1.4 conteúdo de teste');
    expect(file.headers.get('content-disposition')).toContain("filename*=UTF-8''relat%C3%B3rio%20mar%C3%A7o.pdf");
    // chave no storage: prefixo do tenant/chamado e nome higienizado
    const { rows } = await db.query<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE id = $1', [res.body.id]);
    expect(rows[0]!.storage_key).toMatch(new RegExp(`/${ticketId}/[0-9a-f-]{36}-relatorio-marco\\.pdf$`));
  });

  it('tipo proibido, tamanho acima de 25 MB e corpo diferente do assinado são recusados', async () => {
    const svg = await http().post(`/api/v1/tickets/${ticketId}/attachments/presign`).set(auth(cli)).send({ filename: 'x.svg', contentType: 'image/svg+xml', size: 10 }).expect(400);
    expect(svg.body.details).toEqual([{ field: 'contentType', message: 'tipo de arquivo não permitido' }]);
    await http().post(`/api/v1/tickets/${ticketId}/attachments/presign`).set(auth(cli)).send({ filename: 'x.zip', contentType: 'application/zip', size: 25 * 1024 * 1024 + 1 }).expect(400);

    // assinou 5 bytes, tenta subir 50: o próprio S3 recusa
    const pre = await http().post(`/api/v1/tickets/${ticketId}/attachments/presign`).set(auth(cli)).send({ filename: 'a.txt', contentType: 'text/plain', size: 5 }).expect(200);
    const put = await fetch(pre.body.uploadUrl, { method: 'PUT', body: new Uint8Array(Buffer.alloc(50, 'x')), headers: pre.body.headers });
    expect(put.status).toBeGreaterThanOrEqual(400);
    // confirm sem o objeto no storage
    const conf = await http().post(`/api/v1/tickets/${ticketId}/attachments/confirm`).set(auth(cli)).send({ storageKey: pre.body.storageKey, filename: 'a.txt', contentType: 'text/plain', size: 5 }).expect(422);
    expect(conf.body.code).toBe('invalid_reference');
  });

  it('não dá para confirmar arquivo de outro chamado/tenant (chave forjada)', async () => {
    const mine = (await http().post('/api/v1/tickets').set(auth(other)).send({ subject: 'Outro' }).expect(201)).body.id;
    const pre = await http().post(`/api/v1/tickets/${ticketId}/attachments/presign`).set(auth(cli)).send({ filename: 'a.txt', contentType: 'text/plain', size: 3 }).expect(200);
    await fetch(pre.body.uploadUrl, { method: 'PUT', body: 'abc', headers: pre.body.headers });
    const forged = await http().post(`/api/v1/tickets/${mine}/attachments/confirm`).set(auth(other)).send({ storageKey: pre.body.storageKey, filename: 'a.txt', contentType: 'text/plain', size: 3 }).expect(422);
    expect(forged.body.code).toBe('invalid_reference');
  });

  it('outro cliente não presigna, não lista e não baixa anexo de chamado alheio (404)', async () => {
    const att = (await upload(cli, ticketId, 'segredo do cliente 1', 'nota.txt', 'text/plain')).body.id as string;
    await http().post(`/api/v1/tickets/${ticketId}/attachments/presign`).set(auth(other)).send({ filename: 'a.txt', contentType: 'text/plain', size: 3 }).expect(404);
    await http().get(`/api/v1/attachments/${att}/download`).set(auth(other)).expect(404);
    await http().get(`/api/v1/tickets/${ticketId}`).set(auth(other)).expect(404);
  });

  it('anexo de nota interna é invisível para o cliente', async () => {
    const note = (await http().post(`/api/v1/tickets/${ticketId}/messages`).set(auth(agent)).send({ kind: 'internal_note', body: 'log do servidor' }).expect(201)).body.id;
    const att = (await upload(agent, ticketId, 'log interno', 'servidor.txt', 'text/plain', { messageId: note })).body.id as string;
    await http().get(`/api/v1/attachments/${att}/download`).set(auth(agent)).expect(200);
    await http().get(`/api/v1/attachments/${att}/download`).set(auth(cli)).expect(404);
    const view = (await http().get(`/api/v1/tickets/${ticketId}`).set(auth(cli)).expect(200)).body as TicketDetail;
    expect(view.attachments.map((a) => a.id)).not.toContain(att);
  });

  it('remover: quem enviou ou a equipe; outro cliente não', async () => {
    const att = (await upload(cli, ticketId, 'apagar', 'apagar.txt', 'text/plain')).body.id as string;
    const key = (await db.query<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE id = $1', [att])).rows[0]!.storage_key;
    await http().delete(`/api/v1/attachments/${att}`).set(auth(other)).expect(404);
    await http().delete(`/api/v1/attachments/${att}`).set(auth(cli)).expect(204);
    await http().get(`/api/v1/attachments/${att}/download`).set(auth(agent)).expect(404);
    expect((await db.query('SELECT 1 FROM attachments WHERE storage_key = $1', [key])).rowCount).toBe(0);
  });
});
