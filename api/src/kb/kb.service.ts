import { Injectable } from '@nestjs/common';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { DbService, type DbClient } from '../common/db/db.service.js';
import { SqlParams } from '../common/db/sql-params.js';
import { deleteRow, pickColumns, updateRow } from '../common/db/writes.js';
import { AppError } from '../common/errors/app-error.js';
import { decodeCursor, encodeCursor } from '../common/http/cursor.js';
import type { CreateArticleDto, ListArticlesQuery, UpdateArticleDto } from './kb.dto.js';
import { slugify } from './slug.js';

const FIELDS = { title: 'title', slug: 'slug', body: 'body', status: 'status', visibility: 'visibility', categoryId: 'category_id' };
const COLUMNS = `a.id, a.title, a.slug, a.status, a.visibility, a.category_id AS "categoryId",
                 a.published_at AS "publishedAt", a.created_at AS "createdAt", a.updated_at AS "updatedAt",
                 CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name) END AS author`;
const FROM = 'FROM kb_articles a LEFT JOIN users u ON u.id = a.author_id';

/**
 * Base de conhecimento. A RLS já filtra: cliente só enxerga artigos `published` + `portal`;
 * só a equipe escreve.
 */
@Injectable()
export class KbService {
  constructor(private readonly db: DbService) {}

  list(auth: TenantAuth, q: ListArticlesQuery) {
    const p = new SqlParams();
    const where: string[] = [];
    if (q.status) where.push(`a.status = ${p.add(q.status)}`);
    if (q.visibility) where.push(`a.visibility = ${p.add(q.visibility)}`);
    if (q.category) where.push(`a.category_id = ${p.add(q.category)}`);
    const limit = q.limit ?? 20;

    if (q.q) {
      // com busca: ordena por relevância (sem cursor; as melhores N)
      const tsq = `websearch_to_tsquery('portuguese', ${p.add(q.q.trim())})`;
      where.push(`(a.search @@ ${tsq} OR a.title ILIKE ${p.add(`%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)})`);
      const sql = `SELECT ${COLUMNS}, ts_headline('portuguese', a.body, ${tsq}, 'MaxWords=30, MinWords=10') AS snippet
                     ${FROM} WHERE ${where.join(' AND ')}
                    ORDER BY ts_rank(a.search, ${tsq}) DESC, a.updated_at DESC LIMIT ${p.add(limit)}`;
      return this.db.withTenant(auth, async (c) => ({ items: (await c.query(sql, p.values)).rows, nextCursor: null }));
    }

    if (q.cursor) {
      const [updated, id] = decodeCursor(q.cursor, 2);
      where.push(`(a.updated_at, a.id) < (${p.add(updated)}::timestamptz, ${p.add(id)}::uuid)`);
    }
    const sql = `SELECT ${COLUMNS}, left(a.body, 200) AS snippet, a.updated_at::text AS cursor_key
                   ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY a.updated_at DESC, a.id DESC LIMIT ${p.add(limit + 1)}`;
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<{ id: string; cursor_key: string }>(sql, p.values);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ cursor_key: _k, ...r }) => r),
        nextCursor: rows.length > limit && last ? encodeCursor([last.cursor_key, last.id]) : null,
      };
    });
  }

  getBySlug(auth: TenantAuth, slug: string) {
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query(`SELECT ${COLUMNS}, a.body ${FROM} WHERE a.slug = $1`, [slug]);
      if (!rows[0]) throw notFound();
      return rows[0];
    });
  }

  create(auth: TenantAuth, dto: CreateArticleDto) {
    return this.db.withTenant(auth, async (c) => {
      const slug = dto.slug ?? (await this.freeSlug(c, slugify(dto.title)));
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO kb_articles (tenant_id, title, slug, body, status, visibility, category_id, author_id, published_at)
         VALUES ($1, $2, $3, $4, $5::kb_status, $6::kb_visibility, $7, $8, CASE WHEN $5::kb_status = 'published' THEN now() END)
         RETURNING id`,
        [auth.tenantId, dto.title, slug, dto.body ?? '', dto.status ?? 'draft', dto.visibility ?? 'internal',
          dto.categoryId ?? null, auth.userId],
      );
      return this.findById(c, rows[0]!.id);
    });
  }

  update(auth: TenantAuth, id: string, dto: UpdateArticleDto) {
    return this.db.withTenant(auth, async (c) => {
      const cols = pickColumns(dto, FIELDS);
      await updateRow(c, 'kb_articles', id, cols, 'Artigo');
      if (dto.status === 'published') {
        await c.query('UPDATE kb_articles SET published_at = COALESCE(published_at, now()) WHERE id = $1', [id]);
      }
      return this.findById(c, id);
    });
  }

  remove(auth: TenantAuth, id: string): Promise<void> {
    return this.db.withTenant(auth, (c) => deleteRow(c, 'kb_articles', id, 'Artigo'));
  }

  private async findById(c: DbClient, id: string) {
    const { rows } = await c.query(`SELECT ${COLUMNS}, a.body ${FROM} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  /** Primeiro slug livre: base, base-2, base-3... (a unicidade final é do índice do banco). */
  private async freeSlug(c: DbClient, base: string): Promise<string> {
    const { rows } = await c.query<{ slug: string }>(
      `SELECT slug FROM kb_articles WHERE slug = $1 OR slug ~ ('^' || $1 || '-[0-9]+$')`, [base]);
    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

const notFound = () => new AppError(404, 'not_found', 'Artigo não encontrado.');
