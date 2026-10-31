import { AsaasBillingProvider } from './asaas.provider.js';

/** Sem credenciais do Asaas no ambiente: verifica o formato das chamadas com um fetch simulado. */
describe('AsaasBillingProvider.createCheckout', () => {
  it('cria cliente, assinatura mensal com externalReference tenant:plano e devolve a fatura', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; key: string | undefined }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, key: (init.headers as Record<string, string>)['access_token'] });
      const json = url.endsWith('/customers') ? { id: 'cus_9' } : url.endsWith('/subscriptions') ? { id: 'sub_9' } : { data: [{ invoiceUrl: 'https://sandbox.asaas.com/i/abc' }] };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AsaasBillingProvider('https://api-sandbox.asaas.com/v3', 'chave', 'tok', fake);
    const r = await p.createCheckout({
      tenantId: '11111111-1111-1111-1111-111111111111', tenantName: 'ACME', planId: 'pro', planName: 'Pro', priceCents: 9900,
      adminName: 'Ana', adminEmail: 'ana@acme.com', document: '12.345.678/0001-90',
    });
    expect(r.url).toBe('https://sandbox.asaas.com/i/abc');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api-sandbox.asaas.com/v3', '')}`)).toEqual(['POST /customers', 'POST /subscriptions', 'GET /subscriptions/sub_9/payments']);
    expect(calls[0]!.body).toMatchObject({ cpfCnpj: '12345678000190', email: 'ana@acme.com' });
    expect(calls[1]!.body).toMatchObject({ customer: 'cus_9', billingType: 'UNDEFINED', value: 99, cycle: 'MONTHLY', externalReference: '11111111-1111-1111-1111-111111111111:pro' });
    expect(calls.every((c) => c.key === 'chave')).toBe(true);
  });

  it('erro do Asaas vira exceção com a descrição (logada, não exposta ao cliente)', async () => {
    const fake = (async () => new Response(JSON.stringify({ errors: [{ description: 'CPF inválido' }] }), { status: 400 })) as unknown as typeof fetch;
    const p = new AsaasBillingProvider('https://x', 'k', 't', fake);
    await expect(p.createCheckout({ tenantId: 't', tenantName: 'n', planId: 'pro', planName: 'Pro', priceCents: 1, adminName: 'a', adminEmail: 'a@a.com', document: '1' })).rejects.toThrow(/CPF inválido/);
  });

  it('webhook sem externalReference busca a assinatura no Asaas', async () => {
    const fake = (async () => new Response(JSON.stringify({ externalReference: '22222222-2222-2222-2222-222222222222:business' }), { status: 200 })) as unknown as typeof fetch;
    const p = new AsaasBillingProvider('https://x', 'k', 'tok', fake);
    const e = await p.verifyWebhook({ 'asaas-access-token': 'tok' }, Buffer.from(JSON.stringify({ id: 'evt', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay', subscription: 'sub_1' } })));
    expect(e).toMatchObject({ kind: 'paid', tenantId: '22222222-2222-2222-2222-222222222222', planId: 'business', subscriptionId: 'sub_1' });
  });
});
