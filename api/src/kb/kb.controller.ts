import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth } from '../common/auth/decorators.js';
import { AppError } from '../common/errors/app-error.js';
import { CreateArticleDto, KB_SLUG, ListArticlesQuery, UpdateArticleDto } from './kb.dto.js';
import { KbService } from './kb.service.js';

@ApiTags('kb')
@ApiBearerAuth()
@Controller('kb')
export class KbController {
  constructor(private readonly kb: KbService) {}

  @Get()
  list(@CurrentAuth() auth: TenantAuth, @Query() q: ListArticlesQuery) {
    return this.kb.list(auth, q);
  }

  @Get(':slug')
  get(@CurrentAuth() auth: TenantAuth, @Param('slug') slug: string) {
    if (!KB_SLUG.test(slug) || slug.length > 120) throw new AppError(404, 'not_found', 'Artigo não encontrado.');
    return this.kb.getBySlug(auth, slug);
  }

  @Post()
  create(@CurrentAuth() auth: TenantAuth, @Body() dto: CreateArticleDto) {
    return this.kb.create(auth, dto);
  }

  @Patch(':id')
  update(@CurrentAuth() auth: TenantAuth, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateArticleDto) {
    return this.kb.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: TenantAuth, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.kb.remove(auth, id);
  }
}
