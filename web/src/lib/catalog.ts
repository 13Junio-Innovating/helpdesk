import { useQuery } from '@tanstack/react-query';
import type { MemberRole, StatusKind } from '@helpdesk/shared';
import { api } from './api';

export interface StatusItem { id: string; name: string; kind: StatusKind; slaPauses: boolean; isDefault: boolean; position: number; color: string }
export interface PriorityItem { id: string; name: string; level: number; color: string; isDefault: boolean }
export interface CategoryItem { id: string; name: string; parentId: string | null; defaultQueueId: string | null; active: boolean }
export interface QueueItem { id: string; name: string; description: string | null }
export interface AgentItem { id: string; name: string; email: string; role: MemberRole }
export interface MacroItem { id: string; title: string; body: string }

const long = { staleTime: 5 * 60_000 };
export const useStatuses = () => useQuery({ queryKey: ['catalog', 'statuses'], queryFn: () => api<StatusItem[]>('/catalog/statuses'), ...long });
export const usePriorities = () => useQuery({ queryKey: ['catalog', 'priorities'], queryFn: () => api<PriorityItem[]>('/catalog/priorities'), ...long });
export const useCategories = () => useQuery({ queryKey: ['catalog', 'categories'], queryFn: () => api<CategoryItem[]>('/catalog/categories'), ...long });
export const useQueues = () => useQuery({ queryKey: ['catalog', 'queues'], queryFn: () => api<QueueItem[]>('/catalog/queues'), ...long });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: () => api<AgentItem[]>('/agents'), ...long });
export const useMacros = () => useQuery({ queryKey: ['catalog', 'macros'], queryFn: () => api<MacroItem[]>('/catalog/macros'), ...long });

/** id → nome, para traduzir ids dos eventos de auditoria. */
export function nameMap(...lists: Array<Array<{ id: string; name: string }> | undefined>): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lists) l?.forEach((x) => m.set(x.id, x.name));
  return m;
}
