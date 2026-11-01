import { Controller, Delete, HttpCode, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import { TimeEntriesService } from './time-entries.service.js';

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('time-entries')
export class TimeEntriesController {
  constructor(private readonly time: TimeEntriesService) {}

  @Roles('admin', 'agent')
  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: TenantAuth, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.time.remove(auth, id);
  }
}
