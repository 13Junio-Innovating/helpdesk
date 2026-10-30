import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, BookOpen, Search } from 'lucide-react';
import type { KbArticle, KbArticleSummary, Paginated } from '@helpdesk/shared';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { Markdown } from '@/components/Markdown';
import { Input } from '@/components/ui/input';
import { Alert, Card, EmptyState, LoadingList } from '@/components/ui/misc';

export function HelpCenterPage() {
  useDocumentTitle('Central de ajuda');
  const [term, setTerm] = useState('');
  const q = useDebounced(term.trim(), 300);
  const list = useQuery({
    queryKey: ['kb', 'list', q],
    queryFn: ({ signal }) => api<Paginated<KbArticleSummary>>('/kb', { query: { q: q || undefined, limit: 50 }, signal }),
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Central de ajuda</h1>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input type="search" aria-label="Buscar artigos" placeholder="Buscar artigos…" className="pl-9" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      {list.isPending ? (
        <LoadingList rows={3} label="Carregando artigos" />
      ) : list.isError ? (
        <Alert kind="error">{list.error.message}</Alert>
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<BookOpen className="h-8 w-8" />} title={q ? 'Nenhum artigo encontrado' : 'Ainda não há artigos publicados'}>
          Não achou o que procurava?{' '}
          <Link to="/portal/chamados/novo" className="text-primary underline">
            Abra um chamado
          </Link>
          .
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {list.data.items.map((a) => (
            <li key={a.id}>
              <Link to={`/portal/ajuda/${a.slug}`} className="block rounded-lg border border-border p-4 hover:bg-surface">
                <span className="font-medium text-primary">{a.title}</span>
                <span className="mt-1 line-clamp-2 block text-sm text-muted">{a.excerpt}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ArticlePage() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['kb', 'article', slug], queryFn: () => api<KbArticle>(`/kb/${slug}`) });
  useDocumentTitle(q.data?.title ?? 'Artigo');
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to="/portal/ajuda" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Central de ajuda
      </Link>
      {q.isPending ? (
        <LoadingList rows={2} label="Carregando artigo" />
      ) : q.isError ? (
        <Alert kind="error">{q.error instanceof ApiError && q.error.status === 404 ? 'Artigo não encontrado.' : q.error.message}</Alert>
      ) : (
        <Card>
          <article>
            <h1 className="text-2xl font-semibold">{q.data.title}</h1>
            <p className="mb-4 text-xs text-muted">Atualizado em {formatDateTime(q.data.updatedAt)}</p>
            <Markdown>{q.data.body}</Markdown>
          </article>
        </Card>
      )}
    </div>
  );
}
