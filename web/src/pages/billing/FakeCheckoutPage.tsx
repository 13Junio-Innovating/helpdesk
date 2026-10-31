import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { FlaskConical } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { AuthLayout } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';

/** Checkout do provedor de TESTE (desenvolvimento): simula o que o Asaas faria e dispara o webhook assinado. */
export function FakeCheckoutPage() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const plan = params.get('plano') ?? '';
  const { reloadMe } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (outcome: 'paid' | 'overdue' | 'canceled') => {
    setBusy(outcome);
    setError(null);
    try {
      await api('/billing/fake/simulate', { method: 'POST', body: { session, outcome } });
      await reloadMe();
      await qc.invalidateQueries({ queryKey: ['tenant'] });
      toast('success', outcome === 'paid' ? `Pagamento aprovado: plano ${plan} ativo.` : 'Evento de cobrança aplicado.');
      navigate('/configuracoes/plano');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha na simulação.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthLayout title="Pagamento (ambiente de teste)" subtitle={`Plano ${plan}`}>
      <div className="space-y-4">
        <Alert><span className="inline-flex items-center gap-1"><FlaskConical className="h-4 w-4" aria-hidden />Provedor de testes: nenhuma cobrança real é feita. Em produção esta etapa acontece na página do Asaas.</span></Alert>
        {error && <Alert kind="error">{error}</Alert>}
        <Button className="w-full" loading={busy === 'paid'} disabled={!session} onClick={() => void run('paid')}>Simular pagamento aprovado</Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" loading={busy === 'overdue'} disabled={!session} onClick={() => void run('overdue')}>Simular atraso</Button>
          <Button variant="secondary" loading={busy === 'canceled'} disabled={!session} onClick={() => void run('canceled')}>Simular cancelamento</Button>
        </div>
        <Button variant="ghost" className="w-full" onClick={() => navigate('/configuracoes/plano')}>Voltar sem pagar</Button>
      </div>
    </AuthLayout>
  );
}
