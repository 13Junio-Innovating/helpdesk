import { useState } from 'react';
import { Building2, ChevronRight } from 'lucide-react';
import type { WorkspaceSummary } from '@helpdesk/shared';
import { Alert } from './ui/misc';
import { ApiError } from '@/lib/api';

const ROLE: Record<string, string> = { admin: 'Administrador', agent: 'Agente', requester: 'Cliente' };

export function WorkspacePicker({ workspaces, onPick, currentId }: { workspaces: WorkspaceSummary[]; onPick: (id: string) => Promise<void>; currentId?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert kind="error">{error}</Alert>}
      <ul className="space-y-2" aria-label="Workspaces">
        {workspaces.map((w) => (
          <li key={w.tenantId}>
            <button
              type="button"
              disabled={!!busy}
              aria-current={w.tenantId === currentId || undefined}
              onClick={async () => {
                setBusy(w.tenantId);
                setError(null);
                try {
                  await onPick(w.tenantId);
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : 'Não foi possível entrar neste workspace.');
                } finally {
                  setBusy(null);
                }
              }}
              className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left hover:bg-surface disabled:opacity-60 aria-[current=true]:border-primary"
            >
              <Building2 className="h-5 w-5 text-muted" aria-hidden />
              <span className="flex-1">
                <span className="block font-medium">{w.name}</span>
                <span className="block text-xs text-muted">
                  {ROLE[w.role]} · {w.slug}
                  {w.status === 'suspended' || w.status === 'canceled' ? ' · suspenso' : ''}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-muted" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
