import { slugify } from './slug.js';

describe('slugify', () => {
  it.each([
    ['Como redefinir minha senha?', 'como-redefinir-minha-senha'],
    ['  Ação & Reação — 2ª edição ', 'acao-reacao-2a-edicao'],
    ['Não é possível!!!', 'nao-e-possivel'],
    ['???', 'artigo'],
  ])('%s => %s', (input, out) => expect(slugify(input)).toBe(out));

  it('respeita o tamanho máximo sem terminar em hífen', () => {
    const s = slugify('palavra '.repeat(30), 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith('-')).toBe(false);
  });
});
