import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { AuthLayout } from '@/components/AppShell';
import { WorkspacePicker } from '@/components/WorkspacePicker';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';

const schema = z.object({
  email: z.string().trim().email('Informe um e-mail válido'),
  password: z.string().min(1, 'Informe a senha'),
});
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { login, selectTenant, pendingWorkspaces } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'credentials' | 'workspace'>('credentials');
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setError(null);
    try {
      const r = await login(email, password);
      if (r === 'select-workspace') setStep('workspace');
      else navigate(from, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível entrar. Tente novamente.');
    }
  });

  if (step === 'workspace' && pendingWorkspaces) {
    return (
      <AuthLayout title="Escolha o workspace" subtitle="Sua conta tem acesso a mais de um workspace.">
        <WorkspacePicker
          workspaces={pendingWorkspaces}
          onPick={async (id) => {
            await selectTenant(id);
            navigate(from, { replace: true });
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Entrar" subtitle="Acesse seu workspace de atendimento.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="E-mail" error={formState.errors.email?.message}>
          <Input type="email" autoComplete="email" autoFocus {...register('email')} />
        </Field>
        <Field label="Senha" error={formState.errors.password?.message}>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>
        <div className="flex justify-end">
          <Link to="/esqueci-senha" className="text-sm text-primary hover:underline">
            Esqueci minha senha
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Entrar
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Ainda não tem conta?{' '}
        <Link to="/cadastro" className="text-primary hover:underline">
          Crie seu workspace grátis
        </Link>
      </p>
    </AuthLayout>
  );
}
