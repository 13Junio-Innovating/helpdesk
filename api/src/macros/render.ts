/** Variáveis aceitas nas respostas prontas. Desconhecidas ficam como estão (o agente vê e corrige). */
export interface MacroContext {
  solicitante: { nome: string; email: string; primeiro_nome: string };
  agente: { nome: string; primeiro_nome: string };
  chamado: { numero: string; assunto: string; status: string; prioridade: string };
  organizacao: { nome: string };
  empresa: { nome: string };
}

export const MACRO_VARIABLES = [
  'solicitante.nome', 'solicitante.primeiro_nome', 'solicitante.email',
  'agente.nome', 'agente.primeiro_nome',
  'chamado.numero', 'chamado.assunto', 'chamado.status', 'chamado.prioridade',
  'organizacao.nome', 'empresa.nome',
];

export function renderMacro(body: string, ctx: MacroContext): string {
  return body.replace(/\{\{\s*([a-z_]+)\.([a-z_]+)\s*\}\}/g, (whole, group: string, key: string) => {
    // só propriedades próprias: {{constructor.name}} não pode alcançar o protótipo
    const groups = ctx as unknown as Record<string, Record<string, unknown>>;
    if (!Object.hasOwn(groups, group)) return whole;
    const scope = groups[group]!;
    const value = Object.hasOwn(scope, key) ? scope[key] : undefined;
    return typeof value === 'string' ? value : whole;
  });
}
