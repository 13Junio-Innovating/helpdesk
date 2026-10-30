import { mapPgError } from './pg-errors.js';

describe('mapPgError', () => {
  it.each([
    [{ code: '42501', message: 'new row violates row-level security policy' }, 403, 'forbidden'],
    [{ code: '23503', message: 'fk' }, 422, 'invalid_reference'],
    [{ code: '23505', message: 'duplicate key' }, 409, 'conflict'],
    [{ code: '23505', message: 'email_already_registered' }, 409, 'email_already_registered'],
    [{ code: '23505', message: 'dup', constraint: 'tenants_slug_key' }, 409, 'slug_taken'],
    [{ code: '23514', message: 'ticket_quota_exceeded' }, 402, 'ticket_quota_exceeded'],
    [{ code: '23514', message: 'agent_limit_reached' }, 402, 'agent_limit_reached'],
    [{ code: '23514', message: 'tenant_inactive' }, 402, 'tenant_inactive'],
    [{ code: '23514', message: 'assignee_must_be_staff' }, 422, 'assignee_must_be_staff'],
    [{ code: '23514', message: 'new row violates check constraint' }, 422, 'invalid_value'],
    [{ code: 'P0002', message: 'invitation_invalid_or_expired' }, 410, 'invitation_invalid'],
    [{ code: 'P0002', message: 'reset_token_invalid' }, 410, 'reset_token_invalid'],
    [{ code: '28000', message: 'session_invalid' }, 401, 'session_invalid'],
    [{ code: '22P02', message: 'invalid input syntax for type uuid' }, 400, 'bad_request'],
    [{ code: 'XX000', message: 'internal' }, 500, 'internal_error'],
  ])('%o → %i %s', (err, status, code) => {
    const m = mapPgError(err);
    expect(m.status).toBe(status);
    expect(m.code).toBe(code);
    // mensagem amigável nunca repete o texto interno do banco
    expect(m.message).not.toContain(err.message);
  });
});
