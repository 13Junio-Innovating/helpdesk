import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Alert, EmptyState, LoadingList } from '@/components/ui/misc';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

export type FieldDef =
  | { name: string; label: string; type: 'text' | 'textarea' | 'color'; required?: boolean; hint?: string }
  | { name: string; label: string; type: 'number'; required?: boolean; min?: number; max?: number; hint?: string }
  | { name: string; label: string; type: 'checkbox'; hint?: string }
  | { name: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; nullable?: boolean; nullLabel?: string; hint?: string };

type Row = Record<string, unknown> & { id: string };

/** Lista + criar/editar em diálogo + excluir com confirmação, para os recursos simples do catálogo. */
export function CatalogCrud({ title, path, fields, columns, defaults, describe }: {
  title: string;
  /** ex.: 'queues' → /catalog/queues */
  path: string;
  fields: FieldDef[];
  columns: Array<{ label: string; render: (r: Row) => ReactNode }>;
  defaults: Record<string, unknown>;
  describe?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ['catalog', path];
  const list = useQuery({ queryKey: key, queryFn: () => api<Row[]>(`/catalog/${path}`) });
  const [editing, setEditing] = useState<Row | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api(`/catalog/${path}/${id}`, { method: 'DELETE' }),
    onSuccess: async () => { toast('success', 'Removido.'); await qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível remover.'),
  });

  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {describe && <p className="text-sm text-muted">{describe}</p>}
        </div>
        <Button size="sm" onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden />Adicionar</Button>
      </div>
      {list.isPending ? <LoadingList rows={3} /> : list.isError ? <Alert kind="error">{list.error.message}</Alert> : list.data.length === 0 ? <EmptyState title="Nada cadastrado ainda" /> : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase text-muted">
              <tr>{columns.map((c) => <th key={c.label} className="p-3">{c.label}</th>)}<th className="w-24 p-3"><span className="sr-only">Ações</span></th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.data.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => <td key={c.label} className="p-3">{c.render(r)}</td>)}
                  <td className="whitespace-nowrap p-3 text-right">
                    <Button size="icon" variant="ghost" aria-label={`Editar ${String(r['name'] ?? r['title'] ?? '')}`} onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" aria-label={`Remover ${String(r['name'] ?? r['title'] ?? '')}`} onClick={async () => {
                      if (await confirm({ title: 'Remover item?', message: `"${String(r['name'] ?? r['title'])}" será removido. Itens em uso não podem ser removidos.`, confirmLabel: 'Remover', danger: true })) remove.mutate(r.id);
                    }}><Trash2 className="h-4 w-4" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EditDialog
          title={editing === 'new' ? `Adicionar — ${title}` : `Editar — ${title}`}
          fields={fields}
          initial={editing === 'new' ? defaults : editing}
          onClose={() => setEditing(null)}
          onSave={async (values) => {
            if (editing === 'new') await api(`/catalog/${path}`, { method: 'POST', body: values });
            else await api(`/catalog/${path}/${editing.id}`, { method: 'PATCH', body: values });
            await qc.invalidateQueries({ queryKey: ['catalog'] });
            toast('success', 'Salvo.');
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function EditDialog({ title, fields, initial, onClose, onSave }: {
  title: string; fields: FieldDef[]; initial: Record<string, unknown>; onClose: () => void; onSave: (v: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.name, initial[f.name] ?? (f.type === 'checkbox' ? false : '')])));
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    setErrors({});
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (f.type === 'number') body[f.name] = v === '' ? undefined : Number(v);
      else if (f.type === 'select') body[f.name] = v === '' ? (f.nullable ? null : undefined) : v;
      else if (f.type === 'checkbox') body[f.name] = !!v;
      else body[f.name] = v === '' && !('required' in f && f.required) ? null : v;
    }
    try {
      await onSave(body);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setErrors(Object.fromEntries(e.fieldErrors.map((i) => [i.field.split('.')[0]!, i.message])));
      } else setError('Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {error && <Alert kind="error">{error}</Alert>}
        {fields.map((f) => {
          const v = values[f.name];
          if (f.type === 'checkbox') {
            return (
              <label key={f.name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!v} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label}{f.hint && <span className="text-xs text-muted">— {f.hint}</span>}
              </label>
            );
          }
          return (
            <Field key={f.name} label={f.label} error={errors[f.name]} hint={f.hint}>
              {f.type === 'select' ? (
                <Select value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)}>
                  {f.nullable && <option value="">{f.nullLabel ?? 'Nenhum'}</option>}
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : f.type === 'textarea' ? (
                <Textarea rows={6} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} />
              ) : f.type === 'color' ? (
                <Input type="color" className="h-10 w-20 p-1" value={String(v || '#64748b')} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <Input type={f.type === 'number' ? 'number' : 'text'} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} {...(f.type === 'number' ? { min: f.min, max: f.max } : {})} />
              )}
            </Field>
          );
        })}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Salvar</Button>
        </div>
      </form>
    </Dialog>
  );
}
