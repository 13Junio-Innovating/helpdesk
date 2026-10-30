import { z } from 'zod';
import { AUTOMATION_FIELDS, AUTOMATION_OPS, type ValidationIssue } from '@helpdesk/shared';
import { AppException } from '../common/errors/app-exception.js';

/**
 * Formato das regras de automação (documentado no README, avaliado pelo worker na fase 4):
 *
 *   conditions: [{ "field": "priority.name", "op": "eq", "value": "Urgente" }]   — todas precisam valer (E)
 *     op: eq (igual, sem diferenciar maiúsculas) · in (valor está na lista) · contains (texto contém / tags contém)
 *   actions: [{ "type": "assign_queue", "queueId": "…" }, { "type": "assign_agent", "userId": "…" },
 *             { "type": "set_priority", "priorityId": "…" }, { "type": "add_tag", "value": "vip" },
 *             { "type": "notify_staff" }]
 */
const uuid = z.string().uuid();

const condition = z
  .object({
    field: z.enum(AUTOMATION_FIELDS),
    op: z.enum(AUTOMATION_OPS),
    value: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(50)]),
  })
  .strict()
  .refine((c) => (c.op === 'in') === Array.isArray(c.value), { message: 'use lista de valores com "in" e valor único com "eq"/"contains"' });

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign_queue'), queueId: uuid }).strict(),
  z.object({ type: z.literal('assign_agent'), userId: uuid }).strict(),
  z.object({ type: z.literal('set_priority'), priorityId: uuid }).strict(),
  z.object({ type: z.literal('add_tag'), value: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,49}$/u) }).strict(),
  z.object({ type: z.literal('notify_staff') }).strict(),
]);

export function validateAutomation(input: { conditions?: unknown[]; actions?: unknown[] }): void {
  const issues: ValidationIssue[] = [];
  const check = (key: 'conditions' | 'actions', schema: z.ZodType, list?: unknown[]) => {
    list?.forEach((item, i) => {
      const r = schema.safeParse(item);
      if (!r.success) {
        for (const iss of r.error.issues) {
          issues.push({ field: [key, i, ...iss.path].join('.'), message: iss.message });
        }
      }
    });
  };
  check('conditions', condition, input.conditions);
  check('actions', action, input.actions);
  if (input.actions !== undefined && input.actions.length === 0) issues.push({ field: 'actions', message: 'informe ao menos uma ação' });
  if (issues.length) throw new AppException(400, 'validation_failed', 'Verifique as condições e ações da regra.', issues);
}
