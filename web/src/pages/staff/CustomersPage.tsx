import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Search, Trash2, UserPlus, Users } from 'lucide-react';
import type { Member } from '@helpdesk/shared';
import { useAuth } from '@/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { cn, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Alert, Badge, Card, EmptyState, LoadingList } from '@/components/ui/misc';
import { useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

interface Org { id: string; name: string; document: string | null; notes: string | null; memberCount: number; ticketCount: number }

export function CustomersPage() {
  useDocumentTitle('Clientes');
  const [tab, setTab] = useState<'clientes' | 'organizacoes'>('clientes');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Clientes</h1>
      <div role="tablist" aria-label="Clientes" className="flex gap-1 border-b border-border">
        {([['clientes', 'Pessoas', Users], ['organizacoes', 'Organizações', Building2]] as const).map(([k, l, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', tab === k ? 'border-primary font-medium text-primary' : 'border-transparent text-muted')}>
            <Icon className="h-4 w-4" aria-hidden />{l}
          </button>
        ))}
      </div>
      {tab === 'clientes' ? <People /> : <Organizations />}
    </div>
  );
}

function People() {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const q = useDebounced(term.trim(), 300);
  const [invite, setInvite] = useState({ email: '', organizationId: '' });
  const people = useQuery({ queryKey: ['members', 'requesters', 'all', q], queryFn: () => api<Member[]>('/members', { query: { role: 'requester', q: q || undefined } }) });
  const orgs = useQuery({ queryKey: ['organizations'], queryFn: () => api<Org[]>('/organizations') });
  const send = useMutation({
    mutationFn: () => api('/invitations', { method: 'POST', body: { email: invite.email, role: 'requester', organizationId: invite.organizationId || undefined } }),
    onSuccess: async () => { toast('success', `Convite enviado para ${invite.email}.`); setInvite({ email: '', organizationId: '' }); await qc.invalidateQueries({ queryKey: ['invitations'] }); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível convidar.'),
  });
  return (
    <div className="space-y-4">
      {me?.role === 'admin' && (
        <Card className="p-4 sm:p-4">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
            <label className="min-w-56 flex-1 space-y-1 text-sm"><span className="font-medium">Convidar cliente por e-mail</span><Input type="email" required value={invite.email} onChange={(e) => setInvite((i) => ({ ...i, email: e.target.value }))} /></label>
            <label className="space-y-1 text-sm"><span className="font-medium">Organização</span>
              <Select value={invite.organizationId} onChange={(e) => setInvite((i) => ({ ...i, organizationId: e.target.value }))}><option value="">Nenhuma</option>{orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
            </label>
            <Button type="submit" loading={send.isPending}><UserPlus className="h-4 w-4" aria-hidden />Convidar</Button>
          </form>
        </Card>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input type="search" aria-label="Buscar clientes" className="pl-9" placeholder="Buscar por nome ou e-mail" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      {people.isPending ? <LoadingList /> : people.isError ? <Alert kind="error">{people.error.message}</Alert> : people.data.length === 0 ? <EmptyState title="Nenhum cliente encontrado" /> : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase text-muted"><tr><th className="p-3">Nome</th><th className="p-3">E-mail</th><th className="hidden p-3 md:table-cell">Organização</th><th className="p-3">Situação</th><th className="hidden p-3 md:table-cell">Último acesso</th></tr></thead>
            <tbody className="divide-y divide-border">
              {people.data.map((m) => (
                <tr key={m.userId}>
                  <td className="p-3 font-medium">{m.name}</td>
                  <td className="p-3">{m.email}</td>
                  <td className="hidden p-3 md:table-cell">{m.organization?.name ?? '—'}</td>
                  <td className="p-3">{m.active ? <Badge className="bg-success/15 text-success">Ativo</Badge> : <Badge>Inativo</Badge>}</td>
                  <td className="hidden p-3 text-muted md:table-cell">{m.lastLoginAt ? timeAgo(m.lastLoginAt) : 'nunca'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Organizations() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', document: '' });
  const orgs = useQuery({ queryKey: ['organizations'], queryFn: () => api<Org[]>('/organizations') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['organizations'] });
  const create = useMutation({
    mutationFn: () => api('/organizations', { method: 'POST', body: { name: form.name, document: form.document || undefined } }),
    onSuccess: async () => { toast('success', 'Organização criada.'); setForm({ name: '', document: '' }); await refresh(); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível criar.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/organizations/${id}`, { method: 'DELETE' }),
    onSuccess: async () => { toast('success', 'Organização removida.'); await refresh(); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível remover.'),
  });
  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <label className="min-w-56 flex-1 space-y-1 text-sm"><span className="font-medium">Nova organização</span><Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
          <label className="space-y-1 text-sm"><span className="font-medium">CNPJ (opcional)</span><Input value={form.document} onChange={(e) => setForm((f) => ({ ...f, document: e.target.value }))} /></label>
          <Button type="submit" loading={create.isPending}>Criar</Button>
        </form>
      </Card>
      {orgs.isPending ? <LoadingList /> : orgs.isError ? <Alert kind="error">{orgs.error.message}</Alert> : orgs.data.length === 0 ? <EmptyState title="Nenhuma organização" /> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {orgs.data.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <span className="flex-1"><span className="font-medium">{o.name}</span>{o.document && <span className="ml-2 text-muted">{o.document}</span>}</span>
              <span className="text-muted">{o.memberCount} pessoa(s) · {o.ticketCount} chamado(s)</span>
              <Button size="icon" variant="ghost" aria-label={`Remover ${o.name}`} onClick={async () => {
                if (await confirm({ title: `Remover ${o.name}?`, message: 'Só é possível remover organizações sem pessoas nem chamados.', confirmLabel: 'Remover', danger: true })) remove.mutate(o.id);
              }}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
