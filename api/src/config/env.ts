import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_PRE_TENANT_TTL_SECONDS: z.coerce.number().int().min(60).default(300),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: bool.default(true),

  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default('loopback'),
  BODY_LIMIT: z.string().default('1mb'),

  // armazenamento S3-compatível (anexos). Sem S3_ENDPOINT = AWS S3.
  S3_ENDPOINT: z.string().url().optional(),
  /** endpoint usado nas URLs pré-assinadas (o navegador precisa alcançá-lo) */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('helpdesk-attachments'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** dev: cria o bucket e a regra de CORS no boot */
  S3_AUTO_CREATE_BUCKET: bool.default(false),

  // cobrança
  APP_URL: z.string().url().default('http://localhost:5173'),
  BILLING_PROVIDER: z.enum(['fake', 'asaas']).default('fake'),
  BILLING_FAKE_SECRET: z.string().min(16).default('dev-only-fake-billing-secret'),
  ASAAS_API_URL: z.string().url().default('https://api-sandbox.asaas.com/v3'),
  ASAAS_API_KEY: z.string().optional(),
  ASAAS_WEBHOOK_TOKEN: z.string().optional(),
  /** só para o webhook de cobrança (sd_worker); nunca usado por rotas de usuário */
  DATABASE_URL_WORKER: z.string().url().optional(),

  THROTTLE_DEFAULT_LIMIT: z.coerce.number().int().min(1).default(300),
  THROTTLE_AUTH_TTL_SECONDS: z.coerce.number().int().min(1).default(900),
  THROTTLE_AUTH_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  THROTTLE_AUTH_EMAIL_LIMIT: z.coerce.number().int().min(1).default(10),
});

export type Env = z.infer<typeof envSchema>;

/** Usado pelo ConfigModule: falha no boot com mensagem clara (sem ecoar valores). */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}
