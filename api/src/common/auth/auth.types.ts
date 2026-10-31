export type MemberRole = 'admin' | 'agent' | 'requester';

/** Payload dos JWT emitidos pela API. O papel NÃO viaja no token: quem decide é o banco. */
export interface JwtPayload {
  sub: string;
  /** Presente só no token final (de acesso). */
  tid?: string;
  typ: 'access' | 'pre';
}

/** Identidade de uma requisição autenticada com workspace (o caso normal). */
export interface TenantAuth {
  userId: string;
  tenantId: string;
  /** Papel calculado pelo banco (`app_role()`), não pelo JWT. */
  role: MemberRole;
}

/** Identidade antes de escolher o workspace (token "pre"). */
export interface UserAuth {
  userId: string;
  tenantId: string | null;
  role: MemberRole | null;
}

declare module 'express' {
  interface Request {
    auth?: UserAuth;
  }
}
