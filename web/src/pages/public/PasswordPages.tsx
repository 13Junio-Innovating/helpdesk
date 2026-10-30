import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { AuthLayout } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';

const password = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(72);
const confirmMatches = { path: ['confirm'], message: 'As senhas não conferem' };

export function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<{ email: string }>({
    resolver: zodResolver(z.object({ email: z.string().trim().email('Informe um e-mail válido') })),
  });
  return (
    <AuthLayout title="Esqueci minha senha" subtitle="Enviaremos um link para criar uma nova senha.">
      {sent ? (
        <Alert kind="success">{sent}</Alert>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={handleSubmit(async ({ email }) => {
            setError(null);
            try {
              const r = await api<{ message: string }>('/auth/forgot-password', { method: 'POST', body: { email }, auth: false });
              setSent(r.message);
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'Não foi possível enviar agora.');
            }
          })}
        >
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="E-mail" error={formState.errors.email?.message}>
            <Input type="email" autoComplete="email" autoFocus {...register('email')} />
          </Field>
          <Button type="submit" className="w-full" loading={formState.isSubmitting}>
            Enviar link
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link to="/entrar" className="text-primary hover:underline">
          Voltar para o login
        </Link>
      </p>
    </AuthLayout>
  );
}

const resetSchema = z.object({ password, confirm: z.string() }).refine((d) => d.password === d.confirm, confirmMatches);
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'Link inválido. Peça um novo em "Esqueci minha senha".');
  const { register, handleSubmit, formState } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) });
  return (
    <AuthLayout title="Criar nova senha">
      {done ? (
        <div className="space-y-4">
          <Alert kind="success">Senha alterada. Por segurança, você saiu de todos os dispositivos.</Alert>
          <Link to="/entrar" className="block text-center text-sm text-primary hover:underline">
            Entrar com a nova senha
          </Link>
        </div>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={handleSubmit(async ({ password: pw }) => {
            setError(null);
            try {
              await api('/auth/reset-password', { method: 'POST', body: { token, password: pw }, auth: false });
              setDone(true);
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'Não foi possível alterar a senha.');
            }
          })}
        >
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="Nova senha" error={formState.errors.password?.message}>
            <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
          </Field>
          <Field label="Confirme a nova senha" error={formState.errors.confirm?.message}>
            <Input type="password" autoComplete="new-password" {...register('confirm')} />
          </Field>
          <Button type="submit" className="w-full" loading={formState.isSubmitting} disabled={!token}>
            Salvar senha
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

const inviteSchema = z
  .object({ name: z.string().trim().min(2, 'Mínimo de 2 caracteres').max(100), password, confirm: z.string() })
  .refine((d) => d.password === d.confirm, confirmMatches);
export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(token ? null : 'Link de convite inválido.');
  const { register, handleSubmit, formState } = useForm<z.infer<typeof inviteSchema>>({ resolver: zodResolver(inviteSchema) });
  return (
    <AuthLayout title="Aceitar convite" subtitle="Defina seu nome e uma senha para acessar. Se você já tem conta, use a senha atual dela.">
      <form
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit(async ({ name, password: pw }) => {
          setError(null);
          try {
            await acceptInvite(token, name, pw);
            navigate('/', { replace: true });
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Não foi possível aceitar o convite.');
          }
        })}
      >
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Seu nome" error={formState.errors.name?.message}>
          <Input autoComplete="name" autoFocus {...register('name')} />
        </Field>
        <Field label="Senha" error={formState.errors.password?.message} hint="Pelo menos 8 caracteres.">
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </Field>
        <Field label="Confirme a senha" error={formState.errors.confirm?.message}>
          <Input type="password" autoComplete="new-password" {...register('confirm')} />
        </Field>
        <Button type="submit" className="w-full" loading={formState.isSubmitting} disabled={!token}>
          Aceitar e entrar
        </Button>
      </form>
    </AuthLayout>
  );
}
