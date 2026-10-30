import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import type { ReportsOverview } from '@helpdesk/shared';
import { api } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import { Alert, Card, Skeleton } from '@/components/ui/misc';
import { BarList, LineChart, StatTile } from '@/components/staff/charts';

const dur = (m: number | null) => (m === null ? '—' : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(1).replace('.', ',')} h` : `${(m / 1440).toFixed(1).replace('.', ',')} d`);
const hours = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const q = useQuery({ queryKey: ['reports', 'overview'], queryFn: () => api<ReportsOverview>('/reports/overview'), refetchInterval: 60_000 });

  if (q.isPending) {
    return (
      <div role="status" aria-label="Carregando dashboard" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError) return <Alert kind="error">{q.error.message}</Alert>;
  const r = q.data;
  const open = r.openByStatus.reduce((a, s) => a + s.count, 0);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Chamados abertos" value={String(open)} hint="agora" />
        <StatTile label="SLA vencido" value={String(r.overdue)} hint="agora" tone={r.overdue ? 'danger' : undefined} />
        <StatTile label="1ª resposta (média)" value={dur(r.avgFirstResponseMinutes)} hint={`últimos ${r.periodDays} dias`} />
        <StatTile label="Resolução (média)" value={dur(r.avgResolutionMinutes)} hint={`últimos ${r.periodDays} dias`} />
        <StatTile label="SLA cumprido" value={r.slaCompliancePct === null ? '—' : `${r.slaCompliancePct.toLocaleString('pt-BR')}%`} hint={`últimos ${r.periodDays} dias`} />
        <StatTile label="Horas apontadas" value={hours(r.minutesTracked)} hint={`últimos ${r.periodDays} dias`} />
      </div>
      {r.overdue > 0 && (
        <Alert kind="error"><span className="inline-flex items-center gap-1"><AlertTriangle className="h-4 w-4" aria-hidden />{r.overdue} chamado(s) com SLA vencido. <Link to="/chamados?visao=sla-vencido&sla=breached" className="underline">Ver lista</Link></span></Alert>
      )}
      <Card>
        <LineChart
          title={`Chamados por dia (últimos ${r.periodDays} dias)`}
          labels={r.ticketsPerDay.map((d) => d.date)}
          series={[
            { name: 'Abertos', color: 'var(--color-series-1)', values: r.ticketsPerDay.map((d) => d.created) },
            { name: 'Resolvidos', color: 'var(--color-series-2)', values: r.ticketsPerDay.map((d) => d.resolved) },
          ]}
        />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><BarList title="Abertos por status" items={r.openByStatus.map((s) => ({ label: s.name, value: s.count }))} /></Card>
        <Card><BarList title={`Por categoria (últimos ${r.periodDays} dias)`} items={r.byCategory.map((c) => ({ label: c.name, value: c.count }))} /></Card>
      </div>
      <Card>
        <h2 className="mb-2 text-sm font-medium">Por agente</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="py-2">Agente</th><th className="py-2 text-right">Abertos</th><th className="py-2 text-right">Resolvidos ({r.periodDays}d)</th><th className="py-2 text-right">Horas ({r.periodDays}d)</th></tr></thead>
            <tbody>
              {r.byAgent.map((a) => (
                <tr key={a.userId} className="border-t border-border">
                  <td className="py-2">{a.name}</td>
                  <td className="py-2 text-right tabular-nums">{a.open}</td>
                  <td className="py-2 text-right tabular-nums">{a.resolved}</td>
                  <td className="py-2 text-right tabular-nums">{hours(a.minutesTracked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
