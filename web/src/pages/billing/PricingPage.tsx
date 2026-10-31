import { Link } from 'react-router';
import { Check, LifeBuoy, X } from 'lucide-react';
import { FEATURE, limits, price, usePlans } from '@/lib/billing';
import { useDocumentTitle } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Alert, Skeleton } from '@/components/ui/misc';

/** Página pública de preços (vitrine do produto). */
export function PricingPage() {
  useDocumentTitle('Planos e preços');
  const q = usePlans();
  return (
    <div className="min-h-dvh bg-surface">
      <header className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
        <span className="flex items-center gap-2 text-lg font-semibold"><LifeBuoy className="h-6 w-6 text-primary" aria-hidden />Helpdesk</span>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link to="/entrar" className="rounded-md px-3 py-1.5 text-sm hover:bg-border/50">Entrar</Link>
          <Link to="/cadastro" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg">Teste grátis</Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-16">
        <section className="py-10 text-center">
          <h1 className="text-3xl font-bold sm:text-4xl">Atendimento organizado, cliente satisfeito</h1>
          <p className="mx-auto mt-3 max-w-2xl text-muted">Chamados, SLA com horário comercial, portal do cliente, base de conhecimento e automações. Comece com 14 dias grátis, sem cartão.</p>
        </section>
        {q.isPending ? (
          <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-80" />)}</div>
        ) : q.isError ? (
          <Alert kind="error">Não foi possível carregar os planos agora.</Alert>
        ) : (
          <ul className="grid gap-4 md:grid-cols-3" aria-label="Planos">
            {q.data.plans.map((p) => {
              const featured = p.id === 'pro';
              return (
                <li key={p.id} className={cn('flex flex-col rounded-xl border bg-bg p-6', featured ? 'border-primary shadow-lg' : 'border-border')}>
                  {featured && <span className="mb-2 self-start rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Mais escolhido</span>}
                  <h2 className="text-xl font-semibold">{p.name}</h2>
                  <p className="mt-2"><span className="text-3xl font-bold">{price(p.priceCents)}</span><span className="text-sm text-muted">/mês</span></p>
                  <ul className="mt-4 flex-1 space-y-2 text-sm">
                    {limits(p).map((l) => <li key={l} className="flex gap-2"><Check className="h-4 w-4 text-success" aria-hidden />{l}</li>)}
                    {Object.entries(FEATURE).map(([k, label]) => (
                      <li key={k} className={cn('flex gap-2', !p.features[k] && 'text-muted')}>
                        {p.features[k] ? <Check className="h-4 w-4 text-success" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
                        <span>{label}<span className="sr-only">{p.features[k] ? ' (incluído)' : ' (não incluído)'}</span></span>
                      </li>
                    ))}
                  </ul>
                  <Link to="/cadastro" className={cn('mt-6 rounded-md px-4 py-2 text-center text-sm font-medium', featured ? 'bg-primary text-primary-fg' : 'border border-border hover:bg-surface')}>Começar teste grátis</Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-6 text-center text-xs text-muted">Valores mensais. Pagamento por Pix, boleto ou cartão. Cancele quando quiser.</p>
      </main>
    </div>
  );
}
