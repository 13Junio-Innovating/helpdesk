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

export const TICKET_CHANNELS = ['portal', 'email', 'chat', 'phone', 'api'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const TICKET_SORTS = ['updated', 'created', 'priority', 'due'] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];

export const SLA_FILTERS = ['breached', 'running', 'paused'] as const;
export type SlaFilter = (typeof SLA_FILTERS)[number];

export interface Paginated<T> {
  items: T[];
  /** Passe em `?cursor=` para a próxima página; `null` = fim. */
  nextCursor: string | null;
}

export interface Ref {
  id: string;
  name: string;
}

export interface SlaTimer {
  state: SlaState;
  dueAt: string;
  /** null quando pausado ou encerrado */
  minutesRemaining: number | null;
}

/** Cronômetros de SLA: só a equipe recebe (para o cliente vem `null`). */
export interface TicketSla {
  /** resumo: breached > running > paused > met_late > met */
  state: SlaState;
  firstResponse: SlaTimer | null;
  resolution: SlaTimer | null;
}

export interface TicketListItem {
  id: string;
  number: number;
  subject: string;
  channel: TicketChannel;
  tags: string[];
  status: Ref & { kind: StatusKind; color: string };
  priority: Ref & { level: number; color: string };
  requester: Ref & { email: string };
  assignee: Ref | null;
  queue: Ref | null;
  category: Ref | null;
  organization: Ref | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  sla: TicketSla | null;
}

export interface TicketMessage {
  id: string;
  kind: MessageKind;
  body: string;
  channel: TicketChannel;
  author: Ref | null;
  createdAt: string;
}

export interface TicketAttachment {
  id: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: Ref | null;
  createdAt: string;
}

export interface TicketEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  actor: Ref | null;
  createdAt: string;
}

export interface TimeEntry {
  id: string;
  ticketId: string;
  user: Ref;
  minutes: number;
  note: string | null;
  workedOn: string;
  createdAt: string;
}

export interface TicketDetail extends TicketListItem {
  description: string;
  customFields: Record<string, unknown>;
  closedAt: string | null;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
  /** Somente equipe (ausente para o cliente). */
  events?: TicketEvent[];
  /** Somente equipe: total de minutos apontados. */
  timeSpentMinutes?: number;
}

export interface BulkUpdateResult {
  updated: string[];
  /** IDs inexistentes, de outro tenant ou sem permissão */
  skipped: string[];
}

export interface ValidationIssue {
  field: string;
  message: string;
}
