import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import { DbService } from '../common/db/db.service.js';
import { AppError } from '../common/errors/app-error.js';

const MAX_DAYS = 366;

export class OverviewQuery {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

/** Só repassa report_overview(): todo o cálculo mora no banco (migration 012), sob a RLS de quem pede. */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  overview(auth: TenantAuth, q: OverviewQuery): Promise<unknown> {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new AppError(400, 'invalid_period', 'A data inicial precisa ser anterior à final.');
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) {
      throw new AppError(400, 'invalid_period', `O período máximo é de ${MAX_DAYS} dias.`);
    }
    return this.db.withTenant(auth, async (c) => {
      const { rows } = await c.query<{ r: unknown }>('SELECT report_overview($1::timestamptz, $2::timestamptz) AS r', [from, to]);
      return rows[0]!.r;
    });
  }
}

@ApiTags('reports')
@ApiBearerAuth()
@Roles('admin', 'agent')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  overview(@CurrentAuth() auth: TenantAuth, @Query() q: OverviewQuery) {
    return this.reports.overview(auth, q);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
