import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from './mailer.service.js';
import { renderTemplate, UnknownTemplateError } from './templates.js';
import { WorkerConfig } from './worker-config.js';
import { WorkerDbService } from './worker-db.service.js';

interface OutboxRow {
  id: string;
  tenant_id: string | null;
  to_email: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Tempo que um e-mail fica "reservado" enquanto é enviado. Se o worker morrer, outro retoma depois disso. */
const LEASE = '5 minutes';
const MAX_BACKOFF_SECONDS = 3600;

/**
 * Consumidor da email_outbox. Seguro para várias instâncias:
 *  - a reserva é um único UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED): cada linha vai para UMA
 *    instância, que a marca `sending` com prazo (lease);
 *  - envio feito => `sent` (e o token de convite/reset sai do payload);
 *  - falha => `failed` com attempts+1, last_error e nova tentativa com backoff exponencial;
 *  - após OUTBOX_MAX_ATTEMPTS, desiste (a linha fica `failed` para inspeção).
 * Entrega "pelo menos uma vez": se o processo cair entre o SMTP aceitar e o UPDATE, o e-mail pode ser
 * reenviado depois do lease (o Message-ID é estável, o que ajuda o destino a deduplicar).
 */
@Injectable()
export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly db: WorkerDbService,
    private readonly mailer: MailerService,
    private readonly config: WorkerConfig,
  ) {}

  /** Processa um lote. Devolve quantos foram reservados (0 = fila vazia). */
  async processBatch(): Promise<{ claimed: number; sent: number; failed: number }> {
    const maxAttempts = this.config.get('OUTBOX_MAX_ATTEMPTS');
    const { rows } = await this.db.query<OutboxRow>(
      `WITH c AS (
         SELECT id FROM email_outbox
          WHERE status IN ('pending', 'failed', 'sending') AND scheduled_at <= now() AND attempts < $1
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT $2)
       UPDATE email_outbox o
          SET status = 'sending', attempts = o.attempts + 1, scheduled_at = now() + interval '${LEASE}'
         FROM c WHERE o.id = c.id
       RETURNING o.id::text, o.tenant_id, o.to_email::text, o.template, o.payload, o.attempts`,
      [maxAttempts, this.config.get('OUTBOX_BATCH')],
    );

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.sendOne(row);
        sent++;
      } catch (err) {
        failed++;
        await this.markFailed(row, err, maxAttempts);
      }
    }
    if (rows.length) this.logger.log({ claimed: rows.length, sent, failed }, 'outbox processada');
    return { claimed: rows.length, sent, failed };
  }

  /** Esvazia o que estiver pronto para envio agora. */
  async drain(maxBatches = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = await this.processBatch();
      total += r.claimed;
      if (!r.claimed) break;
    }
    return total;
  }

  private async sendOne(row: OutboxRow): Promise<void> {
    const ctx = await this.context(row);
    const mail = renderTemplate(row.template, row.payload, ctx);
    await this.mailer.send({ ...mail, to: row.to_email, outboxId: row.id });
    await this.db.query(
      `UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL, payload = payload - 'token'
        WHERE id = $1 AND status = 'sending'`,
      [row.id],
    );
  }

  private async markFailed(row: OutboxRow, err: unknown, maxAttempts: number): Promise<void> {
    const permanent = err instanceof UnknownTemplateError;
    const attempts = permanent ? maxAttempts : row.attempts;
    const delay = Math.min(this.config.get('OUTBOX_BACKOFF_BASE_SECONDS') * 2 ** (row.attempts - 1), MAX_BACKOFF_SECONDS);
    const message = err instanceof Error ? err.message : String(err);
    await this.db.query(
      `UPDATE email_outbox
          SET status = 'failed', attempts = $2, last_error = left($3, 500), scheduled_at = now() + make_interval(secs => $4)
        WHERE id = $1`,
      [row.id, attempts, message, delay],
    );
    const level = attempts >= maxAttempts ? 'error' : 'warn';
    this.logger[level]({ outboxId: row.id, template: row.template, attempts, error: message },
      attempts >= maxAttempts ? 'e-mail descartado após o limite de tentativas' : 'falha no envio; nova tentativa agendada');
  }

  private async context(row: OutboxRow) {
    const appUrl = this.config.get('APP_URL').replace(/\/+$/, '');
    let tenantName: string | null = null;
    let messageBody: string | null = null;
    if (row.tenant_id) {
      const t = await this.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [row.tenant_id]);
      tenantName = t.rows[0]?.name ?? null;
    }
    if (row.template === 'ticket_reply' && typeof row.payload.message_id === 'string') {
      // só resposta pública vai por e-mail (nota interna nunca)
      const m = await this.db.query<{ body: string }>(
        `SELECT body FROM ticket_messages WHERE id = $1 AND kind = 'public_reply'`, [row.payload.message_id]);
      messageBody = m.rows[0]?.body ?? null;
    }
    return { appUrl, tenantName, messageBody };
  }
}
