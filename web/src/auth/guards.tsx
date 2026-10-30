import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { isStaff, useAuth } from './AuthProvider';

export function FullPageSpinner() {
  return (
    <div role="status" aria-label="Carregando" className="grid min-h-dvh place-items-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
    </div>
  );
}

/** Rota protegida. O papel aqui só decide a TELA; quem autoriza de verdade é a API/RLS. */
export function RequireAuth({ area, children }: { area: 'staff' | 'portal'; children: ReactNode }) {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous' || !me) return <Navigate to="/entrar" replace state={{ from: location.pathname + location.search }} />;
  if (area === 'staff' && !isStaff(me.role)) return <Navigate to="/portal" replace />;
  if (area === 'portal' && isStaff(me.role)) return <Navigate to="/painel" replace />;
  return <>{children}</>;
}

export function RequireSession({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous') return <Navigate to="/entrar" replace />;
  return <>{children}</>;
}

/** Telas públicas: quem já está logado vai para o início. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function HomeRedirect() {
  const { status, me } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  if (!me) return <Navigate to="/entrar" replace />;
  return <Navigate to={isStaff(me.role) ? '/painel' : '/portal'} replace />;
}

/** Links de e-mail da equipe (/chamados/:id) abertos por um cliente vão para o portal. */
export function TicketLinkRedirect({ staffElement }: { staffElement: ReactNode }) {
  const { me } = useAuth();
  const { id } = useParams();
  if (me && !isStaff(me.role)) return <Navigate to={`/portal/chamados/${id}`} replace />;
  return <>{staffElement}</>;
}

/** Quando a API avisa "conta suspensa" (402 tenant_inactive), leva para a tela explicativa uma vez. */
export function SuspendedWatcher() {
  const { suspended } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (suspended && sessionStorage.getItem('suspended-seen') !== '1') {
      try {
        sessionStorage.setItem('suspended-seen', '1');
      } catch {
        /* ignore */
      }
      navigate('/conta-suspensa');
    }
  }, [suspended, navigate]);
  return null;
}
