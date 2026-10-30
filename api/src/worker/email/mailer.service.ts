import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { WorkerEnv } from '../worker.env.js';
import type { RenderedEmail } from './templates.js';

@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<WorkerEnv, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASS', { infer: true });
    this.from = config.get('SMTP_FROM', { infer: true });
    this.transport = nodemailer.createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(to: string, email: RenderedEmail, headers: Record<string, string> = {}): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject: email.subject, text: email.text, html: email.html, headers });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
