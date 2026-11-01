import { Injectable, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { WorkerConfig } from './worker-config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Id da linha da outbox: vira Message-ID estável (ajuda a deduplicar no destino). */
  outboxId: string;
}

@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: WorkerConfig) {
    const user = config.get('SMTP_USER');
    this.transport = nodemailer.createTransport({
      host: config.get('SMTP_HOST'),
      port: config.get('SMTP_PORT'),
      secure: config.get('SMTP_SECURE'),
      ...(user ? { auth: { user, pass: config.get('SMTP_PASS') ?? '' } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    this.from = config.get('MAIL_FROM');
  }

  async send(mail: OutgoingMail): Promise<void> {
    const domain = this.from.match(/@([^>\s]+)/)?.[1] ?? 'helpdesk.local';
    await this.transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      messageId: `<outbox-${mail.outboxId}@${domain}>`,
    });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
