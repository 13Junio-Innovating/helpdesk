import { renderEmail } from './templates.js';

const ctx = { appUrl: 'https://app.exemplo.com', tenantName: 'ACME <Suporte>' };

describe('renderEmail', () => {
  it('ticket_created com link do portal e assunto', () => {
    const r = renderEmail('ticket_created', { ticket_id: 'abc', number: 7, subject: 'Impressora' }, ctx);
    expect(r.subject).toBe('[ACME <Suporte>] Chamado #7 recebido: Impressora');
    expect(r.text).toContain('https://app.exemplo.com/portal/chamados/abc');
  });

  it('escapa HTML vindo do banco', () => {
    const r = renderEmail('ticket_reply', { ticket_id: 'x', number: 1, subject: '<script>alert(1)</script>' }, { ...ctx, messageBody: '<img src=x onerror=alert(1)>' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('ACME &lt;Suporte&gt;');
  });

  it('convite e reset levam o token no link (codificado)', () => {
    expect(renderEmail('invitation', { token: 'a b', tenant_name: 'X', role: 'agent' }, ctx).text).toContain('/convite?token=a%20b');
    expect(renderEmail('password_reset', { token: 'tok', name: 'Ana' }, ctx).text).toContain('/redefinir-senha?token=tok');
  });

  it('template desconhecido lança erro (vira falha com retentativa)', () => {
    expect(() => renderEmail('xpto', {}, ctx)).toThrow(/template desconhecido/);
  });
});
