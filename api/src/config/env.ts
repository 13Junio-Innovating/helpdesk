import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_PRE_TENANT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool.default(true),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: bool.default(false),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  MEMBERSHIP_CACHE_MS: z.coerce.number().int().min(0).default(5000),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_IP: z.coerce.number().int().positive().default(30),
  AUTH_RATE_LIMIT_EMAIL: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

const DEV_SECRET_PREFIXES = ['dev_only_', 'test_secret_'];

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida (.env):\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (DEV_SECRET_PREFIXES.some((p) => env.JWT_SECRET.startsWith(p))) {
      throw new Error('Configuração inválida (.env): JWT_SECRET de desenvolvimento em produção.');
    }
    if (!env.COOKIE_SECURE) throw new Error('Configuração inválida (.env): COOKIE_SECURE=false em produção.');
  }
  return env;
}
