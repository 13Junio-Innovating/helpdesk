import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { WorkerConfig } from './worker-config.js';

export type WorkerClient = pg.PoolClient;

/**
 * Conexão do WORKER (role sd_worker: BYPASSRLS, grants mínimos). Só existe no processo do worker;
 * o AppModule HTTP não importa este módulo, então nenhuma rota de usuário alcança este pool.
 */
@Injectable()
export class WorkerDbService implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(config: WorkerConfig) {
    this.pool = new pg.Pool({
      connectionString: config.get('DATABASE_URL_WORKER'),
      max: config.get('WORKER_DB_POOL_MAX'),
      application_name: 'helpdesk-worker',
      statement_timeout: 60_000,
    });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, args: unknown[] = []) {
    return this.pool.query<R>(sql, args);
  }

  async tx<T>(fn: (c: WorkerClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken = false;
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      try {
        await c.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      c.release(broken);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
