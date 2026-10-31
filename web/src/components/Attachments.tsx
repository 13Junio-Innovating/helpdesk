import { useRef, useState, type DragEvent } from 'react';
import { Download, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, type TicketAttachment } from '@helpdesk/shared';
import { api, ApiError } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { Button } from './ui/button';
import { useConfirm } from './ui/dialog';
import { useToast } from './ui/toast';

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`);
const ACCEPT = ATTACHMENT_TYPES.join(',');

/** Valida no navegador antes de pedir a URL (a API valida de novo). */
export function checkFile(f: File): string | null {
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(f.type)) return `${f.name}: tipo de arquivo não permitido.`;
  if (f.size > MAX_ATTACHMENT_BYTES) return `${f.name}: maior que 25 MB.`;
  if (f.size === 0) return `${f.name}: arquivo vazio.`;
  return null;
}

/** presign → PUT direto no S3 com progresso (XHR) → confirm. */
export async function uploadFile(ticketId: string, file: File, onProgress: (pct: number) => void): Promise<TicketAttachment> {
  const pre = await api<{ uploadUrl: string; storageKey: string; headers: Record<string, string> }>(`/tickets/${ticketId}/attachments/presign`, {
    method: 'POST',
    body: { filename: file.name, contentType: file.type, size: file.size },
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', pre.uploadUrl);
    Object.entries(pre.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`falha no envio (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('falha de rede no envio'));
    xhr.send(file);
  });
  return api<TicketAttachment>(`/tickets/${ticketId}/attachments/confirm`, {
    method: 'POST',
    body: { storageKey: pre.storageKey, filename: file.name, contentType: file.type, size: file.size },
  });
}

async function download(id: string) {
  const r = await api<{ url: string }>(`/attachments/${id}/download`);
  window.location.assign(r.url);
}

interface Pending { name: string; pct: number; error?: string }

/** Lista + área de arrastar e soltar com progresso. */
export function Attachments({ ticketId, items, canDelete, onChange }: {
  ticketId: string;
  items: TicketAttachment[];
  canDelete: (a: TicketAttachment) => boolean;
  onChange: () => Promise<unknown>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);

  const handle = async (files: FileList | File[]) => {
    const list = [...files];
    const errors = list.map(checkFile).filter((e): e is string => !!e);
    errors.forEach((e) => toast('error', e));
    const ok = list.filter((f) => !checkFile(f));
    setPending(ok.map((f) => ({ name: f.name, pct: 0 })));
    for (const [i, f] of ok.entries()) {
      try {
        await uploadFile(ticketId, f, (pct) => setPending((p) => p.map((x, j) => (j === i ? { ...x, pct } : x))));
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'falha';
        setPending((p) => p.map((x, j) => (j === i ? { ...x, error: msg } : x)));
        toast('error', `${f.name}: ${msg}`);
      }
    }
    await onChange();
    setPending((p) => p.filter((x) => x.error));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) void handle(e.dataTransfer.files);
  };

  return (
    <section aria-label="Anexos" className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-sm font-medium"><Paperclip className="h-4 w-4" aria-hidden />Anexos ({items.length})</h2>
      {items.length > 0 && (
        <ul className="space-y-1 text-sm">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
              <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{a.filename}</span>
                <span className="block text-xs text-muted">{formatBytes(a.sizeBytes)} · {a.uploadedBy?.name ?? '—'} · {timeAgo(a.createdAt)}</span>
              </span>
              <Button size="icon" variant="ghost" aria-label={`Baixar ${a.filename}`} onClick={() => void download(a.id).catch((e) => toast('error', e instanceof ApiError ? e.message : 'Falha no download.'))}><Download className="h-4 w-4" /></Button>
              {canDelete(a) && (
                <Button size="icon" variant="ghost" aria-label={`Remover ${a.filename}`} onClick={async () => {
                  if (!(await confirm({ title: 'Remover anexo?', message: a.filename, confirmLabel: 'Remover', danger: true }))) return;
                  try { await api(`/attachments/${a.id}`, { method: 'DELETE' }); await onChange(); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Falha ao remover.'); }
                }}><Trash2 className="h-4 w-4" /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending.map((p) => (
        <div key={p.name} className="text-xs">
          <div className="flex justify-between"><span className="truncate">{p.name}</span><span>{p.error ? 'erro' : `${p.pct}%`}</span></div>
          <div className="h-1.5 rounded-full bg-primary/15" role="progressbar" aria-label={`Enviando ${p.name}`} aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn('h-1.5 rounded-full', p.error ? 'bg-danger' : 'bg-primary')} style={{ width: `${p.error ? 100 : p.pct}%` }} />
          </div>
        </div>
      ))}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn('flex flex-col items-center gap-1 rounded-md border border-dashed p-3 text-center text-xs text-muted', drag ? 'border-primary bg-primary/5' : 'border-border')}
      >
        <Upload className="h-4 w-4" aria-hidden />
        <span>Arraste arquivos aqui ou</span>
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>Escolher arquivos</Button>
        <span>PDF, imagens, Office, CSV, TXT ou ZIP · até 25 MB</span>
        <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Anexar arquivos" onChange={(e) => { if (e.target.files?.length) void handle(e.target.files); e.target.value = ''; }} />
      </div>
    </section>
  );
}
