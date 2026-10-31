import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { BookOpen, ExternalLink, Paperclip, X } from 'lucide-react';
import { checkFile, formatBytes, uploadFile } from '@/components/Attachments';
import type { KbArticleSummary, Paginated, TicketDetail } from '@helpdesk/shared';
import { api, ApiError } from '@/lib/api';
import { applyApiErrors } from '@/lib/forms';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Card } from '@/components/ui/misc';

const schema = z.object({
  subject: z.string().trim().min(3, 'Descreva o assunto em poucas palavras').max(300),
  description: z.string().trim().min(10, 'Conte um pouco mais (mínimo de 10 caracteres)').max(50_000),
  categoryId: z.string().optional(),
});
type Form = z.infer<typeof schema>;

const QUOTA_MSG: Record<string, string> = {
  ticket_quota_exceeded: 'Este workspace atingiu o limite de chamados do plano neste mês. Avise o responsável pela conta.',
  tenant_inactive: 'Este workspace está suspenso e não aceita novos chamados no momento.',
};

export function NewTicketPage() {
  useDocumentTitle('Abrir chamado');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const { register, handleSubmit, formState, watch, setError: setFieldError } = useForm<Form>({ resolver: zodResolver(schema) });

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => api<Array<{ id: string; name: string; active: boolean }>>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });

  // sugere artigos da base enquanto o cliente digita o assunto (antes de enviar)
  const subject = useDebounced(watch('subject')?.trim() ?? '', 400);
  const suggestions = useQuery({
    queryKey: ['kb', 'suggest', subject],
    queryFn: ({ signal }) => api<Paginated<KbArticleSummary>>('/kb', { query: { q: subject, limit: 5 }, signal }),
    enabled: subject.length >= 3,
    staleTime: 60_000,
  });

  const onSubmit = handleSubmit(async (data) => {
    setError(null);
    try {
      const t = await api<TicketDetail>('/tickets', {
        method: 'POST',
        body: { subject: data.subject, description: data.description, categoryId: data.categoryId || undefined },
      });
      // anexos sobem depois que o chamado existe (a chave no storage leva o id do chamado)
      const failed: string[] = [];
      for (const f of files) {
        try {
          await uploadFile(t.id, f, (pct) => setProgress(`Enviando ${f.name}: ${pct}%`));
        } catch {
          failed.push(f.name);
        }
      }
      setProgress(null);
      await qc.invalidateQueries({ queryKey: ['tickets'] });
      navigate(`/portal/chamados/${t.id}`, { state: { created: true, failedUploads: failed } });
    } catch (e) {
      setError(e instanceof ApiError && QUOTA_MSG[e.code] ? QUOTA_MSG[e.code]! : applyApiErrors(e, setFieldError, ['subject', 'description', 'categoryId']));
    }
  });

  const articles = suggestions.data?.items ?? [];
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Abrir chamado</h1>
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <Card>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            {error && <Alert kind="error">{error}</Alert>}
            <Field label="Assunto" error={formState.errors.subject?.message}>
              <Input autoFocus placeholder="Ex.: Não consigo acessar o sistema" {...register('subject')} />
            </Field>
            <Field label="Categoria (opcional)" error={formState.errors.categoryId?.message}>
              <Select {...register('categoryId')} disabled={categories.isPending}>
                <option value="">Não sei / outra</option>
                {categories.data
                  ?.filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Descrição" error={formState.errors.description?.message} hint="Inclua o que aconteceu, quando começou e mensagens de erro.">
              <Textarea rows={8} {...register('description')} />
            </Field>
            <div className="space-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-primary">
                <Paperclip className="h-4 w-4" aria-hidden />Anexar arquivos (opcional)
                <input type="file" multiple className="sr-only" onChange={(e) => {
                  const picked = [...(e.target.files ?? [])];
                  const bad = picked.map(checkFile).filter(Boolean);
                  setError(bad.length ? bad.join(' ') : null);
                  setFiles((cur) => [...cur, ...picked.filter((f) => !checkFile(f))]);
                  e.target.value = '';
                }} />
              </label>
              {files.length > 0 && (
                <ul className="space-y-1 text-sm" aria-label="Arquivos para anexar">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2">
                      <span className="flex-1 truncate">{f.name} <span className="text-xs text-muted">({formatBytes(f.size)})</span></span>
                      <button type="button" aria-label={`Remover ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
                    </li>
                  ))}
                </ul>
              )}
              {progress && <p role="status" className="text-xs text-muted">{progress}</p>}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => navigate(-1)}>
                Cancelar
              </Button>
              <Button type="submit" loading={formState.isSubmitting}>
                Enviar chamado
              </Button>
            </div>
          </form>
        </Card>

        <aside aria-live="polite" aria-label="Artigos sugeridos" className="space-y-2">
          {articles.length > 0 && (
            <Card className="p-4 sm:p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-primary" aria-hidden /> Isto pode resolver
              </p>
              <ul className="space-y-2">
                {articles.map((a) => (
                  <li key={a.id}>
                    <Link to={`/portal/ajuda/${a.slug}`} target="_blank" className="group block rounded p-1 text-sm hover:bg-surface">
                      <span className="flex items-center gap-1 font-medium text-primary group-hover:underline">
                        {a.title} <ExternalLink className="h-3 w-3" aria-label="(abre em nova aba)" />
                      </span>
                      <span className="line-clamp-2 text-xs text-muted">{a.excerpt}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
