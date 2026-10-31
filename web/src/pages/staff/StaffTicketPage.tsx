import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, BookOpen, Clock, Lock, Mail, Plus, Send, Tag, Trash2, X } from 'lucide-react';
import type { KbArticleSummary, Paginated, TicketDetail, TicketEvent, TicketMessage, TimeEntry } from '@helpdesk/shared';
import { useAuth } from '@/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { nameMap, useAgents, useCategories, useMacros, usePriorities, useQueues, useStatuses } from '@/lib/catalog';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { cn, formatDateTime, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, LoadingList } from '@/components/ui/misc';
import { useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { TimerBadge } from '@/components/staff/badges';
import { Attachments } from '@/components/Attachments';

type Patch = Partial<Record<'statusId' | 'priorityId' | 'assigneeId' | 'queueId' | 'categoryId', string | null>> & { tags?: string[] };

export function StaffTicketPage() {
  const { id = '' } = useParams();
  const key = ['tickets', 'detail', id];
  const qc = useQueryClient();
  const toast = useToast();
  const statuses = useStatuses();
  const q = useQuery({ queryKey: key, queryFn: ({ signal }) => api<TicketDetail>(`/tickets/${id}`, { signal }), refetchInterval: 20_000 });
  useDocumentTitle(q.data ? `#${q.data.number} ${q.data.subject}` : 'Chamado');

  // UI otimista: aplica na hora, desfaz se a API recusar
  const update = useMutation({
    mutationFn: (patch: Patch) => api<TicketDetail>(`/tickets/${id}`, { method: 'PATCH', body: patch }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TicketDetail>(key);
      const status = patch.statusId ? statuses.data?.find((s) => s.id === patch.statusId) : undefined;
      if (prev && status) qc.setQueryData<TicketDetail>(key, { ...prev, status: { id: status.id, name: status.name, kind: status.kind, color: status.color } });
      return { prev };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast('error', e instanceof ApiError ? e.message : 'Não foi possível salvar a alteração.');
    },
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      void qc.invalidateQueries({ queryKey: ['tickets', 'staff'] });
    },
  });

  if (q.isPending) return <LoadingList rows={4} label="Carregando chamado" />;
  if (q.isError) {
    return <Alert kind="error">{q.error instanceof ApiError && q.error.status === 404 ? 'Chamado não encontrado.' : q.error.message} <Link to="/chamados" className="underline">Voltar</Link></Alert>;
  }
  const t = q.data;

  return (
    <div className="space-y-4">
      <Link to="/chamados" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" aria-hidden /> Chamados</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">Chamado #{t.number} · via {CHANNEL[t.channel]}</p>
          <h1 className="text-2xl font-semibold break-words">{t.subject}</h1>
          <p className="text-sm text-muted">
            {t.requester.name} &lt;{t.requester.email}&gt;{t.organization ? ` · ${t.organization.name}` : ''} · aberto {timeAgo(t.createdAt)}
          </p>
        </div>
        <Badge color={t.status.color} className="text-sm">{t.status.name}</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Timeline ticket={t} />
          <Composer ticket={t} onSent={() => qc.invalidateQueries({ queryKey: key })} />
        </div>
        <aside className="space-y-4" aria-label="Detalhes do chamado">
          <Properties ticket={t} onChange={(p) => update.mutate(p)} saving={update.isPending} />
          <SlaCard ticket={t} />
          <Card className="p-4 sm:p-4">
            <Attachments ticketId={t.id} items={t.attachments} canDelete={() => true} onChange={() => qc.invalidateQueries({ queryKey: key })} />
          </Card>
          <TimeCard ticketId={t.id} total={t.timeSpentMinutes ?? 0} onChange={() => qc.invalidateQueries({ queryKey: key })} />
        </aside>
      </div>
    </div>
  );
}

