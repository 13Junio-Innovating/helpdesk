import { lazy, Suspense } from 'react';
import { Outlet, Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { FullPageSpinner, HomeRedirect, PublicOnly, RequireAuth, RequireSession, SuspendedWatcher, TicketLinkRedirect } from '@/auth/guards';
import { LoginPage } from '@/pages/public/LoginPage';
import { SignupPage } from '@/pages/public/SignupPage';
import { AcceptInvitePage, ForgotPasswordPage, ResetPasswordPage } from '@/pages/public/PasswordPages';
import { NotFoundPage, SuspendedPage, SwitchWorkspacePage } from '@/pages/public/MiscPages';
import { LoadingList } from '@/components/ui/misc';

// telas autenticadas carregadas sob demanda: o login não baixa o portal nem o painel
const MyTicketsPage = lazy(() => import('@/pages/portal/MyTicketsPage').then((m) => ({ default: m.MyTicketsPage })));
const NewTicketPage = lazy(() => import('@/pages/portal/NewTicketPage').then((m) => ({ default: m.NewTicketPage })));
const TicketPage = lazy(() => import('@/pages/portal/TicketPage').then((m) => ({ default: m.TicketPage })));
const HelpCenterPage = lazy(() => import('@/pages/portal/HelpCenterPages').then((m) => ({ default: m.HelpCenterPage })));
const ArticlePage = lazy(() => import('@/pages/portal/HelpCenterPages').then((m) => ({ default: m.ArticlePage })));
const StaffHomePage = lazy(() => import('@/pages/staff/StaffHomePage').then((m) => ({ default: m.StaffHomePage })));

const page = <Suspense fallback={<LoadingList rows={3} />}><Outlet /></Suspense>;

const PORTAL_NAV = [
  { to: '/portal', label: 'Meus chamados', end: true },
  { to: '/portal/chamados/novo', label: 'Abrir chamado' },
  { to: '/portal/ajuda', label: 'Central de ajuda' },
];
const STAFF_NAV = [{ to: '/painel', label: 'Painel', end: true }];

export function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <SuspendedWatcher />
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/entrar" element={<PublicOnly><LoginPage /></PublicOnly>} />
        <Route path="/cadastro" element={<PublicOnly><SignupPage /></PublicOnly>} />
        <Route path="/esqueci-senha" element={<ForgotPasswordPage />} />
        <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
        <Route path="/convite" element={<AcceptInvitePage />} />
        <Route path="/conta-suspensa" element={<RequireSession><SuspendedPage /></RequireSession>} />
        <Route path="/workspaces" element={<RequireSession><SwitchWorkspacePage /></RequireSession>} />

        <Route
          path="/portal"
          element={
            <RequireAuth area="portal">
              <AppShell nav={PORTAL_NAV} home="/portal">
                {page}
              </AppShell>
            </RequireAuth>
          }
        >
          <Route index element={<MyTicketsPage />} />
          <Route path="chamados/novo" element={<NewTicketPage />} />
          <Route path="chamados/:id" element={<TicketPage />} />
          <Route path="ajuda" element={<HelpCenterPage />} />
          <Route path="ajuda/:slug" element={<ArticlePage />} />
        </Route>

        <Route
          element={
            <RequireSession>
              <Outlet />
            </RequireSession>
          }
        >
          <Route
            element={
              <RequireAuth area="staff">
                <AppShell nav={STAFF_NAV} home="/painel">
                  {page}
                </AppShell>
              </RequireAuth>
            }
          >
            <Route path="/painel" element={<StaffHomePage />} />
          </Route>
          {/* fase 6: detalhe do chamado da equipe; por ora cliente vai ao portal e equipe ao painel */}
          <Route path="/chamados/:id" element={<TicketLinkRedirect staffElement={<HomeRedirect />} />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
