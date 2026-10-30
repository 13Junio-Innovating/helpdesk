import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Member, TicketDetail } from '@helpdesk/shared';
import { api, ApiError } from '@/lib/api';
import { applyApiErrors } from '@/lib/forms';
import { useAgents, useCategories, usePriorities, useQueues } from '@/lib/catalog';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Card } from '@/components/ui/misc';

const schema = z.object({
  requesterId: z.string().uuid('Escolha o cliente'),
  subject: z.string().trim().min(1, 'Informe o assunto').max(300),
  description: z.string().max(50_000).optional(),
  categoryId: z.string().optional(),
  priorityId: z.string().optional(),
  assigneeId: z.string().optional(),
  queueId: z.string().optional(),
  channel: z.enum(['phone', 'email', 'chat', 'portal']),
  tags: z.string().optional(),
});
type Form = z.infer<typeof schema>;
const blank = (v?: string) => (v ? v : undefined);

/** Equipe abre chamado em nome de um cliente (ex.: atendimento por telefone). */
export function NewStaffTicketPage() {
  useDocumentTitle('Novo chamado');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const requesters = useQuery({ queryKey: ['members', 'requesters', q], queryFn: () => api<Member[]>('/members', { query: { role: 'requester', active: true, q: q || undefined } }) });
  const categories = useCategories();
  const priorities = usePriorities();
  const agents = useAgents();
  const queues = useQueues();
  const { register, handleSubmit, formState, setError: setFieldError } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { channel: 'phone' } });

  const onSubmit = handleSubmit(async (d) => {
    setError(null);
    try {
      const t = await api<TicketDetail>('/tickets', {
        method: 'POST',
        body: {
          requesterId: d.requesterId, subject: d.subject, description: blank(d.description), categoryId: blank(d.categoryId),
          priorityId: blank(d.priorityId), assigneeId: blank(d.assigneeId), queueId: blank(d.queueId), channel: d.channel,
          tags: d.tags ? d.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ['tickets'] });
      navigate(`/chamados/${t.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 402 ? e.message : applyApiErrors(e, setFieldError, ['subject', 'description', 'requesterId', 'tags']));
    }
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Novo chamado</h1>
      <Card>
        <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
          {error && <Alert kind="error" className="sm:col-span-2">{error}</Alert>}
          <div className="space-y-2 sm:col-span-2">
            <Field label="Buscar cliente"><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="nome ou e-mail" /></Field>
            <Field label="Cliente" error={formState.errors.requesterId?.message}>
              <Select {...register('requesterId')}>
                <option value="">Selecione…</option>
                {requesters.data?.map((m) => <option key={m.userId} value={m.userId}>{m.name} — {m.email}{m.organization ? ` (${m.organization.name})` : ''}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Assunto" error={formState.errors.subject?.message} className="sm:col-span-2"><Input {...register('subject')} /></Field>
          <Field label="Descrição" className="sm:col-span-2"><Textarea rows={6} {...register('description')} /></Field>
          <Field label="Canal"><Select {...register('channel')}><option value="phone">Telefone</option><option value="email">E-mail</option><option value="chat">Chat</option><option value="portal">Portal</option></Select></Field>
          <Field label="Categoria"><Select {...register('categoryId')}><option value="">Nenhuma</option>{categories.data?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Prioridade"><Select {...register('priorityId')}><option value="">Padrão</option>{priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Responsável"><Select {...register('assigneeId')}><option value="">Sem responsável</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Fila"><Select {...register('queueId')}><option value="">Pela categoria</option>{queues.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Tags" hint="Separadas por vírgula" error={formState.errors.tags?.message}><Input {...register('tags')} /></Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={() => navigate(-1)}>Cancelar</Button>
            <Button type="submit" loading={formState.isSubmitting}>Criar chamado</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