const CHANNEL: Record<string, string> = { portal: 'portal', email: 'e-mail', chat: 'chat', phone: 'telefone', api: 'API' };
const TIMER: Record<string, string> = { first_response: 'primeira resposta', resolution: 'resolução' };

// ---------------------------------------------------------------------------
// linha do tempo: descrição + mensagens públicas + notas internas + auditoria, em ordem

function Timeline({ ticket: t }: { ticket: TicketDetail }) {
  const agents = useAgents();
  const queues = useQueues();
  const categories = useCategories();
  const priorities = usePriorities();
  const names = useMemo(() => nameMap(agents.data, queues.data, categories.data, priorities.data), [agents.data, queues.data, categories.data, priorities.data]);

  type Item = { at: string; key: string; node: ReactNode };
  const items: Item[] = [
    { at: t.createdAt, key: 'desc', node: <Message author={t.requester.name} at={t.createdAt} body={t.description || '(sem descrição)'} kind="public_reply" fromCustomer /> },
    ...t.messages.map((m: TicketMessage) => ({
      at: m.createdAt,
      key: m.id,
      node: <Message author={m.author?.name ?? 'Sistema'} at={m.createdAt} body={m.body} kind={m.kind} fromCustomer={m.author?.id === t.requester.id} />,
    })),
    ...(t.events ?? [])
      .filter((e) => e.type !== 'created')
      .map((e: TicketEvent) => ({ at: e.createdAt, key: `e${e.id}`, node: <EventLine event={e} names={names} /> })),
  ];
  items.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section aria-label="Linha do tempo" className="space-y-3">
      {items.map((i) => <div key={i.key}>{i.node}</div>)}
    </section>
  );
}

function Message({ author, at, body, kind, fromCustomer }: { author: string; at: string; body: string; kind: TicketMessage['kind']; fromCustomer: boolean }) {
  const note = kind === 'internal_note';
  return (
    <article className={cn('rounded-lg border p-4', note ? 'border-warning/50 bg-note' : fromCustomer ? 'border-border bg-surface' : 'border-primary/30 bg-primary/5')}>
      <header className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{author}</span>
        {note ? (
          <span className="inline-flex items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-xs font-medium text-warning"><Lock className="h-3 w-3" aria-hidden />Nota interna</span>
        ) : (
          !fromCustomer && <span className="inline-flex items-center gap-1 text-xs text-muted"><Mail className="h-3 w-3" aria-hidden />Resposta pública</span>
        )}
        <time dateTime={at} title={formatDateTime(at)} className="text-xs text-muted">{timeAgo(at)}</time>
      </header>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</p>
    </article>
  );
}

function EventLine({ event: e, names }: { event: TicketEvent; names: Map<string, string> }) {
  const who = e.actor?.name ?? 'Sistema'; // sem autor: automação, worker ou carga de dados
  const d = e.data as Record<string, string | null>;
  const n = (id: string | null | undefined) => (id ? names.get(id) ?? 'item removido' : null);
  const text: Record<string, string> = {
    status_changed: `mudou o status de "${d['from']}" para "${d['to']}"`,
    assigned: d['to'] ? `atribuiu a ${n(d['to'])}` : 'removeu o responsável',
    queue_changed: d['to'] ? `moveu para a fila ${n(d['to'])}` : 'tirou o chamado da fila',
    category_changed: d['to'] ? `mudou a categoria para ${n(d['to'])}` : 'removeu a categoria',
    priority_changed: `mudou a prioridade para ${n(d['to'])}`,
    sla_breached: `SLA de ${TIMER[d['kind'] ?? ''] ?? 'atendimento'} estourado`,
    sla_warning: `SLA de ${TIMER[d['kind'] ?? ''] ?? 'atendimento'} perto de vencer`,
  };
  const sys = e.type.startsWith('sla_');
  return (
    <p className={cn('flex flex-wrap items-center gap-1 px-2 text-xs', e.type === 'sla_breached' ? 'text-danger' : 'text-muted')}>
      <span aria-hidden>•</span>
      {!sys && <span className="font-medium">{who}</span>}
      <span>{text[e.type] ?? e.type}</span>
      <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>· {timeAgo(e.createdAt)}</time>
    </p>
  );
}

