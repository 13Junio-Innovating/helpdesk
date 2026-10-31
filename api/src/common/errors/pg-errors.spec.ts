import { isPgError, mapPgError } from './pg-errors.js';

const pgErr = (code: string, message: string, constraint?: string) => ({ code, message, constraint, severity: 'ERROR' });

describe('mapPgError', () => {
  it.each([
    ['42501', 'permission denied for table tickets', 403, 'forbidden'],
    ['42501', 'new row violates row-level security policy', 403, 'forbidden'],
    ['23503', 'insert or update violates foreign key', 422, 'invalid_reference'],
    ['23505', 'duplicate key value', 409, 'conflict'],
    ['23514', 'ticket_quota_exceeded', 402, 'ticket_quota_exceeded'],
    ['23514', 'agent_limit_reached', 402, 'agent_limit_reached'],
    ['23514', 'tenant_inactive', 402, 'tenant_inactive'],
    ['23514', 'assignee_must_be_staff', 422, 'assignee_must_be_staff'],
    ['23505', 'email_already_registered', 409, 'email_already_registered'],
    ['P0002', 'invitation_invalid_or_expired', 410, 'invitation_invalid'],
    ['22023', 'invalid_period', 400, 'invalid_parameter'],
  ])('%s %s => %i %s', (code, message, status, outCode) => {
    expect(mapPgError(pgErr(code, message))).toMatchObject({ status, code: outCode });
  });

  it('constraint conhecida tem código próprio', () => {
    expect(mapPgError(pgErr('23505', 'duplicate key', 'tenants_slug_key'))?.code).toBe('slug_taken');
  });

  it('SQLSTATE desconhecido não é mapeado (vira 500 genérico no filtro)', () => {
    expect(mapPgError(pgErr('XX000', 'internal'))).toBeUndefined();
  });

  it('isPgError reconhece só erros do driver', () => {
    expect(isPgError(pgErr('42501', 'x'))).toBe(true);
    expect(isPgError(new Error('x'))).toBe(false);
    expect(isPgError({ code: 'ECONNREFUSED', severity: 'x' })).toBe(false);
  });
});
