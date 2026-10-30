import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, MeResponse, MemberRole, WorkspaceSummary } from '@helpdesk/shared';
import { api, onApiEvent, refreshSession, setAccessToken } from '@/lib/api';
import { queryClient } from '@/lib/query';

type Status = 'loading' | 'anonymous' | 'authenticated';

export interface SignupInput {
  workspaceName: string;
  slug: string;
  name: string;
  email: string;
  password: string;
}

interface AuthState {
  status: Status;
  me: MeResponse | null;
  /** workspaces do login em andamento (quando há mais de um) */
  pendingWorkspaces: WorkspaceSummary[] | null;
  /** todos os workspaces do usuário (para trocar sem sair) */
  workspaces: WorkspaceSummary[];
  suspended: boolean;
  login(email: string, password: string): Promise<'done' | 'select-workspace'>;
  selectTenant(tenantId: string): Promise<void>;
  signup(input: SignupInput): Promise<void>;
  acceptInvite(token: string, name: string, password: string): Promise<void>;
  logout(): Promise<void>;
  reloadMe(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function isStaff(role: MemberRole | undefined | null): boolean {
  return role === 'admin' || role === 'agent';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [pendingWorkspaces, setPending] = useState<WorkspaceSummary[] | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);

  const loadMe = useCallback(async () => {
    const data = await api<MeResponse>('/auth/me');
    setMe(data);
    setSuspended(data.tenant.status === 'suspended' || data.tenant.status === 'canceled');
    setStatus('authenticated');
  }, []);

  const finish = useCallback(
    async (res: AuthResponse) => {
      setAccessToken(res.accessToken);
      setWorkspaces(res.workspaces);
      if (res.needsTenantSelection) {
        setPending(res.workspaces);
        return 'select-workspace' as const;
      }
      setPending(null);
      queryClient.clear(); // nada do workspace anterior pode aparecer no novo
      await loadMe();
      return 'done' as const;
    },
    [loadMe],
  );

  // Ao abrir o app: tenta restaurar a sessão pelo cookie de refresh.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await refreshSession();
      if (!alive) return;
      if (res && !res.needsTenantSelection) {
        setWorkspaces(res.workspaces);
        try {
          await loadMe();
          return;
        } catch {
          /* cai para anônimo */
        }
      }
      setStatus('anonymous');
    })();
    return () => {
      alive = false;
    };
  }, [loadMe]);

  useEffect(
    () =>
      onApiEvent((code) => {
        if (code === 'session_invalid') {
          setAccessToken(null);
          setMe(null);
          setStatus('anonymous');
          queryClient.clear();
        }
        if (code === 'tenant_inactive') setSuspended(true);
      }),
    [],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      me,
      pendingWorkspaces,
      workspaces,
      suspended,
      login: async (email, password) => finish(await api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password }, auth: false })),
      selectTenant: async (tenantId) => {
        await finish(await api<AuthResponse>('/auth/select-tenant', { method: 'POST', body: { tenantId } }));
      },
      signup: async (input) => {
        await finish(await api<AuthResponse>('/auth/signup', { method: 'POST', body: input, auth: false }));
      },
      acceptInvite: async (token, name, password) => {
        await finish(await api<AuthResponse>('/auth/accept-invite', { method: 'POST', body: { token, name, password }, auth: false }));
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST', auth: false }).catch(() => undefined);
        setAccessToken(null);
        setMe(null);
        setPending(null);
        setSuspended(false);
        setStatus('anonymous');
        queryClient.clear();
      },
      reloadMe: loadMe,
    }),
    [status, me, pendingWorkspaces, workspaces, suspended, finish, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
