/** "Como redefinir minha senha?" -> "como-redefinir-minha-senha" */
export function slugify(text: string, max = 80): string {
  const s = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'artigo';
}
