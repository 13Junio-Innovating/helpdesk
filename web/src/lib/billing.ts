import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface PublicPlan { id: string; name: string; priceCents: number; maxAgents: number | null; maxTicketsPerMonth: number | null; features: Record<string, boolean> }
export interface PlansResponse { provider: 'fake' | 'asaas'; requiresDocument: boolean; plans: PublicPlan[] }

export const usePlans = () => useQuery({ queryKey: ['billing', 'plans'], queryFn: () => api<PlansResponse>('/billing/plans', { auth: false }), staleTime: 10 * 60_000 });
export const price = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const FEATURE: Record<string, string> = { kb: 'Base de conhecimento', sla: 'SLA com horário comercial', automations: 'Automações', api: 'Acesso à API' };
export const limits = (p: PublicPlan) => [
  p.maxAgents ? `Até ${p.maxAgents} agentes` : 'Agentes ilimitados',
  p.maxTicketsPerMonth ? `${p.maxTicketsPerMonth.toLocaleString('pt-BR')} chamados/mês` : 'Chamados ilimitados',
];
