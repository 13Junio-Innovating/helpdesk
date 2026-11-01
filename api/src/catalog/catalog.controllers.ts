import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, ValidationPipe, type Type,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import { CatalogService } from './catalog.service.js';
import { CATALOG_SPECS, type ResourceSpec } from './catalog.specs.js';
import { CreateHolidayDto, SetQueueMembersDto, SetSlotsDto } from './dto/catalog.dto.js';
import { CatalogExtrasService } from './catalog-extras.service.js';

const noop: MethodDecorator = () => undefined;
const Id = () => Param('id', new ParseUUIDPipe());

/** O ValidationPipe global não sabe o tipo do corpo num controller gerado; este pipe sabe. */
const BodyOf = (type: Type) =>
  Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, expectedType: type }));

/** Gera GET/POST/GET :id/PATCH :id/DELETE :id para um recurso do catálogo. */
function crudController(spec: ResourceSpec): Type {
  const ReadRoles = spec.readRoles ? Roles(...spec.readRoles) : noop;

  @ApiTags('catalog')
  @ApiBearerAuth()
  @Controller(spec.path)
  class CrudController {
    constructor(@Inject(CatalogService) readonly svc: CatalogService) {}

    @ReadRoles
    @Get()
    list(@CurrentAuth() auth: TenantAuth) {
      return this.svc.list(auth, spec);
    }

    @ReadRoles
    @Get(':id')
    get(@CurrentAuth() auth: TenantAuth, @Id() id: string) {
      return this.svc.get(auth, spec, id);
    }

    @Post()
    create(@CurrentAuth() auth: TenantAuth, @BodyOf(spec.createDto) dto: Record<string, unknown>) {
      return this.svc.create(auth, spec, dto);
    }

    @Patch(':id')
    update(@CurrentAuth() auth: TenantAuth, @Id() id: string, @BodyOf(spec.updateDto) dto: Record<string, unknown>) {
      return this.svc.update(auth, spec, id, dto);
    }

    @Delete(':id')
    @HttpCode(204)
    remove(@CurrentAuth() auth: TenantAuth, @Id() id: string): Promise<void> {
      return this.svc.remove(auth, spec, id);
    }
  }
  Object.defineProperty(CrudController, 'name', { value: `${spec.table}Controller` });
  return CrudController;
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller()
export class CatalogExtrasController {
  constructor(private readonly extras: CatalogExtrasService) {}

  @Roles('admin', 'agent')
  @Get('queues/:id/members')
  queueMembers(@CurrentAuth() auth: TenantAuth, @Id() id: string) {
    return this.extras.queueMembers(auth, id);
  }

  @Put('queues/:id/members')
  setQueueMembers(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: SetQueueMembersDto) {
    return this.extras.setQueueMembers(auth, id, dto.userIds);
  }

  @Roles('admin', 'agent')
  @Get('business-hours/:id/schedule')
  schedule(@CurrentAuth() auth: TenantAuth, @Id() id: string) {
    return this.extras.schedule(auth, id);
  }

  @Put('business-hours/:id/slots')
  setSlots(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: SetSlotsDto) {
    return this.extras.setSlots(auth, id, dto.slots);
  }

  @Post('business-hours/:id/holidays')
  addHoliday(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: CreateHolidayDto) {
    return this.extras.addHoliday(auth, id, dto);
  }

  @Delete('business-hours/:id/holidays/:date')
  @HttpCode(204)
  removeHoliday(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Param('date') date: string): Promise<void> {
    return this.extras.removeHoliday(auth, id, date);
  }
}

export const CATALOG_CONTROLLERS: Type[] = [...CATALOG_SPECS.map(crudController), CatalogExtrasController];
