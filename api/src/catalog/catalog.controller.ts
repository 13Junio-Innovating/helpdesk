import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Roles } from '../common/auth/decorators.js';
import { AppException } from '../common/errors/app-exception.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import {
  CreateAutomationRuleDto, CreateBusinessHoursDto, CreateCategoryDto, CreateHolidayDto, CreatePriorityDto, CreateQueueDto,
  CreateMacroDto, CreateSlaPolicyDto, CreateStatusDto, UpdateMacroDto, SetQueueMembersDto, SetSlotsDto, UpdateAutomationRuleDto, UpdateBusinessHoursDto,
  UpdateCategoryDto, UpdatePriorityDto, UpdateQueueDto, UpdateSlaPolicyDto, UpdateStatusDto,
} from './dto/catalog.dto.js';

const uuid = new ParseUUIDPipe();
type U = TenantUser;

/**
 * Catálogo. Leitura de status/prioridades/categorias/filas: todos os papéis.
 * Horário comercial, SLA e automações: só equipe lê. Escrita: só admin.
 * (@Roles é a primeira barreira; a RLS de 008 é a decisão final.)
 */
@ApiTags('catalog')
@ApiBearerAuth()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly c: CatalogAdminService) {}

  // ---------- status ----------
  @Get('statuses') listStatuses(@CurrentTenantUser() u: U) { return this.c.list(u, 'statuses'); }
  @Get('statuses/:id') getStatus(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'statuses', id); }
  @Roles('admin') @Post('statuses') createStatus(@CurrentTenantUser() u: U, @Body() d: CreateStatusDto) { return this.c.create(u, 'statuses', d); }
  @Roles('admin') @Patch('statuses/:id') updateStatus(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateStatusDto) { return this.c.update(u, 'statuses', id, d); }
  @Roles('admin') @Delete('statuses/:id') @HttpCode(204) removeStatus(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'statuses', id); }

  // ---------- prioridades ----------
  @Get('priorities') listPriorities(@CurrentTenantUser() u: U) { return this.c.list(u, 'priorities'); }
  @Get('priorities/:id') getPriority(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'priorities', id); }
  @Roles('admin') @Post('priorities') createPriority(@CurrentTenantUser() u: U, @Body() d: CreatePriorityDto) { return this.c.create(u, 'priorities', d); }
  @Roles('admin') @Patch('priorities/:id') updatePriority(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdatePriorityDto) { return this.c.update(u, 'priorities', id, d); }
  @Roles('admin') @Delete('priorities/:id') @HttpCode(204) removePriority(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'priorities', id); }

  // ---------- categorias ----------
  @Get('categories') listCategories(@CurrentTenantUser() u: U) { return this.c.list(u, 'categories'); }
  @Get('categories/:id') getCategory(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'categories', id); }
  @Roles('admin') @Post('categories') createCategory(@CurrentTenantUser() u: U, @Body() d: CreateCategoryDto) { return this.c.create(u, 'categories', d); }
  @Roles('admin') @Patch('categories/:id') updateCategory(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateCategoryDto) { return this.c.update(u, 'categories', id, d); }
  @Roles('admin') @Delete('categories/:id') @HttpCode(204) removeCategory(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'categories', id); }

  // ---------- filas ----------
  @Get('queues') listQueues(@CurrentTenantUser() u: U) { return this.c.list(u, 'queues'); }
  @Get('queues/:id') getQueue(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'queues', id); }
  @Roles('admin') @Post('queues') createQueue(@CurrentTenantUser() u: U, @Body() d: CreateQueueDto) { return this.c.create(u, 'queues', d); }
  @Roles('admin') @Patch('queues/:id') updateQueue(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateQueueDto) { return this.c.update(u, 'queues', id, d); }
  @Roles('admin') @Delete('queues/:id') @HttpCode(204) removeQueue(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'queues', id); }
  @Roles('admin', 'agent') @Get('queues/:id/members') queueMembers(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.queueMembers(u, id); }
  @Roles('admin') @Put('queues/:id/members') setQueueMembers(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: SetQueueMembersDto) { return this.c.setQueueMembers(u, id, d); }

  // ---------- horário comercial ----------
  @Roles('admin', 'agent') @Get('business-hours') listBh(@CurrentTenantUser() u: U) { return this.c.list(u, 'businessHours'); }
  @Roles('admin', 'agent') @Get('business-hours/:id') getBh(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'businessHours', id); }
  @Roles('admin') @Post('business-hours') createBh(@CurrentTenantUser() u: U, @Body() d: CreateBusinessHoursDto) { return this.c.create(u, 'businessHours', d); }
  @Roles('admin') @Patch('business-hours/:id') updateBh(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateBusinessHoursDto) { return this.c.update(u, 'businessHours', id, d); }
  @Roles('admin') @Delete('business-hours/:id') @HttpCode(204) removeBh(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'businessHours', id); }
  @Roles('admin') @Put('business-hours/:id/slots') setSlots(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: SetSlotsDto) { return this.c.setSlots(u, id, d); }
  @Roles('admin') @Post('business-hours/:id/holidays') addHoliday(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: CreateHolidayDto) { return this.c.addHoliday(u, id, d); }
  @Roles('admin') @Delete('business-hours/:id/holidays/:date') @HttpCode(204)
  removeHoliday(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Param('date') date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppException(400, 'bad_request', 'Data no formato AAAA-MM-DD.');
    return this.c.removeHoliday(u, id, date);
  }

  // ---------- políticas de SLA ----------
  @Roles('admin', 'agent') @Get('sla-policies') listSla(@CurrentTenantUser() u: U) { return this.c.list(u, 'slaPolicies'); }
  @Roles('admin', 'agent') @Get('sla-policies/:id') getSla(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'slaPolicies', id); }
  @Roles('admin') @Post('sla-policies') createSla(@CurrentTenantUser() u: U, @Body() d: CreateSlaPolicyDto) { return this.c.create(u, 'slaPolicies', d); }
  @Roles('admin') @Patch('sla-policies/:id') updateSla(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateSlaPolicyDto) { return this.c.update(u, 'slaPolicies', id, d); }
  @Roles('admin') @Delete('sla-policies/:id') @HttpCode(204) removeSla(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'slaPolicies', id); }

  // ---------- automações ----------
  @Roles('admin', 'agent') @Get('automation-rules') listRules(@CurrentTenantUser() u: U) { return this.c.list(u, 'automationRules'); }
  @Roles('admin', 'agent') @Get('automation-rules/:id') getRule(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.get(u, 'automationRules', id); }
  @Roles('admin') @Post('automation-rules') createRule(@CurrentTenantUser() u: U, @Body() d: CreateAutomationRuleDto) { return this.c.create(u, 'automationRules', d); }
  @Roles('admin') @Patch('automation-rules/:id') updateRule(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateAutomationRuleDto) { return this.c.update(u, 'automationRules', id, d); }
  @Roles('admin') @Delete('automation-rules/:id') @HttpCode(204) removeRule(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'automationRules', id); }

  // ---------- respostas prontas ----------
  @Roles('admin', 'agent') @Get('macros') listMacros(@CurrentTenantUser() u: U) { return this.c.list(u, 'macros'); }
  @Roles('admin') @Post('macros') createMacro(@CurrentTenantUser() u: U, @Body() d: CreateMacroDto) { return this.c.create(u, 'macros', d); }
  @Roles('admin') @Patch('macros/:id') updateMacro(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateMacroDto) { return this.c.update(u, 'macros', id, d); }
  @Roles('admin') @Delete('macros/:id') @HttpCode(204) removeMacro(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.c.remove(u, 'macros', id); }
}
