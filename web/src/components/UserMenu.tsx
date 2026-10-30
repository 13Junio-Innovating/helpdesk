import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, Repeat } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';

const ROLE: Record<string, string> = { admin: 'Administrador', agent: 'Agente', requester: 'Cliente' };

export function UserMenu() {
  const { me, logout, workspaces } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  const item = 'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-border/60';
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-border/50" aria-label="Menu da conta">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-fg" aria-hidden>
          {me.user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{me.user.name}</span>
        <ChevronDown className="h-4 w-4" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-md border border-border bg-bg p-1 shadow-lg">
          <div className="px-2 py-1.5 text-xs text-muted">
            <div className="font-medium text-fg">{me.user.name}</div>
            <div>{me.user.email}</div>
            <div>
              {ROLE[me.role]} · {me.tenant.name}
            </div>
          </div>
          <Dropdown.Separator className="my-1 h-px bg-border" />
          {workspaces.length > 1 && (
            <Dropdown.Item className={item} onSelect={() => navigate('/workspaces')}>
              <Repeat className="h-4 w-4" aria-hidden /> Trocar de workspace
            </Dropdown.Item>
          )}
          <Dropdown.Item className={item} onSelect={() => void logout().then(() => navigate('/entrar'))}>
            <LogOut className="h-4 w-4" aria-hidden /> Sair
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
