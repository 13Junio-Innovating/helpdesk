// Tipos e enums compartilhados entre API e front. Espelham os ENUMs do banco (001_types_and_helpers.sql).

export const MEMBER_ROLES = ['admin', 'agent', 'requester'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const TENANT_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'canceled'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const STATUS_KINDS = ['open', 'pending', 'on_hold', 'resolved', 'closed'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export const MESSAGE_KINDS = ['public_reply', 'internal_note', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const SLA_STATES = ['running', 'paused', 'met', 'met_late', 'breached'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** Códigos de erro estáveis devolvidos pela API em `{ code, message }`. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'invalid_credentials',
  'session_invalid',
  'forbidden',
  'not_found',
  'conflict',
  'email_already_registered',
  'slug_taken',
  'invalid_reference',
  'invalid_value',
  'assignee_must_be_staff',
  'ticket_quota_exceeded',
  'agent_limit_reached',
  'tenant_inactive',
  'invitation_invalid',
  'reset_token_invalid',
  'too_many_requests',
  'internal_error',
  'service_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface WorkspaceSummary {
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
  role: MemberRole;
}

/** Resposta de login/signup/select-tenant/refresh. */
export interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  /** `true` quando o token ainda não tem tenant: o cliente deve chamar /auth/select-tenant. */
  needsTenantSelection: boolean;
  workspaces: WorkspaceSummary[];
}

export interface MeResponse {
  user: { id: string; email: string; name: string; locale: string; avatarUrl: string | null };
  tenant: { id: string; name: string; slug: string; status: TenantStatus; timezone: string; trialEndsAt: string | null };
  role: MemberRole;
  plan: { id: string; name: string; maxAgents: number | null; maxTicketsPerMonth: number | null; features: Record<string, boolean> };
}
