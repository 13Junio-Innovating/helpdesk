import { Injectable } from '@nestjs/common';
import type { KbArticle, KbArticleSummary, Paginated } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { tenantCtx } from '../common/auth/decorators.js';
import { DbService, type Tx } from '../common/db/db.service.js';
import { insertParts, setClauses, type ColumnMap } from '../common/db/sql.js';
import { AppException } from '../common/errors/app-exception.js';
import { isPgError } from '../common/errors/pg-errors.js';
import { decodeCursor, DEFAULT_LIMIT, encodeCursor } from '../common/pagination/cursor.js';
import { nextFreeSlug, slugify } from './slug.js';
import type { CreateKbArticleDto, ListKbQuery, UpdateKbArticleDto } from './kb.dto.js';

const COLUMNS: ColumnMap = [
  ['title', 'title'],
  ['slug', 'slug'],
  ['body', 'body'],
  ['status', 'status'],
  ['visibility', 'visibility'],
  ['categoryId', 'category_id'],
];

const SUMMARY = `a.id, a.title, a.slug, a.status, a.visibility, c.id AS category_id, c.name AS category_name,
  left(regexp_replace(a.body, '\\s+', ' ', 'g'), 200) AS excerpt, a.published_at, a.updated_at`;
const FROM = `FROM kb_articles a LEFT JOIN categories c ON c.id = a.category_id`;

interface Row {
  id: string; title: string; slug: string; status: KbArticle['status']; visibility: KbArticle['visibility'];
  category_id: string | null; category_name: string | null; excerpt: string; published_at: Date | null; updated_at: Date;
  body?: string; author_id?: string | null; author_name?: string | null; created_at?: Date; _k0?: string;
}

const toSummary = (r: Row): KbArticleSummary => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  status: r.status,
  visibility: r.visibility,
  category: r.category_id && r.category_name ? { id: r.category_id, name: r.category_name } : null,
  excerpt: r.excerpt,
  publishedAt: r.published_at?.toISOString() ?? null,
  updatedAt: r.updated_at.toISOString(),
});

/**
 * Base de conhecimento. A RLS de 008 já restringe o cliente a artigos publicados e visíveis no portal;
 * os filtros de status/visibilidade aqui são só conveniência para a equipe.
 */
@Injectable()
export class KbService {
  constructor(private readonly db: DbService) {}

