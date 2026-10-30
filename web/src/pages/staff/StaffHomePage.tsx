import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Construction } from 'lucide-react';
import type { Paginated, TicketListItem } from '@helpdesk/shared';
import { useAuth } from '@/auth/AuthProvider';
import { api } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import { Alert, Badge, Card, LoadingList } from '@/components/ui/misc';

/** Provisório até a fase 6 (painel completo): mostra que o login da equipe funciona e os chamados recentes. */
export function StaffHomePage() {
  useDocumentTitle('Painel');
  const { me } = useAuth();
  const q = useQuery({
    queryKey: ['tickets', 'staff-home'],
    queryFn: () => api<Paginated<TicketListItem>>('/tickets', { query: { limit: 10, sort: 'updated' } }),
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Olá, {me?.user.name.split(' ')[0]}</h1>
      <Alert>
        <span className="inline-flex items-center gap-2">
          <Construction className="h-4 w-4" aria-hidden /> O painel completo da equipe (filtros, detalhe, dashboard, configurações) chega na próxima etapa.
        </span>
      </Alert>
      <Card>
        <h2 className="mb-3 font-medium">Chamados atualizados recentemente</h2>
        {q.isPending ? (
          <LoadingList rows={3} />
        ) : q.isError ? (
          <Alert kind="error">{q.error.message}</Alert>
        ) : (
          <ul className="divide-y divide-border">
            {q.data.items.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="text-muted">#{t.number}</span>
                <Link to={`/chamados/${t.id}`} className="flex-1 font-medium hover:underline">
                  {t.subject}
                </Link>
                <Badge color={t.priority.color}>{t.priority.name}</Badge>
                <Badge color={t.status.color}>{t.status.name}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
