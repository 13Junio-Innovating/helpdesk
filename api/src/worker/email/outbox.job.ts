import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from '../worker.env.js';
import { WorkerDbService } from '../worker-db.service.js';
import { MailerService } from './mailer.service.js';
import { renderEmail } from './templates.js';

interface Claimed {
  id: string;
  tenant_id: string | null;
  to_email: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxRunResult {
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * Consumidor da email_outbox, seguro com várias instâncias:
 * 1. reserva um lote numa transação curta (FOR UPDATE SKIP LOCKED) marcando `sending` e um prazo de
 *    reserva em scheduled_at; outra instância nunca pega a mesma linha enquanto a reserva vale;
 * 2. envia fora da transação (SMTP lento não segura lock);
 * 3. marca `sent` (e apaga o token do payload) ou `failed` com backoff exponencial.
 * Após EMAIL_MAX_ATTEMPTS a linha fica `failed` e não é mais reservada (desistência).
 * Se o processo morrer no meio, a linha `sending` volta a ser elegível quando a reserva expira.
 */
@Injectable()
export class OutboxJob {
  private readonly logger = new Logger(OutboxJob.name);
  private readonly batch: number;
  private readonly maxAttempts: number;
  private readonly lease: number;
  private readonly backoffBase: number;
  private readonly appUrl: string;

  constructor(
    private readonly db: WorkerDbService,
    private readonly mailer: MailerService,
    config: ConfigService<WorkerEnv, true>,
  ) {
    this.batch = config.get('EMAIL_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('EMAIL_MAX_ATTEMPTS', { infer: true });
    this.lease = config.get('EMAIL_LEASE_SECONDS', { infer: true });
    this.backoffBase = config.get('EMAIL_BACKOFF_BASE_SECONDS', { infer: true });
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  async runOnce(): Promise<OutboxRunResult> {
    const claimed = await this.claim();
    let sent = 0;
    let failed = 0;
    for (const row of claimed) {
      try {
        const email = renderEmail(row.template, row.payload, await this.context(row));
        await this.mailer.send(row.to_email, email, { 'X-Helpdesk-Outbox-Id': row.id });
        await this.db.query(
          `UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL, payload = payload - 'token'
            WHERE id = $1 AND status = 'sending'`,
          [row.id],
        );
        sent++;
      } catch (e) {
        failed++;
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        const giveUp = row.attempts >= this.maxAttempts;
        const delay = Math.min(this.backoffBase * 2 ** (row.attempts - 1), 3600);
        await this.db.query(
          `UPDATE email_outbox
              SET status = 'failed', last_error = $2, scheduled_at = now() + make_interval(secs => $3),
                  payload = CASE WHEN $4 THEN payload - 'token' ELSE payload END
            WHERE id = $1`,
          [row.id, msg, delay, giveUp],
        );
        this.logger.warn(`e-mail ${row.id} (${row.template}) falhou na tentativa ${row.attempts}${giveUp ? ' — desistindo' : ''}: ${msg}`);
      }
    }
    if (claimed.length) this.logger.log(`outbox: ${sent} enviado(s), ${failed} falha(s)`);
    return { claimed: claimed.length, sent, failed };
  }

  private async claim(): Promise<Claimed[]> {
    const { rows } = await this.db.query<Claimed>(
      `UPDATE email_outbox o
          SET status = 'sending', attempts = o.attempts + 1, scheduled_at = now() + make_interval(secs => $2)
        WHERE o.id IN (
          SELECT id FROM email_outbox
           WHERE status IN ('pending', 'failed', 'sending') AND scheduled_at <= now() AND attempts < $3
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $1)
        RETURNING o.id, o.tenant_id, o.to_email, o.template, o.payload, o.attempts`,
      [this.batch, this.lease, this.maxAttempts],
    );
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
  }

  private async context(row: Claimed) {
    const tenant = row.tenant_id
      ? (await this.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [row.tenant_id])).rows[0]?.name ?? null
      : null;
    let messageBody: string | null = null;
    const messageId = row.payload['message_id'];
    if (row.template === 'ticket_reply' && typeof messageId === 'string' && row.tenant_id) {
      // nunca manda nota interna por e-mail, mesmo que o payload aponte para uma
      const m = await this.db.query<{ body: string }>(
        `SELECT body FROM ticket_messages WHERE id = $1 AND tenant_id = $2 AND kind = 'public_reply'`,
        [messageId, row.tenant_id],
      );
      messageBody = m.rows[0]?.body ?? null;
    }
    return { appUrl: this.appUrl, tenantName: tenant, messageBody };
  }
}
