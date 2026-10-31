import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/decorators.js';
import { DbService } from '../common/db/db.service.js';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  /** Processo vivo e banco respondendo. */
  @Get()
  async live() {
    await this.check(() => this.db.ping());
    return { status: 'ok' };
  }

  /** Pronto para tráfego: banco acessível e schema migrado (lê a tabela global `plans`). */
  @Get('ready')
  async ready() {
    await this.check(() =>
      this.db.anonymous(async (c) => {
        const { rowCount } = await c.query('SELECT 1 FROM plans LIMIT 1');
        if (!rowCount) throw new Error('schema sem planos');
      }),
    );
    return { status: 'ready' };
  }

  private async check(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch {
      throw new ServiceUnavailableException({ code: 'unavailable', message: 'Serviço indisponível.' });
    }
  }
}
