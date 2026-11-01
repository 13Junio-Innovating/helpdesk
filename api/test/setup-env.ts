import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Carrega o .env da raiz (URLs do banco de dev) e força valores adequados aos testes.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  BCRYPT_COST: '10',
  MEMBERSHIP_CACHE_MS: '0',
  COOKIE_SECURE: 'false',
  RATE_LIMIT_PER_MIN: '100000',
  AUTH_RATE_LIMIT_IP: '100000',
  AUTH_RATE_LIMIT_EMAIL: '100000',
});
process.env.JWT_SECRET ??= 'test_secret_0123456789abcdefghijklmnopqrstuvwxyz';
