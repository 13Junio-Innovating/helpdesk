import type { MemberRole } from '@helpdesk/shared';

export type TokenType = 'access' | 'pre';

export interface JwtPayload {
  sub: string;
  typ: TokenType;
  /** tenant: presente só em tokens de acesso */
  tid?: string;
  /** papel no momento da emissão: APENAS para UI/primeira barreira; a RLS decide */
  role?: MemberRole;
}

export interface AuthUser {
  userId: string;
  tokenType: TokenType;
  tenantId: string | null;
  role: MemberRole | null;
}

/** Usuário com tenant selecionado (rotas normais). */
export interface TenantUser extends AuthUser {
  tenantId: string;
  role: MemberRole;
}
