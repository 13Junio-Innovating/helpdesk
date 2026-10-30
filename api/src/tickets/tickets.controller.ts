import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { BulkUpdateResult, Paginated, TicketDetail, TicketListItem, TicketMessage, TimeEntry } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Roles } from '../common/auth/decorators.js';
import { TicketsService } from './tickets.service.js';
import {
  BulkUpdateDto,
  CreateMessageDto,
  CreateTicketDto,
  CreateTimeEntryDto,
  ListTicketsQuery,
  UpdateTicketDto,
} from './dto/ticket.dto.js';

const uuid = new ParseUUIDPipe();

@ApiTags('tickets')
@ApiBearerAuth()
@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('tickets')
  list(@CurrentTenantUser() user: TenantUser, @Query() query: ListTicketsQuery): Promise<Paginated<TicketListItem>> {
    return this.tickets.list(user, query);
  }

  @Post('tickets')
  create(@CurrentTenantUser() user: TenantUser, @Body() dto: CreateTicketDto): Promise<TicketDetail> {
    return this.tickets.create(user, dto);
  }

  // antes de :id para não ser capturado como id
  @Roles('admin', 'agent')
  @Post('tickets/bulk')
  @HttpCode(200)
  bulk(@CurrentTenantUser() user: TenantUser, @Body() dto: BulkUpdateDto): Promise<BulkUpdateResult> {
    return this.tickets.bulkUpdate(user, dto);
  }

  @Get('tickets/:id')
  get(@CurrentTenantUser() user: TenantUser, @Param('id', uuid) id: string): Promise<TicketDetail> {
    return this.tickets.get(user, id);
  }

  @Patch('tickets/:id')
  update(@CurrentTenantUser() user: TenantUser, @Param('id', uuid) id: string, @Body() dto: UpdateTicketDto): Promise<TicketDetail> {
    return this.tickets.update(user, id, dto);
  }

  @Post('tickets/:id/messages')
  addMessage(@CurrentTenantUser() user: TenantUser, @Param('id', uuid) id: string, @Body() dto: CreateMessageDto): Promise<TicketMessage> {
    return this.tickets.addMessage(user, id, dto);
  }

  @Roles('admin', 'agent')
  @Get('tickets/:id/time-entries')
  listTime(@CurrentTenantUser() user: TenantUser, @Param('id', uuid) id: string): Promise<TimeEntry[]> {
    return this.tickets.listTimeEntries(user, id);
  }

  @Roles('admin', 'agent')
  @Post('tickets/:id/time-entries')
  addTime(@CurrentTenantUser() user: TenantUser, @Param('id', uuid) id: string, @Body() dto: CreateTimeEntryDto): Promise<TimeEntry> {
    return this.tickets.addTimeEntry(user, id, dto);
  }

  @Roles('admin', 'agent')
  @Delete('time-entries/:id')
  @HttpCode(204)
  deleteTime(@CurrentTenantUser() user: TenantUser, @Param('id', uuid) id: string): Promise<void> {
    return this.tickets.deleteTimeEntry(user, id);
  }
}