// ---------------------------------------------------------------------------
// editor: padrão seguro = nota interna; resposta pública só com destinatário visível

function Composer({ ticket: t, onSent }: { ticket: TicketDetail; onSent: () => Promise<void> }) {
  const [mode, setMode] = useState<'internal_note' | 'public_reply'>('internal_note');
  const [body, setBody] = useState('');
  const toast = useToast();
  const macros = useMacros();
  const send = useMutation({
    mutationFn: () => api<TicketMessage>(`/tickets/${t.id}/messages`, { method: 'POST', body: { kind: mode, body: body.trim() } }),
    onSuccess: async () => {
      toast('success', mode === 'public_reply' ? 'Resposta enviada ao cliente.' : 'Nota interna salva.');
      setBody('');
      setMode('internal_note'); // volta ao padrão seguro
      await onSent();
    },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível enviar.'),
  });
  const pub = mode === 'public_reply';
  const insert = (text: string) => setBody((b) => (b ? `${b.trimEnd()}\n\n${text}` : text));

  return (
    <Card className={cn('space-y-3', !pub && 'border-warning/50')}>
      <div role="radiogroup" aria-label="Tipo de mensagem" className="inline-flex rounded-md border border-border p-0.5 text-sm">
        {(['internal_note', 'public_reply'] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn('inline-flex items-center gap-1.5 rounded px-3 py-1.5', mode === m ? (m === 'internal_note' ? 'bg-warning/20 font-medium' : 'bg-primary text-primary-fg') : 'text-muted')}
          >
            {m === 'internal_note' ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Mail className="h-3.5 w-3.5" aria-hidden />}
            {m === 'internal_note' ? 'Nota interna' : 'Resposta pública'}
          </button>
        ))}
      </div>

      {pub ? (
        <Alert>Será enviada por e-mail para <strong>{t.requester.name} &lt;{t.requester.email}&gt;</strong> e aparecerá no portal.</Alert>
      ) : (
        <p className="text-xs text-muted">Visível só para a equipe. O cliente nunca vê notas internas.</p>
      )}

      <label htmlFor="composer" className="sr-only">{pub ? 'Resposta ao cliente' : 'Nota interna'}</label>
      <Textarea id="composer" rows={6} value={body} onChange={(e) => setBody(e.target.value)} className={cn(!pub && 'bg-note')} placeholder={pub ? 'Escreva a resposta ao cliente…' : 'Anotação para a equipe…'} />

      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Inserir resposta pronta" className="h-9 w-auto" value="" onChange={(e) => { const m = macros.data?.find((x) => x.id === e.target.value); if (m) insert(m.body); }}>
          <option value="">Resposta pronta…</option>
          {macros.data?.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </Select>
        <KbSuggestions subject={t.subject} onInsert={insert} />
        <Button className="ml-auto" variant={pub ? 'primary' : 'secondary'} loading={send.isPending} disabled={!body.trim()} onClick={() => send.mutate()}>
          {pub ? <><Send className="h-4 w-4" aria-hidden /> Enviar ao cliente</> : <><Lock className="h-4 w-4" aria-hidden /> Salvar nota interna</>}
        </Button>
      </div>
    </Card>
  );
}

