import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ReportsOverview } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Roles } from '../common/auth/decorators.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles('admin', 'agent')
  @Get('overview')
  overview(@CurrentTenantUser() u: TenantUser): Promise<ReportsOverview> {
    return this.reports.overview(u);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
