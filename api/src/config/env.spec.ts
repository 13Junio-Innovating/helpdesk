import { validateEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_SECRET: 'x'.repeat(40) };

describe('validateEnv', () => {
  it('aplica defaults e converte tipos', () => {
    const env = validateEnv({ ...base, PORT: '4000', COOKIE_SECURE: 'false' });
    expect(env.PORT).toBe(4000);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it('recusa JWT_SECRET curto e DATABASE_URL ausente', () => {
    expect(() => validateEnv({ JWT_SECRET: 'curto' })).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET|JWT_SECRET[\s\S]*DATABASE_URL/);
  });

  it('em produção recusa segredo de dev e cookie sem Secure', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'dev_only_' + 'x'.repeat(40) })).toThrow(/produção/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(validateEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
  });
});
