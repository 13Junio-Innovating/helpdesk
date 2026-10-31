import { timingSafeEqual } from 'node:crypto';
import { WebhookAuthError, parseReference, type BillingEvent, type BillingEventKind, type BillingProvider, type CheckoutInput } from './provider.js';

const KIND: Record<string, BillingEventKind> = {
  PAYMENT_CONFIRMED: 'paid',
  PAYMENT_RECEIVED: 'paid',
  PAYMENT_OVERDUE: 'overdue',
  SUBSCRIPTION_DELETED: 'canceled',
  SUBSCRIPTION_INACTIVATED: 'canceled',
};

type Fetch = typeof fetch;

/**
 * Asaas (API v3). Checkout = assinatura mensal com billingType UNDEFINED (o cliente escolhe Pix,
 * boleto ou cartão na fatura do Asaas). O webhook é autenticado pelo token configurado no painel
 * do Asaas (cabeçalho `asaas-access-token`). tenant:plano vão no externalReference da assinatura.
 */
export class AsaasBillingProvider implements BillingProvider {
  readonly name = 'asaas' as const;
  readonly requiresDocument = true;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string | undefined,
    private readonly webhookToken: string | undefined,
    private readonly http: Fetch = fetch,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
    if (!this.apiKey) throw new Error('ASAAS_API_KEY não configurada');
    if (!input.document) throw new Error('documento (CPF/CNPJ) obrigatório');
    const customer = await this.call<{ id: string }>('POST', '/customers', {
      name: input.tenantName,
      email: input.adminEmail,
      cpfCnpj: input.document.replace(/\D/g, ''),
      externalReference: input.tenantId,
    });
    const today = new Date().toISOString().slice(0, 10);
    const sub = await this.call<{ id: string }>('POST', '/subscriptions', {
      customer: customer.id,
      billingType: 'UNDEFINED',
      value: input.priceCents / 100,
      nextDueDate: today,
      cycle: 'MONTHLY',
      description: `Helpdesk — plano ${input.planName}`,
      externalReference: `${input.tenantId}:${input.planId}`,
    });
    const payments = await this.call<{ data: Array<{ invoiceUrl: string }> }>('GET', `/subscriptions/${sub.id}/payments`);
    const url = payments.data[0]?.invoiceUrl;
    if (!url) throw new Error('Asaas não devolveu a fatura da assinatura');
    return { url };
  }

  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<BillingEvent> {
    const got = headers['asaas-access-token'];
    if (!this.webhookToken || typeof got !== 'string' || got.length !== this.webhookToken.length || !timingSafeEqual(Buffer.from(got), Buffer.from(this.webhookToken))) {
      throw new WebhookAuthError('token do webhook inválido');
    }
    const p = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      event: string;
      payment?: { id: string; subscription?: string; externalReference?: string; customer?: string };
      subscription?: { id: string; externalReference?: string; customer?: string };
    };
    const subscriptionId = p.payment?.subscription ?? p.subscription?.id ?? null;
    let reference = parseReference(p.payment?.externalReference ?? p.subscription?.externalReference);
    // cobranças geradas pela assinatura podem vir sem externalReference: busca na assinatura
    if (!reference && subscriptionId && this.apiKey) {
      const sub = await this.call<{ externalReference?: string }>('GET', `/subscriptions/${subscriptionId}`).catch(() => null);
      reference = parseReference(sub?.externalReference);
    }
    return {
      eventId: p.id ?? `${p.event}:${p.payment?.id ?? p.subscription?.id ?? 'sem-id'}`,
      kind: KIND[p.event] ?? 'ignored',
      rawType: p.event,
      tenantId: reference?.tenantId ?? null,
      planId: reference?.planId ?? null,
      customerId: p.payment?.customer ?? p.subscription?.customer ?? null,
      subscriptionId,
      payload: p,
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${this.apiUrl}${path}`, {
      method,
      headers: { access_token: this.apiKey ?? '', 'Content-Type': 'application/json', 'User-Agent': 'helpdesk-saas' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { errors?: Array<{ description: string }> };
    if (!res.ok) throw new Error(`Asaas ${method} ${path} → ${res.status}: ${json.errors?.map((e) => e.description).join('; ') ?? ''}`);
    return json;
  }
}
