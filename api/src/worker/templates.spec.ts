import { renderTemplate, UnknownTemplateError } from './templates.js';

const ctx = { appUrl: 'https://app.exemplo.com', tenantName: 'Demo Suporte' };

describe('renderTemplate', () => {
  it('ticket_created com link e número', () => {
    const m = renderTemplate('ticket_created', { ticket_id: 'abc', number: 7, subject: 'Impressora' }, ctx);
    expect(m.subject).toBe('[Demo Suporte] Chamado #7 recebido: Impressora');
    expect(m.text).toContain('https://app.exemplo.com/tickets/abc');
    expect(m.html).toContain('href="https://app.exemplo.com/tickets/abc"');
  });

  it('escapa HTML e impede injeção de cabeçalho no assunto', () => {
    const m = renderTemplate('ticket_reply', { ticket_id: 'x', number: 1, subject: 'Oi\r\nBcc: hacker@x.com' },
      { ...ctx, messageBody: '<script>alert(1)</script>' });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.text).toContain('<script>alert(1)</script>'); // texto puro não é HTML
  });

  it('convite e reset levam o token no link (codificado)', () => {
    expect(renderTemplate('invitation', { token: 'a+b/c', tenant_name: 'ACME', role: 'agent' }, ctx).text)
      .toContain('/accept-invite?token=a%2Bb%2Fc');
    expect(renderTemplate('password_reset', { token: 'tok' }, ctx).html).toContain('/reset-password?token=tok');
  });

  it('template desconhecido é erro permanente', () => {
    expect(() => renderTemplate('nao_existe', {}, ctx)).toThrow(UnknownTemplateError);
  });
});
