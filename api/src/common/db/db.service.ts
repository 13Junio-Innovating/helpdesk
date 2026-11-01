import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { AppConfig } from '../../config/app-config.js';

export type DbClient = pg.PoolClient;

/** Identidade usada para montar o contexto de RLS da transação. */
export interface TenantContext {
  tenantId: string;
  userId: string;
}

/**
 * Único ponto de acesso ao banco pela API (role `sd_app`, sujeita a RLS).
 *
 * Toda operação roda numa transação que começa com `app_set_context(...)` (LOCAL, vale só
 * naquela transação) e termina garantidamente em COMMIT/ROLLBACK, com a conexão devolvida
 * ao pool. Não há método que entregue uma conexão "solta": isso impede que uma query de dados
 * de tenant rode sem contexto ou herde o contexto de outra requisição.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: pg.Pool;

  constructor(config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.get('DATABASE_URL'),
      max: config.get('DB_POOL_MAX'),
      application_name: 'helpdesk-api',
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    this.pool.on('error', (err) => this.logger.error({ err: err.message }, 'erro em conexão ociosa do pool'));
  }

  /** Transação com contexto de tenant + usuário: o caminho padrão para dados de tenant. */
  withTenant<T>(ctx: TenantContext, fn: (client: DbClient) => Promise<T>): Promise<T> {
    return this.run(ctx.tenantId, ctx.userId, fn);
  }

  /** Transação só com usuário (sem tenant). Ex.: `create_tenant_for_user`. Não enxerga dados de tenant. */
  withUser<T>(userId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
    return this.run(null, userId, fn);
  }

  /**
   * Transação SEM contexto: para as funções SECURITY DEFINER de autenticação (login, signup,
   * refresh...). Pela RLS, qualquer SELECT direto em tabela de tenant aqui devolve zero linhas.
   */
  anonymous<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    return this.run(null, null, fn);
  }

  /** Verificação de saúde: não toca dados de tenant. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  private async run<T>(tenantId: string | null, userId: string | null, fn: (c: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT app_set_context($1::uuid, $2::uuid)', [tenantId, userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // conexão em estado desconhecido: descarta em vez de devolver ao pool
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
