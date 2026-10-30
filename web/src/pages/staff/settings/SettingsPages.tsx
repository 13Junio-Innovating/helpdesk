import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import { AUTOMATION_FIELDS, type Invitation, type Member, type MemberRole, type TenantInfo } from '@helpdesk/shared';
import { useAuth } from '@/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { useAgents, usePriorities, useQueues, useStatuses } from '@/lib/catalog';
import { useDocumentTitle } from '@/lib/hooks';
import { cn, formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Alert, Badge, Card, LoadingList } from '@/components/ui/misc';
import { useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { CatalogCrud } from './CatalogCrud';

const SECTIONS = [
  ['equipe', 'Equipe e convites'], ['filas', 'Filas'], ['categorias', 'Categorias'], ['prioridades', 'Prioridades'], ['status', 'Status'],
  ['respostas-prontas', 'Respostas prontas'], ['horario', 'Horário comercial'], ['sla', 'Políticas de SLA'], ['automacoes', 'Automações'], ['plano', 'Plano e uso'],
] as const;

export function SettingsLayout() {
  useDocumentTitle('Configurações');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Configurações</h1>
      <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
        <nav aria-label="Seções de configuração" className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map(([to, label]) => (
            <NavLink key={to} to={`/configuracoes/${to}`} className={({ isActive }) => cn('whitespace-nowrap rounded-md px-3 py-1.5 text-sm', isActive ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:text-fg')}>{label}</NavLink>
          ))}
        </nav>
        <div className="min-w-0"><Outlet /></div>
      </div>
    </div>
  );
}

const yes = (v: unknown) => (v ? 'Sim' : '—');
const swatch = (c: unknown) => <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: String(c) }} aria-hidden />{String(c)}</span>;
const KINDS = [['open', 'Aberto'], ['pending', 'Pendente (aguardando)'], ['on_hold', 'Em espera'], ['resolved', 'Resolvido'], ['closed', 'Fechado']].map(([value, label]) => ({ value: value!, label: label! }));

export function QueuesSettings() {
  return <CatalogCrud title="Filas" path="queues" defaults={{}} fields={[{ name: 'name', label: 'Nome', type: 'text', required: true }, { name: 'description', label: 'Descrição', type: 'text' }]}
    columns={[{ label: 'Nome', render: (r) => String(r['name']) }, { label: 'Descrição', render: (r) => String(r['description'] ?? '—') }]} />;
}

export function CategoriesSettings() {
  const queues = useQueues();
  const qs = (queues.data ?? []).map((q) => ({ value: q.id, label: q.name }));
  return <CatalogCrud title="Categorias" path="categories" defaults={{ active: true }} describe="A fila padrão recebe os chamados novos da categoria."
    fields={[{ name: 'name', label: 'Nome', type: 'text', required: true }, { name: 'defaultQueueId', label: 'Fila padrão', type: 'select', options: qs, nullable: true }, { name: 'active', label: 'Ativa', type: 'checkbox' }]}
    columns={[{ label: 'Nome', render: (r) => String(r['name']) }, { label: 'Fila padrão', render: (r) => qs.find((q) => q.value === r['defaultQueueId'])?.label ?? '—' }, { label: 'Ativa', render: (r) => yes(r['active']) }]} />;
}

export function PrioritiesSettings() {
  return <CatalogCrud title="Prioridades" path="priorities" defaults={{ level: 1, color: '#64748b', isDefault: false }} describe="Nível maior = mais urgente. A padrão vale para chamados novos."
    fields={[{ name: 'name', label: 'Nome', type: 'text', required: true }, { name: 'level', label: 'Nível (1–10)', type: 'number', min: 1, max: 10 }, { name: 'color', label: 'Cor', type: 'color' }, { name: 'isDefault', label: 'Padrão', type: 'checkbox' }]}
    columns={[{ label: 'Nome', render: (r) => String(r['name']) }, { label: 'Nível', render: (r) => String(r['level']) }, { label: 'Cor', render: (r) => swatch(r['color']) }, { label: 'Padrão', render: (r) => yes(r['isDefault']) }]} />;
}

