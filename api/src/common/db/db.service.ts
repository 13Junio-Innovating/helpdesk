import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { MemberRole } from '@helpdesk/shared';
import type { Env } from '../../config/env.js';
import { AppException } from '../errors/app-exception.js';

/** Só o necessário para consultar: o callback não consegue liberar nem reaproveitar a conexão. */
export interface Tx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
}

/** Informação calculada pelo BANCO (app_role()) no início da transação. */
export interface TxInfo {
  role: MemberRole;
}

/**
 * Pool da API (role sd_app, sujeita a RLS).
 *
 * Contrato: todo acesso a dados de tenant passa por `withTenant`, que abre transação,
 * chama app_set_context (LOCAL) e revalida o membership no banco. Fora dele, o pool
 * só é usado por `withoutTenant` (funções auth_* SECURITY DEFINER) e pelo health check.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.statementTimeoutMs = config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true });
    this.pool = new pg.Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: config.get('DB_POOL_MAX', { infer: true }),
      application_name: 'helpdesk-api',
    });
    // conexões ociosas podem cair (restart do banco); sem este handler o processo morre
    this.pool.on('error', (err) => this.logger.error(`pool: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Executa `fn` numa transação com contexto de tenant. Se o usuário perdeu o acesso
   * (membership inativo, usuário desativado), aborta com 401 antes de rodar `fn`.
   */
  withTenant<T>(ctx: TenantContext, fn: (tx: Tx, info: TxInfo) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ role: MemberRole | null; disabled: boolean | null }>(
        `SELECT app_set_context($1, $2),
                set_config('statement_timeout', $3, true),
                app_role() AS role,
                (SELECT disabled_at IS NOT NULL FROM users WHERE id = app_user_id()) AS disabled`,
        [ctx.tenantId, ctx.userId, String(this.statementTimeoutMs)],
      );
      const row = rows[0];
      if (!row?.role || row.disabled !== false) {
        throw new AppException(401, 'session_invalid', 'Você não tem mais acesso a este workspace. Entre novamente.');
      }
      return fn(client, { role: row.role });
    });
  }

  /**
   * Transação SEM contexto (falha fechada: tabelas de tenant devolvem 0 linhas).
   * Para as funções SECURITY DEFINER de autenticação/cadastro.
   */
  withoutTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query(`SELECT app_set_context(NULL, NULL), set_config('statement_timeout', $1, true)`, [
        String(this.statementTimeoutMs),
      ]);
      return fn(client);
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // conexão em estado desconhecido: descarta em vez de devolver ao pool
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
