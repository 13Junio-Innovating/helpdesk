import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Inbox, Keyboard, Plus, Search } from 'lucide-react';
import type { BulkUpdateResult, Paginated, TicketListItem } from '@helpdesk/shared';
import { useAuth } from '@/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { useAgents, usePriorities, useQueues, useStatuses } from '@/lib/catalog';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { cn, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Alert, Badge, EmptyState, LoadingList } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { PriorityDot, SlaBadge } from '@/components/staff/badges';

const OPEN = 'open,pending,on_hold';
/** Filtros salvos (visões). Os parâmetros vão para a URL: dá para compartilhar o link. */
export const VIEWS = [
  { key: 'meus', label: 'Meus abertos', params: { assignee: 'me', status: OPEN } },
  { key: 'sem-responsavel', label: 'Sem responsável', params: { assignee: 'none', status: OPEN } },
  { key: 'sla-vencido', label: 'SLA vencido', params: { sla: 'breached' } },
  { key: 'aguardando', label: 'Aguardando cliente', params: { status: 'pending' } },
  { key: 'abertos', label: 'Todos abertos', params: { status: OPEN } },
  { key: 'todos', label: 'Todos', params: {} },
] as const;
const FILTER_KEYS = ['status', 'assignee', 'priority', 'queue', 'sla', 'q', 'sort'] as const;

const SHORTCUTS: Array<[string, string]> = [
  ['j / k', 'próximo / anterior'],
  ['Enter ou o', 'abrir o chamado'],
  ['x', 'selecionar / desmarcar'],
  ['/', 'buscar'],
  ['n', 'novo chamado'],
  ['?', 'mostrar atalhos'],
];