export function StatusesSettings() {
  return <CatalogCrud title="Status" path="statuses" defaults={{ kind: 'open', slaPauses: false, isDefault: false, position: 10, color: '#64748b' }} describe='"Pausa o SLA": enquanto o chamado estiver neste status, o prazo não corre.'
    fields={[{ name: 'name', label: 'Nome', type: 'text', required: true }, { name: 'kind', label: 'Tipo', type: 'select', options: KINDS }, { name: 'slaPauses', label: 'Pausa o SLA', type: 'checkbox' }, { name: 'isDefault', label: 'Status inicial', type: 'checkbox' }, { name: 'position', label: 'Ordem', type: 'number', min: 0, max: 1000 }, { name: 'color', label: 'Cor', type: 'color' }]}
    columns={[{ label: 'Nome', render: (r) => <Badge color={String(r['color'])}>{String(r['name'])}</Badge> }, { label: 'Tipo', render: (r) => KINDS.find((k) => k.value === r['kind'])?.label }, { label: 'Pausa SLA', render: (r) => yes(r['slaPauses']) }, { label: 'Inicial', render: (r) => yes(r['isDefault']) }]} />;
}

export function MacrosSettings() {
  return <CatalogCrud title="Respostas prontas" path="macros" defaults={{}} describe="Textos que a equipe insere nas respostas com um clique."
    fields={[{ name: 'title', label: 'Título', type: 'text', required: true }, { name: 'body', label: 'Texto', type: 'textarea', required: true }]}
    columns={[{ label: 'Título', render: (r) => String(r['title']) }, { label: 'Texto', render: (r) => <span className="line-clamp-2 text-muted">{String(r['body'])}</span> }]} />;
}

