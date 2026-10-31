import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { AppShell } from '@/components/AppShell';
import { FullPageSpinner, HomeRedirect, PublicOnly, RequireAuth, RequireSession, SuspendedWatcher, TicketLinkRedirect } from '@/auth/guards';
import { LoginPage } from '@/pages/public/LoginPage';
import { SignupPage } from '@/pages/public/SignupPage';
import { AcceptInvitePage, ForgotPasswordPage, ResetPasswordPage } from '@/pages/public/PasswordPages';
import { NotFoundPage, SuspendedPage, SwitchWorkspacePage } from '@/pages/public/MiscPages';
import { LoadingList } from '@/components/ui/misc';
import { PricingPage } from '@/pages/billing/PricingPage';
const FakeCheckoutPage = lazy(() => import('@/pages/billing/FakeCheckoutPage').then((m) => ({ default: m.FakeCheckoutPage })));

// telas autenticadas carregadas sob demanda: o login não baixa o portal nem o painel
const MyTicketsPage = lazy(() => import('@/pages/portal/MyTicketsPage').then((m) => ({ default: m.MyTicketsPage })));
const NewTicketPage = lazy(() => import('@/pages/portal/NewTicketPage').then((m) => ({ default: m.NewTicketPage })));
const TicketPage = lazy(() => import('@/pages/portal/TicketPage').then((m) => ({ default: m.TicketPage })));
const HelpCenterPage = lazy(() => import('@/pages/portal/HelpCenterPages').then((m) => ({ default: m.HelpCenterPage })));
const ArticlePage = lazy(() => import('@/pages/portal/HelpCenterPages').then((m) => ({ default: m.ArticlePage })));
const staff = (name: string) =>
  lazy(async () => {
    const m = (await import('@/pages/staff/pages')) as unknown as Record<string, React.ComponentType>;
    return { default: m[name]! };
  });
const DashboardPage = staff('DashboardPage');
const TicketsPage = staff('TicketsPage');
const StaffTicketPage = staff('StaffTicketPage');
const NewStaffTicketPage = staff('NewStaffTicketPage');
const KbListPage = staff('KbListPage');
const KbEditorPage = staff('KbEditorPage');
const CustomersPage = staff('CustomersPage');
const SettingsLayout = staff('SettingsLayout');
const TeamSettings = staff('TeamSettings');
const QueuesSettings = staff('QueuesSettings');
const CategoriesSettings = staff('CategoriesSettings');
const PrioritiesSettings = staff('PrioritiesSettings');
const StatusesSettings = staff('StatusesSettings');
const MacrosSettings = staff('MacrosSettings');
const BusinessHoursSettings = staff('BusinessHoursSettings');
const SlaSettings = staff('SlaSettings');
const AutomationsSettings = staff('AutomationsSettings');
const PlanSettings = staff('PlanSettings');

const page = <Suspense fallback={<LoadingList rows={3} />}><Outlet /></Suspense>;

const PORTAL_NAV = [
  { to: '/portal', label: 'Meus chamados', end: true },
  { to: '/portal/chamados/novo', label: 'Abrir chamado' },
  { to: '/portal/ajuda', label: 'Central de ajuda' },
];
const STAFF_NAV = [
  { to: '/painel', label: 'Dashboard', end: true },
  { to: '/chamados', label: 'Chamados' },
  { to: '/clientes', label: 'Clientes' },
  { to: '/base-de-conhecimento', label: 'Base de conhecimento' },
];

function StaffShell() {
  const { me } = useAuth();
  const nav = me?.role === 'admin' ? [...STAFF_NAV, { to: '/configuracoes', label: 'Configurações' }] : STAFF_NAV;
  return <AppShell nav={nav} home="/painel">{page}</AppShell>;
}

/** Só a tela; a API/RLS barra de verdade qualquer escrita de não-admin. */
function AdminOnly() {
  const { me } = useAuth();
  return me?.role === 'admin' ? <Outlet /> : <Navigate to="/painel" replace />;
}

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
        <Route path="/precos" element={<PricingPage />} />
        <Route path="/assinatura/simulada" element={<RequireSession><FakeCheckoutPage /></RequireSession>} />
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
          <Route path="/chamados/:id" element={<TicketLinkRedirect staffElement={<RequireAuth area="staff"><StaffShell /></RequireAuth>} />}>
            <Route index element={<StaffTicketPage />} />
          </Route>
          <Route element={<RequireAuth area="staff"><StaffShell /></RequireAuth>}>
            <Route path="/painel" element={<DashboardPage />} />
            <Route path="/chamados" element={<TicketsPage />} />
            <Route path="/chamados/novo" element={<NewStaffTicketPage />} />
            <Route path="/clientes" element={<CustomersPage />} />
            <Route path="/base-de-conhecimento" element={<KbListPage />} />
            <Route path="/base-de-conhecimento/novo" element={<KbEditorPage />} />
            <Route path="/base-de-conhecimento/:id" element={<KbEditorPage />} />
            <Route element={<AdminOnly />}>
              <Route path="/configuracoes" element={<SettingsLayout />}>
                <Route index element={<Navigate to="equipe" replace />} />
                <Route path="equipe" element={<TeamSettings />} />
                <Route path="filas" element={<QueuesSettings />} />
                <Route path="categorias" element={<CategoriesSettings />} />
                <Route path="prioridades" element={<PrioritiesSettings />} />
                <Route path="status" element={<StatusesSettings />} />
                <Route path="respostas-prontas" element={<MacrosSettings />} />
                <Route path="horario" element={<BusinessHoursSettings />} />
                <Route path="sla" element={<SlaSettings />} />
                <Route path="automacoes" element={<AutomationsSettings />} />
                <Route path="plano" element={<PlanSettings />} />
              </Route>
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
