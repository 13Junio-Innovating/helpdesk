import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import { CreateMacroDto, CreateSavedViewDto, RenderMacroDto, UpdateMacroDto, UpdateSavedViewDto } from './macros.dto.js';
import { MacrosService } from './macros.service.js';
import { MACRO_VARIABLES } from './render.js';

const Id = () => Param('id', new ParseUUIDPipe());

@ApiTags('macros')
@ApiBearerAuth()
@Roles('admin', 'agent')
@Controller()
export class MacrosController {
  constructor(private readonly svc: MacrosService) {}

  @Get('macros')
  list(@CurrentAuth() auth: TenantAuth) {
    return this.svc.listMacros(auth);
  }

  @Get('macros/variables')
  variables() {
    return MACRO_VARIABLES;
  }

  @Post('macros')
  create(@CurrentAuth() auth: TenantAuth, @Body() dto: CreateMacroDto) {
    return this.svc.createMacro(auth, dto);
  }

  @Patch('macros/:id')
  update(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: UpdateMacroDto) {
    return this.svc.updateMacro(auth, id, dto);
  }

  @Delete('macros/:id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: TenantAuth, @Id() id: string): Promise<void> {
    return this.svc.removeMacro(auth, id);
  }

  @Post('macros/:id/render')
  @HttpCode(200)
  render(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: RenderMacroDto) {
    return this.svc.renderMacro(auth, id, dto.ticketId);
  }

  @Get('saved-views')
  views(@CurrentAuth() auth: TenantAuth) {
    return this.svc.listViews(auth);
  }

  @Post('saved-views')
  createView(@CurrentAuth() auth: TenantAuth, @Body() dto: CreateSavedViewDto) {
    return this.svc.createView(auth, dto);
  }

  @Patch('saved-views/:id')
  updateView(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: UpdateSavedViewDto) {
    return this.svc.updateView(auth, id, dto);
  }

  @Delete('saved-views/:id')
  @HttpCode(204)
  removeView(@CurrentAuth() auth: TenantAuth, @Id() id: string): Promise<void> {
    return this.svc.removeView(auth, id);
  }
}
