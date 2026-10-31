import { Link, useNavigate } from 'react-router';
import { Ban } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { AuthLayout } from '@/components/AppShell';
import { WorkspacePicker } from '@/components/WorkspacePicker';
import { Button } from '@/components/ui/button';

export function SuspendedPage() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const admin = me?.role === 'admin';
  return (
    <AuthLayout title="Conta suspensa">
      <div className="space-y-4 text-sm">
        <Ban className="h-10 w-10 text-danger" aria-hidden />
        <p>
          O workspace <strong>{me?.tenant.name}</strong> está suspenso. Ainda é possível consultar os chamados, mas não abrir novos.
        </p>
        <p className="text-muted">{admin ? 'Regularize a assinatura para reativar o acesso completo.' : 'Fale com o administrador do seu workspace.'}</p>
        <div className="flex flex-wrap gap-2">
          {admin && <Button onClick={() => navigate('/configuracoes/plano')}>Regularizar assinatura</Button>}
          <Button variant="secondary" onClick={() => navigate('/')}>
            Continuar em modo leitura
          </Button>
          <Button variant="ghost" onClick={() => void logout().then(() => navigate('/entrar'))}>
            Sair
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

export function SwitchWorkspacePage() {
  const { workspaces, selectTenant, me } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthLayout title="Trocar de workspace">
      <WorkspacePicker
        workspaces={workspaces}
        currentId={me?.tenant.id}
        onPick={async (id) => {
          await selectTenant(id);
          navigate('/', { replace: true });
        }}
      />
    </AuthLayout>
  );
}

export function NotFoundPage() {
  return (
    <AuthLayout title="Página não encontrada">
      <p className="text-sm text-muted">O endereço não existe ou você não tem acesso a ele.</p>
      <Link to="/" className="mt-4 inline-block text-sm text-primary hover:underline">
        Ir para o início
      </Link>
    </AuthLayout>
  );
}
