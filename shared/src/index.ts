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
  'in_use',
  'last_admin',
  'already_member',
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

export const AUTOMATION_EVENTS = ['ticket_created', 'ticket_updated', 'sla_warning', 'sla_breached'] as const;
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];

/** Campos que as condições de automação podem testar (avaliados pelo worker, fase 4). */
export const AUTOMATION_FIELDS = [
  'subject', 'description', 'channel', 'tags',
  'priority.id', 'priority.name', 'status.id', 'status.name', 'status.kind',
  'category.id', 'category.name', 'queue.id', 'organization.id', 'assignee.id', 'requester.id',
] as const;
export type AutomationField = (typeof AUTOMATION_FIELDS)[number];

export const AUTOMATION_OPS = ['eq', 'in', 'contains'] as const;
export type AutomationOp = (typeof AUTOMATION_OPS)[number];

export interface AutomationCondition {
  field: AutomationField;
  op: AutomationOp;
  value: string | string[];
}

export type AutomationAction =
  | { type: 'assign_queue'; queueId: string }
  | { type: 'assign_agent'; userId: string }
  | { type: 'set_priority'; priorityId: string }
  | { type: 'add_tag'; value: string }
  | { type: 'notify_staff' };

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  active: boolean;
  organization: Ref | null;
  phone: string | null;
  jobTitle: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: MemberRole;
  organizationId: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  timezone: string;
  trialEndsAt: string | null;
  plan: MeResponse['plan'] & { priceCents: number };
  usage: { agents: number; ticketsThisMonth: number };
  /** só admin */
  subscription: { status: string; provider: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
}

export interface KbArticleSummary {
  id: string;
  title: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  visibility: 'internal' | 'portal';
  category: Ref | null;
  excerpt: string;
  publishedAt: string | null;
  updatedAt: string;
}

export interface KbArticle extends KbArticleSummary {
  body: string;
  author: Ref | null;
  createdAt: string;
}

export interface ReportsOverview {
  periodDays: number;
  openByStatus: Array<{ statusId: string; name: string; kind: StatusKind; color: string; count: number }>;
  overdue: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  /** % de cronômetros cumpridos no prazo entre os encerrados ou estourados no período; null sem dados */
  slaCompliancePct: number | null;
  ticketsPerDay: Array<{ date: string; created: number; resolved: number }>;
  byAgent: Array<{ userId: string; name: string; open: number; resolved: number; minutesTracked: number }>;
  byCategory: Array<{ categoryId: string | null; name: string; count: number }>;
  minutesTracked: number;
}
