import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, Send } from 'lucide-react';
import type { TicketDetail, TicketMessage } from '@helpdesk/shared';
import { useAuth } from '@/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime, timeAgo } from '@/lib/utils';
import { useDocumentTitle } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, LoadingList } from '@/components/ui/misc';
import { Attachments } from '@/components/Attachments';

export function TicketPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const location = useLocation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['tickets', 'detail', id],
    queryFn: ({ signal }) => api<TicketDetail>(`/tickets/${id}`, { signal }),
    refetchInterval: 15_000, // atualização leve: novas respostas da equipe aparecem sozinhas
  });
  useDocumentTitle(q.data ? `#${q.data.number} ${q.data.subject}` : 'Chamado');

  if (q.isPending) return <LoadingList rows={3} label="Carregando chamado" />;
  if (q.isError) {
    return (
      <Alert kind="error">
        {q.error instanceof ApiError && q.error.status === 404 ? 'Chamado não encontrado.' : q.error.message}{' '}
        <Link to="/portal" className="underline">
          Voltar para meus chamados
        </Link>
      </Alert>
    );
  }
  const t = q.data;
  const closed = t.status.kind === 'closed';

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to="/portal" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Meus chamados
      </Link>
      {((location.state as { failedUploads?: string[] } | null)?.failedUploads?.length ?? 0) > 0 && (
        <Alert kind="error">Não foi possível anexar: {(location.state as { failedUploads: string[] }).failedUploads.join(', ')}. Tente de novo abaixo.</Alert>
      )}
      {(location.state as { created?: boolean } | null)?.created && (
        <Alert kind="success">Chamado #{t.number} aberto. Você receberá as respostas por e-mail e também aqui.</Alert>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted">Chamado #{t.number}</p>
          <h1 className="text-2xl font-semibold">{t.subject}</h1>
          <p className="text-xs text-muted">Aberto em {formatDateTime(t.createdAt)}</p>
        </div>
        <Badge color={t.status.color} className="text-sm">
          {t.status.name}
        </Badge>
      </div>

      <section aria-label="Conversa" className="space-y-3">
        <Bubble author={t.requester.name} mine={t.requester.id === me?.user.id} at={t.createdAt} body={t.description || '(sem descrição)'} />
        {t.messages.map((m: TicketMessage) => (
          <Bubble key={m.id} author={m.author?.name ?? 'Sistema'} mine={m.author?.id === me?.user.id} at={m.createdAt} body={m.body} />
        ))}
      </section>

      <Card className="p-4 sm:p-4">
        <Attachments ticketId={t.id} items={t.attachments} canDelete={(a) => a.uploadedBy?.id === me?.user.id} onChange={() => q.refetch()} />
      </Card>

      {t.status.kind === 'resolved' && <Alert kind="success">Este chamado foi resolvido. Se o problema voltar, responda abaixo para reabrir.</Alert>}
      {closed ? (
        <Alert>
          Este chamado foi fechado.{' '}
          <Link to="/portal/chamados/novo" className="underline">
            Abra um novo chamado
          </Link>{' '}
          se precisar.
        </Alert>
      ) : (
        <ReplyForm ticketId={t.id} onSent={() => qc.invalidateQueries({ queryKey: ['tickets'] })} />
      )}
    </div>
  );
}

function Bubble({ author, mine, at, body }: { author: string; mine: boolean; at: string; body: string }) {
  return (
    <article className={cn('rounded-lg border p-4', mine ? 'ml-6 border-primary/30 bg-primary/5' : 'mr-6 border-border bg-surface')}>
      <header className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium">{mine ? 'Você' : author}</span>
        <time dateTime={at} title={formatDateTime(at)} className="text-xs text-muted">
          {timeAgo(at)}
        </time>
      </header>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</p>
    </article>
  );
}

function ReplyForm({ ticketId, onSent }: { ticketId: string; onSent: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, watch } = useForm<{ body: string }>({ defaultValues: { body: '' } });
  const send = useMutation({
    mutationFn: (body: string) => api<TicketMessage>(`/tickets/${ticketId}/messages`, { method: 'POST', body: { kind: 'public_reply', body } }),
    onSuccess: async () => {
      reset();
      await onSent();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível enviar.'),
  });
  const empty = !watch('body')?.trim();
  return (
    <Card>
      <form
        onSubmit={handleSubmit(({ body }) => {
          setError(null);
          send.mutate(body.trim());
        })}
        className="space-y-3"
      >
        <label htmlFor="reply" className="text-sm font-medium">
          Responder
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <Textarea id="reply" rows={4} placeholder="Escreva sua mensagem para a equipe…" {...register('body')} />
        <div className="flex justify-end">
          <Button type="submit" loading={send.isPending} disabled={empty}>
            <Send className="h-4 w-4" aria-hidden /> Enviar resposta
          </Button>
        </div>
      </form>
    </Card>
  );
}
