import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Tx } from '../common/db/db.service.js';
import type { WorkerEnv } from './worker.env.js';

/**
 * Pool do WORKER (role sd_worker: BYPASSRLS, grants mínimos). Só é registrado no WorkerModule,
 * nunca no AppModule: nenhuma rota HTTP de usuário tem acesso a esta conexão.
 * Como ignora a RLS, todo SQL aqui filtra por tenant explicitamente quando age em nome de um tenant.
 */
@Injectable()
export class WorkerDbService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerDbService.name);
  private readonly pool: pg.Pool;

  constructor(config: ConfigService<WorkerEnv, true>) {
    this.pool = new pg.Pool({
      connectionString: config.get('DATABASE_URL_WORKER', { infer: true }),
      max: config.get('WORKER_DB_POOL_MAX', { infer: true }),
      application_name: 'helpdesk-worker',
    });
    this.pool.on('error', (err) => this.logger.error(`pool: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
