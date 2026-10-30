import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BookOpen, Plus, Search, Trash2 } from 'lucide-react';
import type { KbArticle, KbArticleSummary, Paginated } from '@helpdesk/shared';
import { api, ApiError } from '@/lib/api';
import { useCategories } from '@/lib/catalog';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { cn, timeAgo } from '@/lib/utils';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, EmptyState, LoadingList } from '@/components/ui/misc';
import { useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

const STATUS: Record<string, string> = { draft: 'Rascunho', published: 'Publicado', archived: 'Arquivado' };
const VIS: Record<string, string> = { internal: 'Interno', portal: 'Portal do cliente' };

export function KbListPage() {
  useDocumentTitle('Base de conhecimento');
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState('');
  const q = useDebounced(term.trim(), 300);
  const status = params.get('status') ?? '';
  const list = useQuery({
    queryKey: ['kb', 'admin', q, status],
    queryFn: () => api<Paginated<KbArticleSummary>>('/kb', { query: { q: q || undefined, status: status || undefined, limit: 100 } }),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Base de conhecimento</h1>
        <Link to="/base-de-conhecimento/novo" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-fg"><Plus className="h-4 w-4" aria-hidden />Novo artigo</Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input type="search" aria-label="Buscar artigos" className="pl-9" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Buscar…" />
        </div>
        <Select aria-label="Status do artigo" className="w-48" value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {list.isPending ? <LoadingList /> : list.isError ? <Alert kind="error">{list.error.message}</Alert> : list.data.items.length === 0 ? (
        <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Nenhum artigo">Crie artigos para a equipe e para o portal do cliente.</EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.data.items.map((a) => (
            <li key={a.id}>
              <Link to={`/base-de-conhecimento/${a.id}`} className="flex flex-wrap items-center gap-2 p-3 hover:bg-surface">
                <span className="flex-1 font-medium">{a.title}</span>
                <Badge className={cn(a.status === 'published' ? 'bg-success/15 text-success' : 'bg-surface text-muted')}>{STATUS[a.status]}</Badge>
                <Badge className="bg-surface text-muted">{VIS[a.visibility]}</Badge>
                <span className="text-xs text-muted">{timeAgo(a.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Editor Markdown com pré-visualização. A lista traz só resumo; o artigo completo vem por slug. */
export function KbEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const categories = useCategories();
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [form, setForm] = useState({ title: '', body: '', status: 'draft', visibility: 'internal', categoryId: '' });
  const [error, setError] = useState<string | null>(null);

  const article = useQuery({
    queryKey: ['kb', 'by-id', id],
    enabled: !isNew,
    queryFn: () => api<KbArticle>(`/kb/id/${id}`),
  });
  useDocumentTitle(isNew ? 'Novo artigo' : article.data?.title ?? 'Artigo');
  useEffect(() => {
    const a = article.data;
    if (a) setForm({ title: a.title, body: a.body, status: a.status, visibility: a.visibility, categoryId: a.category?.id ?? '' });
  }, [article.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, categoryId: form.categoryId || null };
      return isNew ? api<KbArticle>('/kb', { method: 'POST', body }) : api<KbArticle>(`/kb/${id}`, { method: 'PATCH', body });
    },
    onSuccess: async (a) => {
      toast('success', 'Artigo salvo.');
      await qc.invalidateQueries({ queryKey: ['kb'] });
      if (isNew) navigate(`/base-de-conhecimento/${a.id}`, { replace: true });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível salvar.'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/kb/${id}`, { method: 'DELETE' }),
    onSuccess: async () => { toast('success', 'Artigo removido.'); await qc.invalidateQueries({ queryKey: ['kb'] }); navigate('/base-de-conhecimento'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível remover.'),
  });

  if (!isNew && article.isPending) return <LoadingList rows={3} />;
  if (!isNew && article.isError) return <Alert kind="error">{article.error.message}</Alert>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link to="/base-de-conhecimento" className="text-sm text-muted hover:text-fg">← Base de conhecimento</Link>
      <Card className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Título"><Input value={form.title} onChange={set('title')} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Status"><Select value={form.status} onChange={set('status')}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Visibilidade"><Select value={form.visibility} onChange={set('visibility')}>{Object.entries(VIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Categoria"><Select value={form.categoryId} onChange={set('categoryId')}><option value="">Nenhuma</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        </div>
        {form.status === 'published' && form.visibility === 'portal' && <Alert>Este artigo ficará visível para os clientes no portal.</Alert>}
        <div>
          <div role="tablist" aria-label="Editor" className="mb-2 flex gap-1 text-sm">
            {(['write', 'preview'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded px-3 py-1', tab === t ? 'bg-surface font-medium' : 'text-muted')}>{t === 'write' ? 'Escrever' : 'Pré-visualizar'}</button>
            ))}
          </div>
          {tab === 'write' ? (
            <>
              <label htmlFor="kb-body" className="sr-only">Conteúdo (Markdown)</label>
              <Textarea id="kb-body" rows={16} className="font-mono" value={form.body} onChange={set('body')} placeholder="Escreva em Markdown: **negrito**, listas com -, links [texto](url)…" />
            </>
          ) : (
            <div className="min-h-64 rounded-md border border-border p-4">{form.body ? <Markdown>{form.body}</Markdown> : <p className="text-sm text-muted">Nada para mostrar.</p>}</div>
          )}
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          {!isNew ? (
            <Button variant="ghost" className="text-danger" onClick={async () => { if (await confirm({ title: 'Excluir artigo?', message: 'Esta ação não pode ser desfeita.', confirmLabel: 'Excluir', danger: true })) remove.mutate(); }}>
              <Trash2 className="h-4 w-4" aria-hidden />Excluir
            </Button>
          ) : <span />}
          <Button loading={save.isPending} disabled={!form.title.trim()} onClick={() => { setError(null); save.mutate(); }}>Salvar artigo</Button>
        </div>
      </Card>
    </div>
  );
}
