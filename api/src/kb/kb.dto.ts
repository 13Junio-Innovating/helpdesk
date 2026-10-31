import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { nullableIf, Trim } from '../common/http/validators.js';

export const KB_STATUS = ['draft', 'published', 'archived'] as const;
export const KB_VISIBILITY = ['internal', 'portal'] as const;
export const KB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateArticleDto {
  @Trim() @IsString() @Length(1, 200, { message: 'O título deve ter entre 1 e 200 caracteres.' }) title: string;
  /** Opcional: gerado a partir do título. */
  @IsOptional() @Matches(KB_SLUG, { message: 'Slug inválido (letras minúsculas, números e hífens).' }) @MaxLength(120) slug?: string;
  @IsOptional() @IsString() @MaxLength(200000) body?: string;
  @IsOptional() @IsIn(KB_STATUS) status?: (typeof KB_STATUS)[number];
  @IsOptional() @IsIn(KB_VISIBILITY) visibility?: (typeof KB_VISIBILITY)[number];
  @ValidateIf(nullableIf) @IsUUID() categoryId?: string | null;
}
export class UpdateArticleDto extends PartialType(CreateArticleDto) {}

export class ListArticlesQuery {
  @IsOptional() @IsString() @Length(1, 200) q?: string;
  @IsOptional() @IsIn(KB_STATUS) status?: (typeof KB_STATUS)[number];
  @IsOptional() @IsIn(KB_VISIBILITY) visibility?: (typeof KB_VISIBILITY)[number];
  @IsOptional() @IsUUID() category?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}
