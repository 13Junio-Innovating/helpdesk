import type { HTMLAttributes, ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { cn, readableOn } from '@/lib/utils';

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-bg p-4 shadow-sm sm:p-6', className)} {...p} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-border/70', className)} />;
}

/** Bloco de carregamento anunciado a leitores de tela. */
export function LoadingList({ rows = 4, label = 'Carregando…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function Badge({ color, children, className }: { color?: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', !color && 'bg-border text-fg', className)}
      style={color ? { backgroundColor: color, color: readableOn(color) } : undefined}
    >
      {children}
    </span>
  );
}

const ALERT = {
  error: { icon: AlertCircle, cls: 'border-danger/40 bg-danger/10 text-danger' },
  success: { icon: CheckCircle2, cls: 'border-success/40 bg-success/10 text-success' },
  info: { icon: Info, cls: 'border-primary/40 bg-primary/10 text-fg' },
} as const;

export function Alert({ kind = 'info', children, className }: { kind?: keyof typeof ALERT; children: ReactNode; className?: string }) {
  const { icon: Icon, cls } = ALERT[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cn('flex gap-2 rounded-md border p-3 text-sm', cls, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}
