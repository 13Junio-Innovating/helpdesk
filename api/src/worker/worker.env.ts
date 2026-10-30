import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Configuração do worker (processo separado da API; usa sd_worker, nunca sd_app). */
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL_WORKER: z.string().url(),
  WORKER_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

  APP_URL: z.string().url().default('http://localhost:5173'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Helpdesk <no-reply@helpdesk.local>'),

  /** 0 desliga o job (útil em testes) */
  WORKER_SLA_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  WORKER_EMAIL_INTERVAL_MS: z.coerce.number().int().min(0).default(5_000),
  WORKER_AUTOMATION_INTERVAL_MS: z.coerce.number().int().min(0).default(5_000),

  EMAIL_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** tempo que uma linha fica reservada ("sending"); se o worker morrer, outro reassume depois disso */
  EMAIL_LEASE_SECONDS: z.coerce.number().int().min(10).default(600),
  EMAIL_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(1).default(30),
  SLA_WARNING_RATIO: z.coerce.number().min(0.1).max(0.99).default(0.8),
  AUTOMATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function validateWorkerEnv(raw: Record<string, unknown>): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração do worker inválida:\n${issues}`);
  }
  return parsed.data;
}
