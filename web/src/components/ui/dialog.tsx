import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

/** Diálogo modal acessível (foco preso, Esc fecha, título anunciado). */
export function Dialog({ open, onOpenChange, title, description, children, className }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <D.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-bg p-6 shadow-xl', className)}>
          <D.Title className="text-lg font-semibold">{title}</D.Title>
          {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          <div className="mt-4">{children}</div>
          <D.Close asChild>
            <Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Fechar">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

interface ConfirmOptions { title: string; message: string; confirmLabel?: string; danger?: boolean }
const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);

/** Confirmação para ações destrutivas: `if (await confirm({...})) ...` */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => undefined);
  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const close = (v: boolean) => {
    resolver.current(v);
    setOpts(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => !o && close(false)} title={opts?.title ?? ''} description={opts?.message}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => close(false)}>Cancelar</Button>
          <Button variant={opts?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {opts?.confirmLabel ?? 'Confirmar'}
          </Button>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error('useConfirm fora do ConfirmProvider');
  return c;
}
