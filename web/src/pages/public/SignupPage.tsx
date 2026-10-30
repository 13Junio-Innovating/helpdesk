import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { AuthLayout } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { applyApiErrors } from '@/lib/forms';
import { ApiError } from '@/lib/api';

const RESERVED = ['www', 'api', 'admin', 'app'];
const schema = z.object({
  workspaceName: z.string().trim().min(2, 'Mínimo de 2 caracteres').max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, '3 a 40 caracteres: letras minúsculas, números e hífen')
    .refine((s) => !RESERVED.includes(s), 'Este endereço é reservado'),
  name: z.string().trim().min(2, 'Mínimo de 2 caracteres').max(100),
  email: z.string().trim().email('Informe um e-mail válido'),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(72),
});
type Form = z.infer<typeof schema>;
const FIELDS = ['workspaceName', 'slug', 'name', 'email', 'password'] as const;

const toSlug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const { register, handleSubmit, formState, setValue, setError: setFieldError } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (data) => {
    setError(null);
    try {
      await signup(data);
      navigate('/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'slug_taken') setFieldError('slug', { message: e.message });
      else if (e instanceof ApiError && e.code === 'email_already_registered') setFieldError('email', { message: e.message });
      else setError(applyApiErrors(e, setFieldError, FIELDS));
    }
  });

  const ws = register('workspaceName');
  return (
    <AuthLayout title="Crie seu workspace" subtitle="14 dias grátis, sem cartão de crédito.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Nome da empresa" error={formState.errors.workspaceName?.message}>
          <Input
            autoFocus
            autoComplete="organization"
            {...ws}
            onChange={(e) => {
              void ws.onChange(e);
              if (!slugTouched) setValue('slug', toSlug(e.target.value));
            }}
          />
        </Field>
        <Field label="Endereço do workspace" error={formState.errors.slug?.message} hint="Usado nos links do portal dos seus clientes.">
          <Input {...register('slug', { onChange: () => setSlugTouched(true) })} />
        </Field>
        <Field label="Seu nome" error={formState.errors.name?.message}>
          <Input autoComplete="name" {...register('name')} />
        </Field>
        <Field label="E-mail" error={formState.errors.email?.message}>
          <Input type="email" autoComplete="email" {...register('email')} />
        </Field>
        <Field label="Senha" error={formState.errors.password?.message} hint="Pelo menos 8 caracteres.">
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Criar workspace
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Já tem conta?{' '}
        <Link to="/entrar" className="text-primary hover:underline">
          Entrar
        </Link>
      </p>
    </AuthLayout>
  );
}
