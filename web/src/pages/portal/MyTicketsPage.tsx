import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { Inbox, Plus } from 'lucide-react';
import type { Paginated, TicketListItem } from '@helpdesk/shared';
import { api } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { useDocumentTitle } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Alert, Badge, EmptyState, LoadingList } from '@/components/ui/misc';

const TABS = [
  { key: 'abertos', label: 'Em aberto', status: 'open,pending,on_hold' },
  { key: 'encerrados', label: 'Encerrados', status: 'resolved,closed' },
  { key: 'todos', label: 'Todos', status: undefined },
] as const;

export function MyTicketsPage() {
  useDocumentTitle('Meus chamados');
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('aba')) ?? TABS[0];

  const q = useInfiniteQuery({
    queryKey: ['tickets', 'mine', tab.key],
    queryFn: ({ pageParam, signal }) =>
      api<Paginated<TicketListItem>>('/tickets', { query: { status: tab.status, sort: 'updated', limit: 20, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Meus chamados</h1>
        <Link to="/portal/chamados/novo" className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:opacity-90">
          <Plus className="h-4 w-4" aria-hidden /> Abrir chamado
        </Link>
      </div>

      <div role="tablist" aria-label="Filtrar chamados" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === tab.key}
            onClick={() => setParams(t.key === 'abertos' ? {} : { aba: t.key })}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', t.key === tab.key ? 'border-primary font-medium text-primary' : 'border-transparent text-muted hover:text-fg')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {q.isPending ? (
        <LoadingList label="Carregando chamados" />
      ) : q.isError ? (
        <Alert kind="error">
          {q.error.message}{' '}
          <button className="underline" onClick={() => void q.refetch()}>
            Tentar de novo
          </button>
        </Alert>
      ) : items.length === 0 ? (
        <EmptyState icon={<Inbox className="h-8 w-8" />} title={tab.key === 'abertos' ? 'Nenhum chamado em aberto' : 'Nenhum chamado aqui'}>
          Precisa de ajuda?{' '}
          <Link to="/portal/chamados/novo" className="text-primary underline">
            Abra um chamado
          </Link>{' '}
          ou consulte a{' '}
          <Link to="/portal/ajuda" className="text-primary underline">
            central de ajuda
          </Link>
          .
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Chamados">
          {items.map((t) => (
            <li key={t.id}>
              <Link to={`/portal/chamados/${t.id}`} className="flex flex-col gap-1 p-4 hover:bg-surface sm:flex-row sm:items-center sm:gap-4">
                <span className="text-sm text-muted">#{t.number}</span>
                <span className="flex-1 font-medium">{t.subject}</span>
                <span className="flex items-center gap-3">
                  <Badge color={t.status.color}>{t.status.name}</Badge>
                  <span className="text-xs text-muted">atualizado {timeAgo(t.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Carregar mais
          </Button>
        </div>
      )}
    </div>
  );
}
