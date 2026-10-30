import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_LIMIT } from '../common/pagination/cursor.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const KB_STATUSES = ['draft', 'published', 'archived'] as const;
export const KB_VISIBILITIES = ['internal', 'portal'] as const;

export class ListKbQuery {
  @ApiPropertyOptional({ description: 'Busca full-text no título e no corpo' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) q?: string;
  @ApiPropertyOptional({ enum: KB_STATUSES }) @IsOptional() @IsIn(KB_STATUSES) status?: (typeof KB_STATUSES)[number];
  @ApiPropertyOptional({ enum: KB_VISIBILITIES }) @IsOptional() @IsIn(KB_VISIBILITIES) visibility?: (typeof KB_VISIBILITIES)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') category?: string;
  @ApiPropertyOptional({ default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIMIT) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}

export class CreateKbArticleDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) title: string;
  @ApiPropertyOptional({ description: 'Markdown' }) @IsOptional() @IsString() @MaxLength(200_000) body?: string;
  @ApiPropertyOptional({ enum: KB_STATUSES, default: 'draft' }) @IsOptional() @IsIn(KB_STATUSES) status?: (typeof KB_STATUSES)[number];
  @ApiPropertyOptional({ enum: KB_VISIBILITIES, default: 'internal' }) @IsOptional() @IsIn(KB_VISIBILITIES) visibility?: (typeof KB_VISIBILITIES)[number];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') categoryId?: string | null;
}

export class UpdateKbArticleDto extends PartialType(CreateKbArticleDto) {
  @ApiPropertyOptional({ description: 'Troca o endereço do artigo (por padrão ele não muda ao editar o título)' })
  @IsOptional()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'use letras minúsculas, números e hífen' })
  @MaxLength(100)
  slug?: string;
}
