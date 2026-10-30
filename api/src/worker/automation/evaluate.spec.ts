import { planActions, ruleMatches, type TicketSnapshot } from './evaluate.js';

const snap: TicketSnapshot = {
  subject: 'Impressora parou', 'priority.name': 'Urgente', 'status.kind': 'open', tags: ['vip', 'hardware'], 'category.id': null,
};

describe('ruleMatches', () => {
  it.each([
    [[{ field: 'priority.name', op: 'eq', value: 'urgente' }], true],
    [[{ field: 'priority.name', op: 'eq', value: 'Alta' }], false],
    [[{ field: 'priority.name', op: 'in', value: ['Alta', 'Urgente'] }], true],
    [[{ field: 'subject', op: 'contains', value: 'IMPRESSORA' }], true],
    [[{ field: 'tags', op: 'contains', value: 'vip' }], true],
    [[{ field: 'tags', op: 'contains', value: 'vi' }], false], // lista: item inteiro, não substring
    [[{ field: 'tags', op: 'in', value: ['x', 'hardware'] }], true],
    [[{ field: 'category.id', op: 'eq', value: 'x' }], false], // campo nulo nunca casa
    [[], true],
    [[{ field: 'priority.name', op: 'eq', value: 'Urgente' }, { field: 'status.kind', op: 'eq', value: 'closed' }], false], // E
    [[{ field: 'priority.name', op: 'regex', value: '.*' }], false], // operador inválido
    ['lixo', false],
  ])('%j → %s', (conds, expected) => expect(ruleMatches(conds, snap)).toBe(expected));
});

describe('planActions', () => {
  it('combina ações; regra posterior vence em conflito; tags sem repetição', () => {
    const p = planActions([
      { name: 'A', actions: [{ type: 'assign_queue', queueId: 'q1' }, { type: 'add_tag', value: 'x' }, { type: 'notify_staff' }] },
      { name: 'B', actions: [{ type: 'assign_queue', queueId: 'q2' }, { type: 'add_tag', value: 'x' }, { type: 'set_priority', priorityId: 'p' }] },
    ]);
    expect(p).toEqual({ queueId: 'q2', priorityId: 'p', addTags: ['x'], notify: ['A'] });
  });
});
