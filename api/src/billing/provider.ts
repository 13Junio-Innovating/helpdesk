/** Contrato de um provedor de cobrança. Trocar de provedor = nova implementação desta interface. */
export interface CheckoutInput {
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  priceCents: number;
  adminName: string;
  adminEmail: string;
  /** CPF/CNPJ (o Asaas exige para cobrar) */
  document?: string;
}

export type BillingEventKind = 'paid' | 'overdue' | 'canceled' | 'ignored';

export interface BillingEvent {
  /** id único do evento no provedor (idempotência) */
  eventId: string;
  kind: BillingEventKind;
  rawType: string;
  tenantId: string | null;
  planId: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  payload: unknown;
}

export interface BillingProvider {
  readonly name: 'fake' | 'asaas';
  readonly requiresDocument: boolean;
  createCheckout(input: CheckoutInput): Promise<{ url: string }>;
  /** Valida a autenticidade (assinatura/token) e normaliza o evento. Lança se não for autêntico. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<BillingEvent>;
}

export class WebhookAuthError extends Error {}

/** "tenantId:planId" (externalReference / sessão) */
export function parseReference(ref: unknown): { tenantId: string; planId: string } | null {
  if (typeof ref !== 'string') return null;
  const m = /^([0-9a-f-]{36}):([a-z0-9_-]{1,40})$/i.exec(ref);
  return m ? { tenantId: m[1]!, planId: m[2]! } : null;
}
