import type { AutomationAction, AutomationCondition } from '@helpdesk/shared';

/** Estado do chamado no formato dos campos das condições (ver AUTOMATION_FIELDS). */
export type TicketSnapshot = Record<string, string | string[] | null>;

const norm = (v: string) => v.trim().toLowerCase();

function matches(c: AutomationCondition, snap: TicketSnapshot): boolean {
  const actual = snap[c.field];
  if (actual === null || actual === undefined) return false;
  const values = (Array.isArray(actual) ? actual : [actual]).map(norm);
  switch (c.op) {
    case 'eq':
      return typeof c.value === 'string' && values.includes(norm(c.value));
    case 'in':
      return Array.isArray(c.value) && c.value.some((v) => values.includes(norm(v)));
    case 'contains':
      // texto: contém o trecho; lista (tags): contém o item
      return typeof c.value === 'string' && (Array.isArray(actual) ? values.includes(norm(c.value)) : values[0]!.includes(norm(c.value)));
    default:
      return false;
  }
}

/** Todas as condições precisam valer (lista vazia = sempre). Condição malformada nunca casa. */
export function ruleMatches(conditions: unknown, snap: TicketSnapshot): boolean {
  if (!Array.isArray(conditions)) return false;
  return conditions.every((c) => typeof c === 'object' && c !== null && matches(c as AutomationCondition, snap));
}

export interface PlannedChanges {
  queueId?: string;
  assigneeId?: string;
  priorityId?: string;
  addTags: string[];
  notify: string[]; // nomes das regras que pediram notify_staff
}

/** Junta as ações das regras que casaram, em ordem: em conflito, a regra posterior vence. */
export function planActions(rules: Array<{ name: string; actions: unknown }>): PlannedChanges {
  const plan: PlannedChanges = { addTags: [], notify: [] };
  for (const rule of rules) {
    if (!Array.isArray(rule.actions)) continue;
    for (const a of rule.actions as AutomationAction[]) {
      switch (a?.type) {
        case 'assign_queue': plan.queueId = a.queueId; break;
        case 'assign_agent': plan.assigneeId = a.userId; break;
        case 'set_priority': plan.priorityId = a.priorityId; break;
        case 'add_tag': if (!plan.addTags.includes(a.value)) plan.addTags.push(a.value); break;
        case 'notify_staff': plan.notify.push(rule.name); break;
      }
    }
  }
  return plan;
}
