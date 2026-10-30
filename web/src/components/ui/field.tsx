import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface FieldProps {
  label: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  /** um único controle (Input/Textarea/Select); recebe id e aria-* automaticamente */
  children: ReactElement<Record<string, unknown>>;
}

/** Rótulo + controle + dica/erro, ligados por id/aria-describedby (leitores de tela anunciam o erro). */
export function Field({ label, error, hint, className, children }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {isValidElement(children) ? cloneElement(children, { id, 'aria-invalid': !!error || undefined, 'aria-describedby': describedBy }) : children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
