import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { LifeBuoy } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

/** Cabeçalho + navegação responsiva (no celular a navegação rola horizontalmente abaixo do topo). */
export function AppShell({ nav, home, children }: { nav: NavItem[]; home: string; children: ReactNode }) {
  const { me } = useAuth();
  const link = ({ isActive }: { isActive: boolean }) =>
    cn('whitespace-nowrap rounded-md px-3 py-1.5 text-sm', isActive ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:text-fg');
  return (
    <div className="min-h-dvh">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-bg focus:p-2">
        Pular para o conteúdo
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to={home} className="flex items-center gap-2 font-semibold">
            <LifeBuoy className="h-5 w-5 text-primary" aria-hidden />
            <span className="max-w-[40vw] truncate">{me?.tenant.name ?? 'Helpdesk'}</span>
          </Link>
          <nav aria-label="Principal" className="ml-4 hidden gap-1 md:flex">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={link}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
        <nav aria-label="Principal (celular)" className="flex gap-1 overflow-x-auto border-t border-border px-4 py-2 md:hidden">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={link}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main id="conteudo" className="mx-auto max-w-6xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}

/** Moldura das telas públicas (login, cadastro…). */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <LifeBuoy className="h-6 w-6 text-primary" aria-hidden /> Helpdesk
      </div>
      <main className="w-full max-w-md rounded-lg border border-border bg-bg p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}
