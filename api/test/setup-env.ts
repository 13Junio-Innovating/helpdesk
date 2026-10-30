import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Mesmo .env do dev (banco local com seed). Ajustes só de teste:
const file = resolve(import.meta.dirname, '../../.env');
if (existsSync(file)) process.loadEnvFile(file);
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'silent';
process.env['BCRYPT_COST'] = '10';
// 1 conexão: prova que o contexto não vaza entre transações e que nenhum fluxo segura 2 conexões
process.env['DB_POOL_MAX'] = '1';
process.env['THROTTLE_AUTH_IP_LIMIT'] ??= '10000';
process.env['THROTTLE_AUTH_EMAIL_LIMIT'] ??= '10000';
process.env['THROTTLE_DEFAULT_LIMIT'] ??= '10000';
