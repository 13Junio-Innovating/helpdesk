import type { AutomationAction, AutomationCondition } from '../catalog/automation-rules.js';

/** Fatos do chamado usados nas condições (mesmos nomes de CONDITION_FIELDS). */
export type TicketFacts = Record<string, string | string[] | null>;

const norm = (v: string) => v.trim().toLowerCase();

export function conditionMatches(c: AutomationCondition, facts: TicketFacts): boolean {
  const value = facts[c.field];
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    // tags: eq/contains = a lista contém; in = a lista tem algum dos itens
    const set = new Set(value.map(norm));
    if (c.op === 'in') return c.value.some((v) => set.has(norm(v)));
    return set.has(norm(c.value));
  }
  const v = norm(value);
  switch (c.op) {
    case 'eq': return v === norm(c.value);
    case 'contains': return v.includes(norm(c.value));
    case 'in': return c.value.some((x) => norm(x) === v);
  }
}

/** Todas as condições precisam valer (E). Lista vazia = sempre. */
export function ruleMatches(conditions: AutomationCondition[], facts: TicketFacts): boolean {
  return conditions.every((c) => conditionMatches(c, facts));
}

export interface PlannedChanges {
  queue_id?: string;
  assignee_id?: string;
  priority_id?: string;
  addTags: string[];
  notify: boolean;
}

/** Junta as ações das regras que bateram (em ordem; para o mesmo campo, a última vence). */
export function planActions(actions: AutomationAction[], into: PlannedChanges): PlannedChanges {
  for (const a of actions) {
    switch (a.type) {
      case 'assign_queue': into.queue_id = a.queue_id; break;
      case 'assign_agent': into.assignee_id = a.user_id; break;
      case 'set_priority': into.priority_id = a.priority_id; break;
      case 'add_tag': if (!into.addTags.includes(a.value)) into.addTags.push(a.value); break;
      case 'notify_staff': into.notify = true; break;
    }
  }
  return into;
}
