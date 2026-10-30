import { nextFreeSlug, slugify } from './slug.js';

describe('slugify', () => {
  it.each([
    ['Como redefinir minha senha', 'como-redefinir-minha-senha'],
    ['Emissão de 2ª via — NF-e!', 'emissao-de-2a-via-nf-e'],
    ['  Ação/Configuração  ', 'acao-configuracao'],
    ['???', 'artigo'],
  ])('%s → %s', (input, out) => expect(slugify(input)).toBe(out));

  it('limita o tamanho sem terminar em hífen', () => {
    const s = slugify('palavra '.repeat(30));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('-')).toBe(false);
  });

  it('acha o primeiro sufixo livre', () => {
    expect(nextFreeSlug('a', new Set())).toBe('a');
    expect(nextFreeSlug('a', new Set(['a', 'a-2']))).toBe('a-3');
  });
});
