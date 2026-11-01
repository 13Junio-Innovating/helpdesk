import { z } from 'zod';
import type { DbClient } from '../common/db/db.service.js';
import { AppError } from '../common/errors/app-error.js';

/**
 * Formato das regras de automação (avaliadas pelo worker, fase 4).
 *
 * conditions: todas precisam ser verdadeiras (E lógico). Lista vazia = sempre.
 *   { "field": "<campo>", "op": "eq" | "in" | "contains", "value": string | string[] }
 *   - eq:       igualdade (texto sem diferenciar maiúsculas)
 *   - in:       value é uma lista; verdadeiro se o campo for igual a algum item
 *   - contains: texto contém value (sem diferenciar maiúsculas); para `tags`, a lista contém value
 *
 * actions (executadas em ordem):
 *   { "type": "assign_queue", "queue_id": uuid }   { "type": "assign_agent", "user_id": uuid }
 *   { "type": "set_priority", "priority_id": uuid } { "type": "add_tag", "value": "texto" }
 *   { "type": "notify_staff" }                      (e-mail para responsável ou, sem responsável, para a equipe)
 */
export const CONDITION_FIELDS = [
  'subject', 'description', 'channel', 'tags',
  'priority.id', 'priority.name', 'status.id', 'status.name', 'status.kind',
  'category.id', 'category.name', 'queue.id', 'queue.name',
  'requester.email', 'organization.id', 'organization.name',
] as const;

const text = z.string().min(1).max(200);
export const conditionSchema = z.discriminatedUnion('op', [
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('eq'), value: text }).strict(),
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('contains'), value: text }).strict(),
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('in'), value: z.array(text).min(1).max(50) }).strict(),
]);

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign_queue'), queue_id: z.uuid() }).strict(),
  z.object({ type: z.literal('assign_agent'), user_id: z.uuid() }).strict(),
  z.object({ type: z.literal('set_priority'), priority_id: z.uuid() }).strict(),
  z.object({ type: z.literal('add_tag'), value: z.string().trim().toLowerCase().min(1).max(40) }).strict(),
  z.object({ type: z.literal('notify_staff') }).strict(),
]);

export type AutomationCondition = z.infer<typeof conditionSchema>;
export type AutomationAction = z.infer<typeof actionSchema>;

/** Valida o formato e confere que as referências (fila, agente, prioridade) existem NESTE workspace. */
export async function validateRule(
  c: DbClient, conditions: unknown[] | undefined, actions: unknown[] | undefined,
): Promise<{ conditions?: AutomationCondition[]; actions?: AutomationAction[] }> {
  const parsed = {
    conditions: conditions === undefined ? undefined : z.array(conditionSchema).safeParse(conditions),
    actions: actions === undefined ? undefined : z.array(actionSchema).min(1, 'Informe ao menos uma ação.').safeParse(actions),
  };
  const issues = [parsed.conditions, parsed.actions].flatMap((r, i) =>
    r && !r.success ? r.error.issues.map((x) => `${i === 0 ? 'conditions' : 'actions'}.${x.path.join('.')}: ${x.message}`) : [],
  );
  if (issues.length) throw new AppError(400, 'validation_failed', 'Regra de automação inválida.', issues);

  const acts = parsed.actions?.success ? parsed.actions.data : undefined;
  for (const a of acts ?? []) {
    const check: [string, string, string] | null =
      a.type === 'assign_queue' ? ['SELECT 1 FROM queues WHERE id = $1', a.queue_id, 'Fila']
      : a.type === 'set_priority' ? ['SELECT 1 FROM priorities WHERE id = $1', a.priority_id, 'Prioridade']
      : a.type === 'assign_agent'
        ? ["SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('admin', 'agent') AND active", a.user_id, 'Agente']
        : null;
    if (!check) continue;
    const { rowCount } = await c.query(check[0], [check[1]]);
    if (!rowCount) throw new AppError(422, 'invalid_reference', `${check[2]} da ação "${a.type}" não existe neste workspace.`);
  }
  return {
    conditions: parsed.conditions?.success ? parsed.conditions.data : undefined,
    actions: acts,
  };
}
