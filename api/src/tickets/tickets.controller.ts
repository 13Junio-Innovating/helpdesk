import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import {
  BulkUpdateDto, CreateMessageDto, CreateTicketDto, CreateTimeEntryDto, ListTicketsQuery, UpdateTicketDto,
} from './dto/ticket.dto.js';
import { TicketsService } from './tickets.service.js';
import { TimeEntriesService } from './time-entries.service.js';

const Id = () => Param('id', new ParseUUIDPipe());

/**
 * Sem @Roles na maioria das rotas de propósito: a RLS decide (cliente só enxerga os seus chamados,
 * não altera campos, não grava nota interna) e o erro do banco vira 403/404.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly time: TimeEntriesService,
  ) {}

  @Get()
  list(@CurrentAuth() auth: TenantAuth, @Query() q: ListTicketsQuery) {
    return this.tickets.list(auth, q);
  }

  @Post()
  create(@CurrentAuth() auth: TenantAuth, @Body() dto: CreateTicketDto) {
    return this.tickets.create(auth, dto);
  }

  @Roles('admin', 'agent')
  @Post('bulk')
  bulk(@CurrentAuth() auth: TenantAuth, @Body() dto: BulkUpdateDto) {
    return this.tickets.bulk(auth, dto);
  }

  @Get(':id')
  get(@CurrentAuth() auth: TenantAuth, @Id() id: string) {
    return this.tickets.get(auth, id);
  }

  @Patch(':id')
  update(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: UpdateTicketDto) {
    return this.tickets.update(auth, id, dto);
  }

  @Post(':id/messages')
  addMessage(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: CreateMessageDto) {
    return this.tickets.addMessage(auth, id, dto);
  }

  @Post(':id/time-entries')
  addTime(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: CreateTimeEntryDto) {
    return this.time.create(auth, id, dto);
  }

  @Roles('admin', 'agent')
  @Get(':id/time-entries')
  listTime(@CurrentAuth() auth: TenantAuth, @Id() id: string) {
    return this.time.list(auth, id);
  }
}
