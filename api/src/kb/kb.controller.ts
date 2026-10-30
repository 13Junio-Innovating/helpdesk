import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { KbArticle, KbArticleSummary, Paginated } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Roles } from '../common/auth/decorators.js';
import { AppException } from '../common/errors/app-exception.js';
import { KbService } from './kb.service.js';
import { CreateKbArticleDto, ListKbQuery, UpdateKbArticleDto } from './kb.dto.js';

const uuid = new ParseUUIDPipe();

@ApiTags('kb')
@ApiBearerAuth()
@Controller('kb')
export class KbController {
  constructor(private readonly kb: KbService) {}

  /** Todos os papéis; o cliente só recebe artigos publicados no portal (RLS). */
  @Get()
  list(@CurrentTenantUser() u: TenantUser, @Query() q: ListKbQuery): Promise<Paginated<KbArticleSummary>> {
    return this.kb.list(u, q);
  }

  /** Para o editor da equipe (o slug pode mudar; o id não). */
  @Roles('admin', 'agent') @Get('id/:id')
  getById(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string): Promise<KbArticle> { return this.kb.getById(u, id); }

  @Get(':slug')
  get(@CurrentTenantUser() u: TenantUser, @Param('slug') slug: string): Promise<KbArticle> {
    if (!/^[a-z0-9-]{1,100}$/.test(slug)) throw new AppException(404, 'not_found', 'Artigo não encontrado.');
    return this.kb.getBySlug(u, slug);
  }

  @Roles('admin', 'agent') @Post()
  create(@CurrentTenantUser() u: TenantUser, @Body() d: CreateKbArticleDto): Promise<KbArticle> { return this.kb.create(u, d); }

  @Roles('admin', 'agent') @Patch(':id')
  update(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string, @Body() d: UpdateKbArticleDto): Promise<KbArticle> {
    return this.kb.update(u, id, d);
  }

  @Roles('admin', 'agent') @Delete(':id') @HttpCode(204)
  remove(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string): Promise<void> { return this.kb.remove(u, id); }
}