  list(user: TenantUser, q: ListKbQuery): Promise<Paginated<KbArticleSummary>> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const params: unknown[] = [];
    const where: string[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (q.status) where.push(`a.status = ${p(q.status)}`);
    if (q.visibility) where.push(`a.visibility = ${p(q.visibility)}`);
    if (q.category) where.push(`a.category_id = ${p(q.category)}`);

    let order: string;
    let keyCols = '';
    if (q.q) {
      // com busca: QUALQUER termo relevante casa (o cliente digita frases inteiras, ex.: "não consigo
      // redefinir a senha"); quem casa mais termos sobe no ranking. Só a primeira página (sem cursor).
      const tsq = `replace(plainto_tsquery('portuguese', ${p(q.q)})::text, ' & ', ' | ')::tsquery`;
      where.push(`(a.search @@ ${tsq} OR a.title ILIKE '%' || ${p(q.q.replace(/[\\%_]/g, (m) => `\\${m}`))} || '%')`);
      order = `ts_rank(a.search, ${tsq}) DESC, a.updated_at DESC`;
    } else {
      if (q.cursor) {
        const [ts, id] = decodeCursor(q.cursor, 2);
        where.push(`(a.updated_at, a.id) < (${p(ts)}::timestamptz, ${p(id)}::uuid)`);
      }
      order = 'a.updated_at DESC, a.id DESC';
      keyCols = ', a.updated_at::text AS _k0';
    }
    const sql = `SELECT ${SUMMARY}${keyCols} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY ${order} LIMIT ${p(limit + 1)}`;

    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const { rows } = await tx.query<Row>(sql, params);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toSummary),
        nextCursor: !q.q && rows.length > limit && last ? encodeCursor([last._k0!, last.id]) : null,
      };
    });
  }

  getById(user: TenantUser, id: string): Promise<KbArticle> {
    return this.db.withTenant(tenantCtx(user), (tx) => this.fetch(tx, 'a.id = $1', id));
  }

  getBySlug(user: TenantUser, slug: string): Promise<KbArticle> {
    return this.db.withTenant(tenantCtx(user), (tx) => this.fetch(tx, 'a.slug = $1', slug));
  }

  /** Slug gerado do título e único no tenant; em corrida (23505) tenta de novo. */
  async create(user: TenantUser, dto: CreateKbArticleDto): Promise<KbArticle> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.withTenant(tenantCtx(user), async (tx) => {
          const slug = await this.freeSlug(tx, slugify(dto.title));
          const params: unknown[] = [user.tenantId, user.userId];
          const { cols, vals } = insertParts(COLUMNS, { ...dto, slug }, params);
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO kb_articles (tenant_id, author_id, ${cols.join(', ')}, published_at)
             VALUES ($1, $2, ${vals.join(', ')}, CASE WHEN ${dto.status === 'published' ? 'true' : 'false'} THEN now() END)
             RETURNING id`,
            params,
          );
          return this.fetch(tx, 'a.id = $1', rows[0]!.id);
        });
      } catch (e) {
        if (attempt < 3 && isPgError(e) && e.code === '23505') continue;
        throw e;
      }
    }
  }

  update(user: TenantUser, id: string, dto: UpdateKbArticleDto): Promise<KbArticle> {
    const params: unknown[] = [id];
    const sets = setClauses(COLUMNS, dto, params);
    if (!sets.length) throw new AppException(400, 'validation_failed', 'Informe ao menos um campo para alterar.');
    // primeira publicação registra a data (mantida se depois for arquivado)
    if (dto.status === 'published') sets.push('published_at = COALESCE(published_at, now())');
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const res = await tx.query(`UPDATE kb_articles SET ${sets.join(', ')} WHERE id = $1`, params);
      if (!res.rowCount) await this.explainNoRows(tx, id);
      return this.fetch(tx, 'a.id = $1', id);
    });
  }

  remove(user: TenantUser, id: string): Promise<void> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const res = await tx.query('DELETE FROM kb_articles WHERE id = $1', [id]);
      if (!res.rowCount) await this.explainNoRows(tx, id);
    });
  }

  // ---------------------------------------------------------------------------

  private async freeSlug(tx: Tx, base: string): Promise<string> {
    const { rows } = await tx.query<{ slug: string }>(
      `SELECT slug FROM kb_articles WHERE slug = $1 OR slug ~ ('^' || $1 || '-[0-9]+$')`,
      [base],
    );
    return nextFreeSlug(base, new Set(rows.map((r) => r.slug)));
  }

  private async fetch(tx: Tx, cond: string, value: string): Promise<KbArticle> {
    const { rows } = await tx.query<Row>(
      `SELECT ${SUMMARY}, a.body, a.created_at, u.id AS author_id, u.name AS author_name
         ${FROM} LEFT JOIN users u ON u.id = a.author_id WHERE ${cond}`,
      [value],
    );
    const r = rows[0];
    if (!r) throw new AppException(404, 'not_found', 'Artigo não encontrado.');
    return {
      ...toSummary(r),
      body: r.body ?? '',
      author: r.author_id && r.author_name ? { id: r.author_id, name: r.author_name } : null,
      createdAt: r.created_at!.toISOString(),
    };
  }

  private async explainNoRows(tx: Tx, id: string): Promise<never> {
    await this.fetch(tx, 'a.id = $1', id);
    throw new AppException(403, 'forbidden', 'Você não tem permissão para esta ação.');
  }
}
