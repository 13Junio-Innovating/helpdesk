import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebhookAuthError, parseReference, type BillingEvent, type BillingProvider, type CheckoutInput } from './provider.js';

const KINDS = { paid: 'PAYMENT_CONFIRMED', overdue: 'PAYMENT_OVERDUE', canceled: 'SUBSCRIPTION_DELETED' } as const;
export type FakeOutcome = keyof typeof KINDS;

/**
 * Provedor de desenvolvimento: o "checkout" é uma página do próprio front que simula o pagamento.
 * O webhook é assinado com HMAC-SHA256 (BILLING_FAKE_SECRET), exatamente como um provedor real faria.
 */
export class FakeBillingProvider implements BillingProvider {
  readonly name = 'fake' as const;
  readonly requiresDocument = false;

  constructor(
    private readonly secret: string,
    private readonly appUrl: string,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
    const session = this.sign(`${input.tenantId}:${input.planId}`);
    return { url: `${this.appUrl}/assinatura/simulada?session=${encodeURIComponent(session)}&plano=${encodeURIComponent(input.planName)}` };
  }

  /** Monta e assina o corpo do webhook que o "provedor" enviaria. */
  buildWebhook(session: string, outcome: FakeOutcome): { body: Buffer; signature: string } {
    const reference = this.open(session);
    if (!reference) throw new WebhookAuthError('sessão inválida');
    const body = Buffer.from(JSON.stringify({ id: `fake_evt_${randomUUID()}`, event: KINDS[outcome], externalReference: reference, subscription: `fake_sub_${reference.split(':')[0]}` }));
    return { body, signature: this.hmac(body) };
  }

  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<BillingEvent> {
    const sig = headers['x-fake-signature'];
    const expected = this.hmac(rawBody);
    if (typeof sig !== 'string' || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new WebhookAuthError('assinatura inválida');
    }
    const p = JSON.parse(rawBody.toString('utf8')) as { id: string; event: string; externalReference: string; subscription?: string };
    const ref = parseReference(p.externalReference);
    const kind = p.event === KINDS.paid ? 'paid' : p.event === KINDS.overdue ? 'overdue' : p.event === KINDS.canceled ? 'canceled' : 'ignored';
    return { eventId: p.id, kind, rawType: p.event, tenantId: ref?.tenantId ?? null, planId: ref?.planId ?? null, customerId: 'fake_customer', subscriptionId: p.subscription ?? null, payload: p };
  }

  private hmac(data: Buffer | string): string {
    return createHmac('sha256', this.secret).update(data).digest('hex');
  }

  private sign(value: string): string {
    return `${Buffer.from(value).toString('base64url')}.${this.hmac(value)}`;
  }

  private open(session: string): string | null {
    const [b64, mac] = session.split('.');
    if (!b64 || !mac) return null;
    const value = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = this.hmac(value);
    return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) && parseReference(value) ? value : null;
  }
}