function KbSuggestions({ subject, onInsert }: { subject: string; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(subject);
  const q = useDebounced(term.trim(), 300);
  const res = useQuery({
    queryKey: ['kb', 'staff-suggest', q],
    queryFn: () => api<Paginated<KbArticleSummary>>('/kb', { query: { q, status: 'published', limit: 5 } }),
    enabled: open && q.length >= 2,
  });
  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}><BookOpen className="h-4 w-4" aria-hidden /> Artigos</Button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-[calc(100vw-3rem)] rounded-md border border-border bg-bg p-3 shadow-lg">
          <Input aria-label="Buscar artigos" value={term} onChange={(e) => setTerm(e.target.value)} className="h-8" />
          <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto">
            {res.data?.items.length === 0 && <li className="text-xs text-muted">Nenhum artigo publicado encontrado.</li>}
            {res.data?.items.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-2 rounded p-1 text-sm hover:bg-surface">
                <span>{a.title}{a.visibility === 'internal' && <span className="ml-1 text-xs text-muted">(interno)</span>}</span>
                <Button size="sm" variant="secondary" onClick={() => {
                  onInsert(a.visibility === 'portal' ? `${a.title}: ${window.location.origin}/portal/ajuda/${a.slug}` : a.excerpt);
                  setOpen(false);
                }}>Inserir</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// propriedades editáveis na lateral

function Properties({ ticket: t, onChange, saving }: { ticket: TicketDetail; onChange: (p: Patch) => void; saving: boolean }) {
  const { me } = useAuth();
  const statuses = useStatuses();
  const priorities = usePriorities();
  const agents = useAgents();
  const queues = useQueues();
  const categories = useCategories();
  const [tag, setTag] = useState('');
  const row = 'space-y-1';
  const label = 'text-xs font-medium text-muted';
  const resolved = t.status.kind === 'resolved' || t.status.kind === 'closed';
  const firstOpen = statuses.data?.find((s) => s.kind === 'open' && !s.isDefault) ?? statuses.data?.find((s) => s.kind === 'open');
  const resolvedStatus = statuses.data?.find((s) => s.kind === 'resolved');

  return (
    <Card className="space-y-3 p-4 sm:p-4" aria-busy={saving}>
      <div className="flex gap-2">
        {resolved
          ? firstOpen && <Button size="sm" variant="secondary" className="flex-1" onClick={() => onChange({ statusId: firstOpen.id })}>Reabrir</Button>
          : resolvedStatus && <Button size="sm" className="flex-1" onClick={() => onChange({ statusId: resolvedStatus.id })}>Resolver</Button>}
        {t.assignee?.id !== me?.user.id && <Button size="sm" variant="secondary" className="flex-1" onClick={() => onChange({ assigneeId: me?.user.id ?? null })}>Atribuir a mim</Button>}
      </div>
      <div className={row}>
        <label htmlFor="p-status" className={label}>Status</label>
        <Select id="p-status" value={t.status.id} onChange={(e) => onChange({ statusId: e.target.value })}>
          {statuses.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.slaPauses ? ' (pausa SLA)' : ''}</option>)}
        </Select>
      </div>
      <div className={row}>
        <label htmlFor="p-priority" className={label}>Prioridade</label>
        <Select id="p-priority" value={t.priority.id} onChange={(e) => onChange({ priorityId: e.target.value })}>
          {priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      <div className={row}>
        <label htmlFor="p-assignee" className={label}>Responsável</label>
        <Select id="p-assignee" value={t.assignee?.id ?? ''} onChange={(e) => onChange({ assigneeId: e.target.value || null })}>
          <option value="">Sem responsável</option>
          {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </div>
      <div className={row}>
        <label htmlFor="p-queue" className={label}>Fila</label>
        <Select id="p-queue" value={t.queue?.id ?? ''} onChange={(e) => onChange({ queueId: e.target.value || null })}>
          <option value="">Nenhuma</option>
          {queues.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
      </div>
      <div className={row}>
        <label htmlFor="p-category" className={label}>Categoria</label>
        <Select id="p-category" value={t.category?.id ?? ''} onChange={(e) => onChange({ categoryId: e.target.value || null })}>
          <option value="">Nenhuma</option>
          {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
      <div className={row}>
        <span className={label} id="tags-label">Tags</span>
        <div className="flex flex-wrap gap-1" aria-labelledby="tags-label">
          {t.tags.map((tg) => (
            <span key={tg} className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-xs">
              <Tag className="h-3 w-3" aria-hidden />{tg}
              <button aria-label={`Remover tag ${tg}`} onClick={() => onChange({ tags: t.tags.filter((x) => x !== tg) })}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); const v = tag.trim().toLowerCase(); if (v && !t.tags.includes(v)) onChange({ tags: [...t.tags, v] }); setTag(''); }}>
          <Input aria-label="Nova tag" className="h-8" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="nova tag" />
          <Button type="submit" size="sm" variant="secondary" aria-label="Adicionar tag"><Plus className="h-4 w-4" /></Button>
        </form>
      </div>
    </Card>
  );
}

function SlaCard({ ticket: t }: { ticket: TicketDetail }) {
  if (!t.sla) return null;
  const timers = [['Primeira resposta', t.sla.firstResponse], ['Resolução', t.sla.resolution]] as const;
  return (
    <Card className="space-y-2 p-4 sm:p-4">
      <h2 className="text-sm font-medium">SLA</h2>
      {timers.map(([name, timer]) => timer && (
        <div key={name} className="flex items-center justify-between gap-2 text-sm">
          <span>{name}</span>
          <span className="flex flex-col items-end gap-0.5">
            <TimerBadge timer={timer} />
            <span className="text-xs text-muted">prazo {formatDateTime(timer.dueAt)}</span>
          </span>
        </div>
      ))}
    </Card>
  );
}

function TimeCard({ ticketId, total, onChange }: { ticketId: string; total: number; onChange: () => Promise<void> }) {
  const { me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const entries = useQuery({ queryKey: ['tickets', 'time', ticketId], queryFn: () => api<TimeEntry[]>(`/tickets/${ticketId}/time-entries`) });
  const refresh = async () => { await entries.refetch(); await onChange(); };
  const add = useMutation({
    mutationFn: () => api<TimeEntry>(`/tickets/${ticketId}/time-entries`, { method: 'POST', body: { minutes: Number(minutes), note: note.trim() || undefined } }),
    onSuccess: async () => { setMinutes(''); setNote(''); await refresh(); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível apontar.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/time-entries/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível remover.'),
  });
  const fmt = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  return (
    <Card className="space-y-2 p-4 sm:p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-medium"><Clock className="h-4 w-4" aria-hidden />Horas apontadas: {fmt(total)}</h2>
      <form className="grid grid-cols-[5rem_1fr_auto] gap-1" onSubmit={(e) => { e.preventDefault(); if (Number(minutes) > 0) add.mutate(); }}>
        <Input aria-label="Minutos" type="number" min={1} max={1440} className="h-8" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="min" />
        <Input aria-label="Descrição do trabalho" className="h-8" value={note} onChange={(e) => setNote(e.target.value)} placeholder="o que foi feito" />
        <Button type="submit" size="sm" loading={add.isPending} disabled={!(Number(minutes) > 0)}>Apontar</Button>
      </form>
      <ul className="space-y-1 text-xs">
        {entries.data?.map((e) => (
          <li key={e.id} className="flex items-center gap-2">
            <span className="font-medium">{fmt(e.minutes)}</span>
            <span className="flex-1 truncate text-muted">{e.user.name}{e.note ? ` · ${e.note}` : ''}</span>
            {(e.user.id === me?.user.id || me?.role === 'admin') && (
              <button aria-label={`Remover apontamento de ${fmt(e.minutes)}`} className="text-muted hover:text-danger" onClick={async () => {
                if (await confirm({ title: 'Remover apontamento?', message: `${fmt(e.minutes)} de ${e.user.name} serão removidos.`, confirmLabel: 'Remover', danger: true })) remove.mutate(e.id);
              }}><Trash2 className="h-3.5 w-3.5" /></button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
