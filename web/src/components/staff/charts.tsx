import { useId, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/**
 * Gráficos em SVG puro (sem biblioteca): marcas finas, grade discreta, legenda para 2+ séries,
 * rótulos só nas pontas, tooltip com crosshair e alternativa em tabela.
 * Cores: tokens --color-series-1/2 (paleta validada para daltonismo/contraste nos dois temas).
 */

export interface Series {
  name: string;
  color: string; // var(--color-series-n)
  values: number[];
}

const W = 640;
const H = 220;
const PAD = { top: 16, right: 96, bottom: 28, left: 32 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / pow) * pow;
}

export function LineChart({ title, labels, series }: { title: string; labels: string[]; series: Series[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const day = (iso: string) => format(parseISO(iso), 'dd/MM', { locale: ptBR });
  const last = labels.length - 1;
  // rótulos finais não se sobrepõem: afasta (mín. 14px) os que caem no mesmo valor
  const labelY = (() => {
    const order = series.map((s, i) => ({ i, y: y(s.values[last] ?? 0) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < order.length; k++) order[k]!.y = Math.max(order[k]!.y, order[k - 1]!.y + 14);
    const out: number[] = [];
    order.forEach((o) => (out[o.i] = o.y));
    return out;
  })();

  return (
    <figure className="space-y-2" aria-labelledby={`${id}-t`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={`${id}-t`} className="text-sm font-medium">{title}</figcaption>
        <div className="flex items-center gap-3 text-xs">
          {series.length > 1 && series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden />{s.name}
            </span>
          ))}
          <button className="text-primary underline" onClick={() => setTable((v) => !v)}>{table ? 'Ver gráfico' : 'Ver como tabela'}</button>
        </div>
      </div>

      {table ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="py-1">Dia</th>{series.map((s) => <th key={s.name} className="py-1 text-right">{s.name}</th>)}</tr></thead>
            <tbody>{labels.map((l, i) => <tr key={l} className="border-t border-border"><td className="py-1">{day(l)}</td>{series.map((s) => <td key={s.name} className="py-1 text-right tabular-nums">{s.values[i]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. ${series.map((s) => `${s.name}: total ${s.values.reduce((a, b) => a + b, 0)}`).join('; ')}.`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-muted)">{t}</text>
              </g>
            ))}
            {labels.map((l, i) => ((i % 7 === 0 && last - i >= 4) || i === last) && (
              <text key={l} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-muted)">{day(l)}</text>
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--color-muted)" strokeWidth={1} />}
            {series.map((s, si) => (
              <g key={s.name}>
                <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
                {/* ponto final + rótulo direto (só na ponta) */}
                <circle cx={x(last)} cy={y(s.values[last] ?? 0)} r={4} fill={s.color} stroke="var(--color-bg)" strokeWidth={2} />
                <text x={x(last) + 8} y={labelY[si]} dy="0.32em" fontSize={11} fill="var(--color-fg)">{s.name} {s.values[last]}</text>
                {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="var(--color-bg)" strokeWidth={2} />}
              </g>
            ))}
            {/* áreas de hover maiores que as marcas */}
            {labels.map((l, i) => (
              <rect key={l} x={x(i) - iw / labels.length / 2} y={PAD.top} width={iw / labels.length} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
            ))}
          </svg>
          {hover !== null && (
            <div role="status" className="pointer-events-none absolute top-0 rounded-md border border-border bg-bg px-2 py-1 text-xs shadow" style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > labels.length / 2 ? 'translateX(-105%)' : 'translateX(5%)' }}>
              <div className="font-medium">{day(labels[hover]!)}</div>
              {series.map((s) => (
                <div key={s.name} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />{s.name}: <span className="tabular-nums">{s.values[hover]}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Barras horizontais de uma série (título nomeia a série; sem legenda). */
export function BarList({ title, items, empty = 'Sem dados no período.' }: { title: string; items: Array<{ label: string; value: number }>; empty?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const id = useId();
  return (
    <figure aria-labelledby={id} className="space-y-2">
      <figcaption id={id} className="text-sm font-medium">{title}</figcaption>
      {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.label} className="grid grid-cols-[minmax(6rem,10rem)_1fr_2.5rem] items-center gap-2 text-sm" title={`${i.label}: ${i.value}`}>
              <span className="truncate">{i.label}</span>
              <span className="h-4" aria-hidden>
                <span className="block h-4 rounded-r" style={{ width: `${Math.max(i.value ? 2 : 0, (i.value / max) * 100)}%`, background: 'var(--color-series-1)' }} />
              </span>
              <span className="text-right tabular-nums">{i.value}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** Cartão de número (label · valor · contexto). */
export function StatTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
