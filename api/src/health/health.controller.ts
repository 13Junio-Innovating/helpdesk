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

  /** Liveness: processo de pé e banco respondendo. */
  @Get()
  async health(): Promise<{ status: 'ok' }> {
    await this.check(() => this.db.ping());
    return { status: 'ok' };
  }

  /** Readiness: além do banco, confere que as migrations exigidas pela API (até 010) foram aplicadas. */
  @Get('ready')
  async ready(): Promise<{ status: 'ready' }> {
    await this.check(async () => {
      const ok = await this.db.withoutTenant(async (tx) => {
        const { rows } = await tx.query<{ ok: boolean }>(
          `SELECT to_regprocedure('auth_session_rotate(text,text,interval)') IS NOT NULL AS ok`,
        );
        return rows[0]?.ok === true;
      });
      if (!ok) throw new Error('migrations pendentes');
    });
    return { status: 'ready' };
  }

  private async check(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
