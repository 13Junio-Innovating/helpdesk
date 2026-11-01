import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Configuração do worker. Não usa JWT nem a URL do sd_app: só o sd_worker. */
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_WORKER: z.string().url(),
  WORKER_DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Helpdesk <no-reply@helpdesk.local>'),
  /** URL do front, usada nos links dos e-mails. */
  APP_URL: z.string().url().default('http://localhost:5173'),

  OUTBOX_POLL_MS: z.coerce.number().int().min(200).default(5000),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(1).default(30),
  AUTOMATIONS_POLL_MS: z.coerce.number().int().min(200).default(5000),
  /** Alerta quando restar esta fração do prazo (0.2 = 80% consumido). */
  SLA_WARNING_REMAINING: z.coerce.number().gt(0).lt(1).default(0.2),
  SLA_CRON: z.string().default('* * * * *'),
  PURGE_CRON: z.string().default('17 4 * * *'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function validateWorkerEnv(raw: Record<string, unknown>): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração do worker inválida (.env):\n${issues}`);
  }
  return parsed.data;
}
