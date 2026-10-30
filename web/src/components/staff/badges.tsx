import { AlertTriangle, CheckCircle2, Clock, PauseCircle } from 'lucide-react';
import type { SlaTimer, TicketSla } from '@helpdesk/shared';
import { cn } from '@/lib/utils';

function remaining(min: number): string {
  const a = Math.abs(min);
  if (a < 60) return `${a} min`;
  if (a < 60 * 24) return `${Math.floor(a / 60)} h ${a % 60 ? `${a % 60} min` : ''}`.trim();
  return `${Math.floor(a / 1440)} d ${Math.floor((a % 1440) / 60)} h`;
}

/** Selo de SLA: cor + ícone + texto (nunca só cor). Verde > 2 h, amarelo ≤ 2 h, vermelho estourado. */
export function SlaBadge({ sla, compact }: { sla: TicketSla | null; compact?: boolean }) {
  if (!sla) return <span className="text-xs text-muted">—</span>;
  // o mais urgente: estourado > o que vence primeiro > pausado
  const timers = [sla.firstResponse, sla.resolution].filter((t): t is SlaTimer => !!t);
  const running = timers.filter((t) => t.state === 'running').sort((a, b) => (a.minutesRemaining ?? 0) - (b.minutesRemaining ?? 0));
  const timer = timers.find((t) => t.state === 'breached') ?? running[0] ?? timers.find((t) => t.state === 'paused') ?? null;
  return <TimerBadge timer={timer} fallback={sla.state} compact={compact} />;
}

export function TimerBadge({ timer, fallback, compact }: { timer: SlaTimer | null; fallback?: TicketSla['state']; compact?: boolean }) {
  const state = timer?.state ?? fallback ?? 'met';
  const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
  if (state === 'breached') {
    return <span className={cn(base, 'bg-danger/15 text-danger')}><AlertTriangle className="h-3 w-3" aria-hidden />{compact ? 'Estourado' : `Estourado${timer?.minutesRemaining != null ? ` há ${remaining(timer.minutesRemaining)}` : ''}`}</span>;
  }
  if (state === 'paused') return <span className={cn(base, 'bg-border text-muted')}><PauseCircle className="h-3 w-3" aria-hidden />Pausado</span>;
  if (state === 'running' && timer?.minutesRemaining != null) {
    const warn = timer.minutesRemaining <= 120;
    return <span className={cn(base, warn ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success')}><Clock className="h-3 w-3" aria-hidden />{remaining(timer.minutesRemaining)}</span>;
  }
  return <span className={cn(base, 'bg-success/10 text-success')}><CheckCircle2 className="h-3 w-3" aria-hidden />{state === 'met_late' ? 'Cumprido c/ atraso' : 'Cumprido'}</span>;
}

export function PriorityDot({ color, name }: { color: string; name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {name}
    </span>
  );
}
