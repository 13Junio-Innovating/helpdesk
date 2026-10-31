import { errorMessage } from './error-message.js';

describe('errorMessage', () => {
  it('AggregateError (IPv6 + IPv4 recusados) vira a lista das causas', () => {
    const e = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
    ]);
    expect(e.message).toBe('');
    expect(errorMessage(e)).toBe('connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1');
  });

  it('erro sem mensagem usa o código, depois o nome', () => {
    expect(errorMessage(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
    expect(errorMessage(new TypeError(''))).toBe('TypeError');
    expect(errorMessage('falhou')).toBe('falhou');
    expect(errorMessage(new Error('mensagem normal'))).toBe('mensagem normal');
  });
});
