import { renderMacro, type MacroContext } from './render.js';

const ctx: MacroContext = {
  solicitante: { nome: 'João Pereira', primeiro_nome: 'João', email: 'joao@acme.local' },
  agente: { nome: 'Carlos Souza', primeiro_nome: 'Carlos' },
  chamado: { numero: '42', assunto: 'Impressora', status: 'Novo', prioridade: 'Alta' },
  organizacao: { nome: 'ACME' },
  empresa: { nome: 'Demo Suporte' },
};

describe('renderMacro', () => {
  it('substitui variáveis conhecidas, com ou sem espaços', () => {
    expect(renderMacro('Olá {{solicitante.primeiro_nome}}, chamado #{{ chamado.numero }}. — {{agente.nome}}', ctx))
      .toBe('Olá João, chamado #42. — Carlos Souza');
  });

  it('mantém variáveis desconhecidas e não interpreta nada além do padrão', () => {
    expect(renderMacro('{{x.y}} {{solicitante.senha}} {{constructor.name}} {solicitante.nome}', ctx))
      .toBe('{{x.y}} {{solicitante.senha}} {{constructor.name}} {solicitante.nome}');
  });
});