export function TicketsPage() {
  useDocumentTitle('Chamados');
  const { me } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find((v) => v.key === params.get('visao'));
  const [term, setTerm] = useState(params.get('q') ?? '');
  const q = useDebounced(term.trim(), 350);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowLinks = useRef<Array<HTMLAnchorElement | null>>([]);

  const statuses = useStatuses();
  const priorities = usePriorities();
  const queues = useQueues();
  const agents = useAgents();

  // busca digitada → URL (sem poluir o histórico)
  useEffect(() => {
    if ((params.get('q') ?? '') === q) return;
    const next = new URLSearchParams(params);
    if (q) next.set('q', q);
    else next.delete('q');
    setParams(next, { replace: true });
  }, [q, params, setParams]);

  // sem nenhum filtro na URL: abre na visão "Todos abertos"
  useEffect(() => {
    if ([...params.keys()].length === 0) setParams({ visao: 'abertos', status: OPEN }, { replace: true });
  }, [params, setParams]);

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params]);

  const list = useInfiniteQuery({
    queryKey: ['tickets', 'staff', filters],
    queryFn: ({ pageParam, signal }) => api<Paginated<TicketListItem>>('/tickets', { query: { ...filters, limit: 50, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000, // atualização leve da fila
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const setView = (key: string) => {
    const v = VIEWS.find((x) => x.key === key)!;
    setSelected(new Set());
    setTerm('');
    setParams({ visao: v.key, ...v.params });
  };
  const setFilter = (k: (typeof FILTER_KEYS)[number], value: string) => {
    const next = new URLSearchParams(params);
    next.delete('visao');
    if (value) next.set(k, value);
    else next.delete(k);
    setParams(next);
  };

  const bulk = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api<BulkUpdateResult>('/tickets/bulk', { method: 'POST', body: { ids: [...selected], changes } }),
    onSuccess: async (r) => {
      toast('success', `${r.updated.length} chamado(s) atualizado(s)${r.skipped.length ? `, ${r.skipped.length} ignorado(s)` : ''}.`);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível aplicar a ação.'),
  });

  // atalhos de teclado (ignorados enquanto se digita)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable=true], [role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const focusRow = (i: number) => {
        const n = Math.max(0, Math.min(items.length - 1, i));
        setCursor(n);
        rowLinks.current[n]?.focus();
      };
      // primeiro j/k só traz o foco para a lista; depois navega
      const inList = rowLinks.current.includes(document.activeElement as HTMLAnchorElement);
      if (e.key === 'j') focusRow(inList ? cursor + 1 : cursor);
      else if (e.key === 'k') focusRow(inList ? cursor - 1 : cursor);
      else if (e.key === 'o' || (e.key === 'Enter' && el.tagName !== 'A' && el.tagName !== 'BUTTON')) {
        const t = items[cursor];
        if (t) navigate(`/chamados/${t.id}`);
      } else if (e.key === 'x') {
        const t = items[cursor];
        if (t) toggle(t.id);
      } else if (e.key === '/') searchRef.current?.focus();
      else if (e.key === 'n') navigate('/chamados/novo');
      else if (e.key === '?') setHelp(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Chamados</h1>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)} aria-label="Atalhos de teclado">
            <Keyboard className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Atalhos</span>
          </Button>
          <Link to="/chamados/novo" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-fg hover:opacity-90">
            <Plus className="h-4 w-4" aria-hidden /> Novo chamado
          </Link>
        </div>
      </div>

      <nav aria-label="Filtros salvos" className="flex gap-1 overflow-x-auto border-b border-border">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            aria-current={view?.key === v.key ? 'page' : undefined}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm', view?.key === v.key ? 'border-primary font-medium text-primary' : 'border-transparent text-muted hover:text-fg')}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input ref={searchRef} type="search" aria-label="Buscar chamados (assunto, descrição ou #número)" placeholder="Buscar… ( / )" className="pl-9" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <Select aria-label="Status" value={params.get('status') ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">Qualquer status</option>
          <option value={OPEN}>Abertos (todos)</option>
          {statuses.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select aria-label="Prioridade" value={params.get('priority') ?? ''} onChange={(e) => setFilter('priority', e.target.value)}>
          <option value="">Qualquer prioridade</option>
          {priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select aria-label="Responsável" value={params.get('assignee') ?? ''} onChange={(e) => setFilter('assignee', e.target.value)}>
          <option value="">Qualquer responsável</option>
          <option value="me">Eu</option>
          <option value="none">Sem responsável</option>
          {agents.data?.filter((a) => a.id !== me?.user.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select aria-label="Ordenar por" value={params.get('sort') ?? 'updated'} onChange={(e) => setFilter('sort', e.target.value === 'updated' ? '' : e.target.value)}>
          <option value="updated">Atualizados recentemente</option>
          <option value="created">Mais novos</option>
          <option value="priority">Maior prioridade</option>
          <option value="due">Prazo mais próximo</option>
        </Select>
        <Select aria-label="Fila" value={params.get('queue') ?? ''} onChange={(e) => setFilter('queue', e.target.value)} className="lg:col-start-3">
          <option value="">Qualquer fila</option>
          {queues.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        <Select aria-label="SLA" value={params.get('sla') ?? ''} onChange={(e) => setFilter('sla', e.target.value)}>
          <option value="">Qualquer SLA</option>
          <option value="breached">Estourado</option>
          <option value="running">Correndo</option>
          <option value="paused">Pausado</option>
        </Select>
      </div>

      {selected.size > 0 && (
        <div role="region" aria-label="Ações em lote" className="sticky top-16 z-30 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2 text-sm">
          <span className="font-medium">{selected.size} selecionado(s)</span>
          <Button size="sm" variant="secondary" loading={bulk.isPending} onClick={() => bulk.mutate({ assigneeId: me?.user.id })}>Atribuir a mim</Button>
          <Select aria-label="Atribuir a" className="h-8 w-auto" value="" onChange={(e) => e.target.value && bulk.mutate({ assigneeId: e.target.value === 'none' ? null : e.target.value })}>
            <option value="">Atribuir a…</option>
            <option value="none">Ninguém</option>
            {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Select aria-label="Mudar status" className="h-8 w-auto" value="" onChange={(e) => e.target.value && bulk.mutate({ statusId: e.target.value })}>
            <option value="">Mudar status…</option>
            {statuses.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar seleção</Button>
        </div>
      )}

      {list.isPending ? (
        <LoadingList rows={6} label="Carregando chamados" />
      ) : list.isError ? (
        <Alert kind="error">{list.error.message} <button className="underline" onClick={() => void list.refetch()}>Tentar de novo</button></Alert>
      ) : items.length === 0 ? (
        <EmptyState icon={<Inbox className="h-8 w-8" />} title="Nenhum chamado nesta visão">
          {view?.key === 'sla-vencido' ? 'Ótimo: nada estourado agora.' : 'Ajuste os filtros ou escolha outra visão.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Lista de chamados ({items.length})</caption>
            <thead className="bg-surface text-left text-xs uppercase text-muted">
              <tr>
                <th className="w-10 p-3">
                  <input type="checkbox" aria-label="Selecionar todos" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((t) => t.id)))} />
                </th>
                <th className="p-3">Chamado</th>
                <th className="hidden p-3 lg:table-cell">Solicitante</th>
                <th className="p-3">Status</th>
                <th className="hidden p-3 md:table-cell">Prioridade</th>
                <th className="hidden p-3 lg:table-cell">Responsável</th>
                <th className="p-3">SLA</th>
                <th className="hidden p-3 xl:table-cell">Atualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((t, i) => (
                <tr key={t.id} className={cn('hover:bg-surface', selected.has(t.id) && 'bg-primary/5', i === cursor && 'outline outline-1 -outline-offset-1 outline-primary/40')}>
                  <td className="p-3">
                    <input type="checkbox" aria-label={`Selecionar chamado #${t.number}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                  </td>
                  <td className="p-3">
                    <Link ref={(el) => { rowLinks.current[i] = el; }} to={`/chamados/${t.id}`} onFocus={() => setCursor(i)} className="font-medium hover:underline">
                      <span className="mr-2 text-muted">#{t.number}</span>
                      {t.subject}
                    </Link>
                    {t.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{t.tags.map((tag) => <Badge key={tag} className="bg-surface text-muted">{tag}</Badge>)}</div>}
                  </td>
                  <td className="hidden p-3 lg:table-cell">{t.requester.name}</td>
                  <td className="p-3"><Badge color={t.status.color}>{t.status.name}</Badge></td>
                  <td className="hidden p-3 md:table-cell"><PriorityDot color={t.priority.color} name={t.priority.name} /></td>
                  <td className="hidden p-3 lg:table-cell">{t.assignee?.name ?? <span className="text-muted">—</span>}</td>
                  <td className="p-3"><SlaBadge sla={t.sla} /></td>
                  <td className="hidden p-3 text-muted xl:table-cell">{timeAgo(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Carregar mais</Button>
        </div>
      )}

      <Dialog open={help} onOpenChange={setHelp} title="Atalhos de teclado">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt><kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </div>
  );
}