export function SlaSettings() {
  const priorities = usePriorities();
  const bh = useQuery({ queryKey: ['catalog', 'business-hours'], queryFn: () => api<Array<{ id: string; name: string }>>('/catalog/business-hours') });
  const ps = (priorities.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const bs = (bh.data ?? []).map((b) => ({ value: b.id, label: b.name }));
  const mins = (v: unknown) => { const m = Number(v); return m < 60 ? `${m} min` : `${(m / 60).toLocaleString('pt-BR')} h`; };
  return <CatalogCrud title="Políticas de SLA" path="sla-policies" defaults={{ firstResponseMinutes: 240, resolutionMinutes: 1440, active: true, isDefault: false }}
    describe="Prazos em minutos úteis (conforme o horário comercial escolhido). Mudanças valem para chamados novos."
    fields={[{ name: 'name', label: 'Nome', type: 'text', required: true }, { name: 'priorityId', label: 'Prioridade', type: 'select', options: ps, nullable: true, nullLabel: 'Nenhuma (política padrão)' },
      { name: 'firstResponseMinutes', label: 'Primeira resposta (min)', type: 'number', min: 1 }, { name: 'resolutionMinutes', label: 'Resolução (min)', type: 'number', min: 1 },
      { name: 'businessHoursId', label: 'Horário comercial', type: 'select', options: bs, nullable: true, nullLabel: '24x7' }, { name: 'isDefault', label: 'Padrão (sem prioridade)', type: 'checkbox' }, { name: 'active', label: 'Ativa', type: 'checkbox' }]}
    columns={[{ label: 'Nome', render: (r) => String(r['name']) }, { label: 'Prioridade', render: (r) => ps.find((p) => p.value === r['priorityId'])?.label ?? 'padrão' },
      { label: '1ª resposta', render: (r) => mins(r['firstResponseMinutes']) }, { label: 'Resolução', render: (r) => mins(r['resolutionMinutes']) },
      { label: 'Horário', render: (r) => bs.find((b) => b.value === r['businessHoursId'])?.label ?? '24x7' }]} />;
}

// ---------------------------------------------------------------------------

export function TeamSettings() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [invite, setInvite] = useState<{ email: string; role: MemberRole }>({ email: '', role: 'agent' });
  const members = useQuery({ queryKey: ['members', 'staff'], queryFn: async () => (await api<Member[]>('/members')).filter((m) => m.role !== 'requester') });
  const invites = useQuery({ queryKey: ['invitations'], queryFn: () => api<Invitation[]>('/invitations') });
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantInfo>('/tenant') });
  const err = (e: unknown) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível concluir.');
  const update = useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: Record<string, unknown> }) => api(`/members/${userId}`, { method: 'PATCH', body: patch }),
    onSuccess: async () => { toast('success', 'Membro atualizado.'); await qc.invalidateQueries({ queryKey: ['members'] }); await qc.invalidateQueries({ queryKey: ['tenant'] }); await qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: err,
  });
  const send = useMutation({
    mutationFn: () => api<Invitation>('/invitations', { method: 'POST', body: invite }),
    onSuccess: async () => { toast('success', `Convite enviado para ${invite.email}.`); setInvite((i) => ({ ...i, email: '' })); await qc.invalidateQueries({ queryKey: ['invitations'] }); },
    onError: err,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/invitations/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }), onError: err });
  const usage = tenant.data;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Equipe e convites</h2>
      {usage?.plan.maxAgents && <p className="text-sm text-muted">Agentes em uso: <strong>{usage.usage.agents}</strong> de {usage.plan.maxAgents} no plano {usage.plan.name}.</p>}
      <Card className="p-4 sm:p-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
          <label className="min-w-56 flex-1 space-y-1 text-sm"><span className="font-medium">E-mail</span><Input type="email" required value={invite.email} onChange={(e) => setInvite((i) => ({ ...i, email: e.target.value }))} /></label>
          <label className="space-y-1 text-sm"><span className="font-medium">Papel</span>
            <Select value={invite.role} onChange={(e) => setInvite((i) => ({ ...i, role: e.target.value as MemberRole }))}><option value="agent">Agente</option><option value="admin">Administrador</option><option value="requester">Cliente</option></Select>
          </label>
          <Button type="submit" loading={send.isPending}><UserPlus className="h-4 w-4" aria-hidden />Convidar</Button>
        </form>
      </Card>
      {invites.data && invites.data.length > 0 && (
        <Card className="p-4 sm:p-4">
          <h3 className="mb-2 text-sm font-medium">Convites pendentes</h3>
          <ul className="space-y-1 text-sm">
            {invites.data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span className="flex-1">{i.email} <span className="text-muted">· {i.role === 'admin' ? 'administrador' : i.role === 'agent' ? 'agente' : 'cliente'} · expira {formatDateTime(i.expiresAt)}</span></span>
                <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: 'Revogar convite?', message: `O link enviado para ${i.email} deixará de funcionar.`, confirmLabel: 'Revogar', danger: true })) revoke.mutate(i.id); }}>Revogar</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {members.isPending ? <LoadingList rows={3} /> : members.isError ? <Alert kind="error">{members.error.message}</Alert> : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase text-muted"><tr><th className="p-3">Nome</th><th className="p-3">Papel</th><th className="p-3">Ativo</th></tr></thead>
            <tbody className="divide-y divide-border">
              {members.data.map((m) => (
                <tr key={m.userId}>
                  <td className="p-3"><div className="font-medium">{m.name}{m.userId === me?.user.id && ' (você)'}</div><div className="text-xs text-muted">{m.email}</div></td>
                  <td className="p-3">
                    <Select aria-label={`Papel de ${m.name}`} className="h-8 w-40" value={m.role} onChange={(e) => update.mutate({ userId: m.userId, patch: { role: e.target.value } })}>
                      <option value="admin">Administrador</option><option value="agent">Agente</option><option value="requester">Cliente</option>
                    </Select>
                  </td>
                  <td className="p-3">
                    <input type="checkbox" aria-label={`${m.name} ativo`} checked={m.active} onChange={async (e) => {
                      const active = e.target.checked;
                      if (!active && !(await confirm({ title: `Desativar ${m.name}?`, message: 'A pessoa perde o acesso imediatamente.', confirmLabel: 'Desativar', danger: true }))) return;
                      update.mutate({ userId: m.userId, patch: { active } });
                    }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BH { id: string; name: string; timezone: string; slots: Array<{ weekday: number; startTime: string; endTime: string }>; holidays: Array<{ date: string; name: string | null }> }
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export function BusinessHoursSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['catalog', 'business-hours'], queryFn: () => api<BH[]>('/catalog/business-hours') });
  const [selected, setSelected] = useState<string | null>(null);
  const bh = list.data?.find((b) => b.id === selected) ?? list.data?.[0];
  const [slots, setSlots] = useState<BH['slots'] | null>(null);
  const [holiday, setHoliday] = useState({ date: '', name: '' });
  const current = slots ?? bh?.slots ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['catalog', 'business-hours'] });
  const err = (e: unknown) => toast('error', e instanceof ApiError ? `${e.message}${e.fieldErrors[0] ? ` (${e.fieldErrors[0].message})` : ''}` : 'Não foi possível salvar.');
  const saveSlots = useMutation({ mutationFn: () => api(`/catalog/business-hours/${bh!.id}/slots`, { method: 'PUT', body: { slots: current } }), onSuccess: async () => { toast('success', 'Horários salvos.'); setSlots(null); await refresh(); }, onError: err });
  const addHoliday = useMutation({ mutationFn: () => api(`/catalog/business-hours/${bh!.id}/holidays`, { method: 'POST', body: { date: holiday.date, name: holiday.name || undefined } }), onSuccess: async () => { setHoliday({ date: '', name: '' }); await refresh(); }, onError: err });
  const delHoliday = useMutation({ mutationFn: (d: string) => api(`/catalog/business-hours/${bh!.id}/holidays/${d}`, { method: 'DELETE' }), onSuccess: refresh, onError: err });

  if (list.isPending) return <LoadingList rows={3} />;
  if (list.isError) return <Alert kind="error">{list.error.message}</Alert>;
  if (!bh) return <Alert>Nenhum horário comercial cadastrado.</Alert>;
  const edit = (i: number, k: 'weekday' | 'startTime' | 'endTime', v: string) => setSlots(current.map((s, j) => (j === i ? { ...s, [k]: k === 'weekday' ? Number(v) : v } : s)));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Horário comercial</h2>
      {list.data.length > 1 && (
        <Select aria-label="Horário comercial" className="w-64" value={bh.id} onChange={(e) => { setSelected(e.target.value); setSlots(null); }}>
          {list.data.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      )}
      <Card className="space-y-3 p-4 sm:p-4">
        <h3 className="text-sm font-medium">{bh.name} <span className="font-normal text-muted">· fuso {bh.timezone}</span></h3>
        <ul className="space-y-2">
          {current.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <Select aria-label="Dia da semana" className="h-8 w-36" value={s.weekday} onChange={(e) => edit(i, 'weekday', e.target.value)}>{DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}</Select>
              <Input aria-label="Início" type="time" className="h-8 w-28" value={s.startTime} onChange={(e) => edit(i, 'startTime', e.target.value)} />
              <span>às</span>
              <Input aria-label="Fim" type="time" className="h-8 w-28" value={s.endTime} onChange={(e) => edit(i, 'endTime', e.target.value)} />
              <Button size="icon" variant="ghost" aria-label="Remover faixa" onClick={() => setSlots(current.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setSlots([...current, { weekday: 1, startTime: '08:00', endTime: '12:00' }])}><Plus className="h-4 w-4" aria-hidden />Faixa</Button>
          <Button size="sm" loading={saveSlots.isPending} disabled={!slots} onClick={() => saveSlots.mutate()}>Salvar horários</Button>
        </div>
      </Card>
      <Card className="space-y-3 p-4 sm:p-4">
        <h3 className="text-sm font-medium">Feriados</h3>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); addHoliday.mutate(); }}>
          <Field label="Data"><Input type="date" required value={holiday.date} onChange={(e) => setHoliday((h) => ({ ...h, date: e.target.value }))} /></Field>
          <Field label="Nome"><Input value={holiday.name} onChange={(e) => setHoliday((h) => ({ ...h, name: e.target.value }))} /></Field>
          <Button type="submit" size="sm" loading={addHoliday.isPending}>Adicionar</Button>
        </form>
        <ul className="space-y-1 text-sm">
          {bh.holidays.map((h) => (
            <li key={h.date} className="flex items-center gap-2">
              <span className="flex-1">{h.date.split('-').reverse().join('/')} {h.name && <span className="text-muted">· {h.name}</span>}</span>
              <Button size="icon" variant="ghost" aria-label={`Remover feriado ${h.date}`} onClick={() => delHoliday.mutate(h.date)}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
          {bh.holidays.length === 0 && <li className="text-muted">Nenhum feriado cadastrado.</li>}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Cond = { field: string; op: 'eq' | 'in' | 'contains'; value: string };
type Act = { type: string; ref: string };
interface Rule { id: string; name: string; event: string; conditions: Array<{ field: string; op: Cond['op']; value: string | string[] }>; actions: Array<Record<string, string>>; active: boolean; position: number }
const EVENTS = [['ticket_created', 'Chamado criado'], ['ticket_updated', 'Chamado alterado'], ['sla_warning', 'SLA perto de vencer'], ['sla_breached', 'SLA estourado']] as const;
const ACTIONS = [['assign_queue', 'Mover para a fila'], ['assign_agent', 'Atribuir ao agente'], ['set_priority', 'Definir prioridade'], ['add_tag', 'Adicionar tag'], ['notify_staff', 'Avisar a equipe por e-mail']] as const;
const REF_KEY: Record<string, string> = { assign_queue: 'queueId', assign_agent: 'userId', set_priority: 'priorityId', add_tag: 'value' };

export function AutomationsSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantInfo>('/tenant') });
  const rules = useQuery({ queryKey: ['catalog', 'automation-rules'], queryFn: () => api<Rule[]>('/catalog/automation-rules') });
  const queues = useQueues();
  const agents = useAgents();
  const priorities = usePriorities();
  const statuses = useStatuses();
  const [draft, setDraft] = useState<{ name: string; event: string; conds: Cond[]; acts: Act[] }>({ name: '', event: 'ticket_created', conds: [{ field: 'priority.name', op: 'eq', value: '' }], acts: [{ type: 'add_tag', ref: '' }] });
  const err = (e: unknown) => toast('error', e instanceof ApiError ? `${e.message}${e.fieldErrors.length ? ' ' + e.fieldErrors.map((f) => `${f.field}: ${f.message}`).join('; ') : ''}` : 'Não foi possível salvar.');
  const create = useMutation({
    mutationFn: () => api('/catalog/automation-rules', {
      method: 'POST',
      body: {
        name: draft.name, event: draft.event,
        conditions: draft.conds.filter((c) => c.value.trim()).map((c) => ({ field: c.field, op: c.op, value: c.op === 'in' ? c.value.split(',').map((v) => v.trim()).filter(Boolean) : c.value.trim() })),
        actions: draft.acts.map((a) => (a.type === 'notify_staff' ? { type: a.type } : { type: a.type, [REF_KEY[a.type]!]: a.ref })),
      },
    }),
    onSuccess: async () => { toast('success', 'Regra criada.'); setDraft({ name: '', event: 'ticket_created', conds: [{ field: 'priority.name', op: 'eq', value: '' }], acts: [{ type: 'add_tag', ref: '' }] }); await qc.invalidateQueries({ queryKey: ['catalog', 'automation-rules'] }); },
    onError: err,
  });
  const toggle = useMutation({ mutationFn: (r: Rule) => api(`/catalog/automation-rules/${r.id}`, { method: 'PATCH', body: { active: !r.active } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog', 'automation-rules'] }), onError: err });
  const remove = useMutation({ mutationFn: (id: string) => api(`/catalog/automation-rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog', 'automation-rules'] }), onError: err });

  const refOptions = (type: string): Array<{ value: string; label: string }> | null =>
    type === 'assign_queue' ? (queues.data ?? []).map((q) => ({ value: q.id, label: q.name }))
      : type === 'assign_agent' ? (agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))
        : type === 'set_priority' ? (priorities.data ?? []).map((p) => ({ value: p.id, label: p.name })) : null;
  const describeAction = (a: Record<string, string>) => {
    const label = ACTIONS.find(([k]) => k === a['type'])?.[1] ?? a['type'];
    const ref = a['queueId'] ?? a['userId'] ?? a['priorityId'] ?? a['value'];
    const name = ref && [...(queues.data ?? []), ...(agents.data ?? []), ...(priorities.data ?? [])].find((x) => x.id === ref)?.name;
    return ref ? `${label}: ${name ?? ref}` : label;
  };
  const setCond = (i: number, p: Partial<Cond>) => setDraft((d) => ({ ...d, conds: d.conds.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  const setAct = (i: number, p: Partial<Act>) => setDraft((d) => ({ ...d, acts: d.acts.map((a, j) => (j === i ? { ...a, ...p } : a)) }));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Automações</h2>
      {tenant.data && !tenant.data.plan.features['automations'] && <Alert>O plano {tenant.data.plan.name} não executa automações. As regras ficam salvas e passam a valer ao fazer upgrade para o Pro.</Alert>}
      <Card className="space-y-3 p-4 sm:p-4">
        <h3 className="text-sm font-medium">Nova regra</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Nome"><Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} /></Field>
          <Field label="Quando"><Select value={draft.event} onChange={(e) => setDraft((d) => ({ ...d, event: e.target.value }))}>{EVENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted">Se (todas as condições)</legend>
          {draft.conds.map((c, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Select aria-label="Campo" className="h-8 w-44" value={c.field} onChange={(e) => setCond(i, { field: e.target.value })}>{AUTOMATION_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}</Select>
              <Select aria-label="Operador" className="h-8 w-32" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Cond['op'] })}><option value="eq">é igual a</option><option value="in">é um de</option><option value="contains">contém</option></Select>
              <Input aria-label="Valor" className="h-8 min-w-40 flex-1" placeholder={c.op === 'in' ? 'valores separados por vírgula' : c.field === 'status.kind' ? statuses.data?.map((s) => s.kind).join(', ') : 'valor'} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />
              <Button size="icon" variant="ghost" aria-label="Remover condição" onClick={() => setDraft((d) => ({ ...d, conds: d.conds.filter((_, j) => j !== i) }))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setDraft((d) => ({ ...d, conds: [...d.conds, { field: 'subject', op: 'contains', value: '' }] }))}><Plus className="h-4 w-4" aria-hidden />Condição</Button>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted">Então</legend>
          {draft.acts.map((a, i) => {
            const opts = refOptions(a.type);
            return (
              <div key={i} className="flex flex-wrap gap-2">
                <Select aria-label="Ação" className="h-8 w-56" value={a.type} onChange={(e) => setAct(i, { type: e.target.value, ref: '' })}>{ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                {opts ? (
                  <Select aria-label="Alvo da ação" className="h-8 min-w-40 flex-1" value={a.ref} onChange={(e) => setAct(i, { ref: e.target.value })}><option value="">Escolha…</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                ) : a.type === 'add_tag' ? (
                  <Input aria-label="Tag" className="h-8 min-w-40 flex-1" value={a.ref} onChange={(e) => setAct(i, { ref: e.target.value })} placeholder="tag" />
                ) : null}
                <Button size="icon" variant="ghost" aria-label="Remover ação" onClick={() => setDraft((d) => ({ ...d, acts: d.acts.filter((_, j) => j !== i) }))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            );
          })}
          <Button size="sm" variant="ghost" onClick={() => setDraft((d) => ({ ...d, acts: [...d.acts, { type: 'notify_staff', ref: '' }] }))}><Plus className="h-4 w-4" aria-hidden />Ação</Button>
        </fieldset>
        <div className="flex justify-end"><Button loading={create.isPending} disabled={!draft.name.trim() || draft.acts.length === 0} onClick={() => create.mutate()}>Criar regra</Button></div>
      </Card>
      {rules.isPending ? <LoadingList rows={2} /> : rules.isError ? <Alert kind="error">{rules.error.message}</Alert> : (
        <ul className="space-y-2">
          {rules.data.map((r) => (
            <li key={r.id} className={cn('rounded-lg border border-border p-3 text-sm', !r.active && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1 font-medium">{r.name}</span>
                <Badge className="bg-surface text-muted">{EVENTS.find(([k]) => k === r.event)?.[1]}</Badge>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.active} onChange={() => toggle.mutate(r)} />Ativa</label>
                <Button size="icon" variant="ghost" aria-label={`Remover regra ${r.name}`} onClick={async () => { if (await confirm({ title: 'Remover regra?', message: r.name, confirmLabel: 'Remover', danger: true })) remove.mutate(r.id); }}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <p className="mt-1 text-xs text-muted">
                Se {r.conditions.length ? r.conditions.map((c) => `${c.field} ${c.op === 'eq' ? '=' : c.op === 'in' ? 'em' : 'contém'} ${Array.isArray(c.value) ? c.value.join(', ') : c.value}`).join(' e ') : 'sempre'} → {r.actions.map(describeAction).join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PlanSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { reloadMe } = useAuth();
  const t = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantInfo>('/tenant') });
  const [form, setForm] = useState<{ name: string; timezone: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api<TenantInfo>('/tenant', { method: 'PATCH', body: form }),
    onSuccess: async () => { toast('success', 'Workspace atualizado.'); setForm(null); await qc.invalidateQueries({ queryKey: ['tenant'] }); await reloadMe(); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Não foi possível salvar.'),
  });
  if (t.isPending) return <LoadingList rows={2} />;
  if (t.isError) return <Alert kind="error">{t.error.message}</Alert>;
  const d = t.data;
  const f = form ?? { name: d.name, timezone: d.timezone };
  const meter = (used: number, max: number | null) => {
    const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-sm"><span className="tabular-nums">{used}{max ? ` de ${max}` : ''}</span><span className="text-muted">{max ? `${pct}%` : 'ilimitado'}</span></div>
        {max && <div className="h-2 rounded-full bg-primary/15" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used}><div className={cn('h-2 rounded-full', pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>}
      </div>
    );
  };
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Plano e uso</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4 sm:p-4">
          <p className="text-sm text-muted">Plano atual</p>
          <p className="text-xl font-semibold">{d.plan.name} <span className="text-sm font-normal text-muted">· R$ {(d.plan.priceCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}/mês</span></p>
          <p className="text-sm">Situação: <strong>{({ trial: 'Período de teste', active: 'Ativa', past_due: 'Pagamento pendente', suspended: 'Suspensa', canceled: 'Cancelada' } as Record<string, string>)[d.status]}</strong>{d.status === 'trial' && d.trialEndsAt ? ` até ${formatDateTime(d.trialEndsAt)}` : ''}</p>
          <p className="text-xs text-muted">A contratação e a troca de plano chegam na próxima etapa (cobrança).</p>
        </Card>
        <Card className="space-y-3 p-4 sm:p-4">
          <div><p className="mb-1 text-sm font-medium">Agentes</p>{meter(d.usage.agents, d.plan.maxAgents)}</div>
          <div><p className="mb-1 text-sm font-medium">Chamados neste mês</p>{meter(d.usage.ticketsThisMonth, d.plan.maxTicketsPerMonth)}</div>
        </Card>
      </div>
      <Card className="p-4 sm:p-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Nome do workspace" className="min-w-56 flex-1"><Input value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} /></Field>
          <Field label="Fuso horário"><Input value={f.timezone} onChange={(e) => setForm({ ...f, timezone: e.target.value })} /></Field>
          <Button type="submit" loading={save.isPending} disabled={!form}>Salvar</Button>
        </form>
      </Card>
    </div>
  );
}
