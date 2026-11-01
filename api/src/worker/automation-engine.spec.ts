import { planActions, ruleMatches, type TicketFacts } from './automation-engine.js';

const facts: TicketFacts = {
  subject: 'Sistema FORA do ar', 'priority.name': 'Urgente', 'status.kind': 'open', tags: ['VIP', 'financeiro'],
  'queue.id': null, channel: 'email',
};

describe('motor de automações', () => {
  it.each([
    [[{ field: 'priority.name', op: 'eq', value: 'urgente' }], true],
    [[{ field: 'subject', op: 'contains', value: 'fora do ar' }], true],
    [[{ field: 'channel', op: 'in', value: ['portal', 'EMAIL'] }], true],
    [[{ field: 'tags', op: 'contains', value: 'vip' }], true],
    [[{ field: 'tags', op: 'in', value: ['x', 'Financeiro'] }], true],
    [[{ field: 'tags', op: 'eq', value: 'outro' }], false],
    [[{ field: 'queue.id', op: 'eq', value: 'x' }], false],
    [[{ field: 'priority.name', op: 'eq', value: 'Urgente' }, { field: 'channel', op: 'eq', value: 'portal' }], false],
    [[], true],
  ] as const)('%j => %s', (conds, expected) => {
    expect(ruleMatches(conds as never, facts)).toBe(expected);
  });

  it('junta ações; a última vence no mesmo campo; tags sem repetição', () => {
    const p = planActions([{ type: 'set_priority', priority_id: 'a' }, { type: 'add_tag', value: 'x' }], { addTags: [], notify: false });
    planActions([{ type: 'set_priority', priority_id: 'b' }, { type: 'add_tag', value: 'x' }, { type: 'notify_staff' }], p);
    expect(p).toEqual({ priority_id: 'b', addTags: ['x'], notify: true });
  });
});
