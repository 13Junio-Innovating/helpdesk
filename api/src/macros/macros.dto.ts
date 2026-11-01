import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Trim } from '../common/http/validators.js';

export class CreateMacroDto {
  @Trim() @IsString() @Length(1, 120) name: string;
  @IsString() @Length(1, 20000) body: string;
  @IsOptional() @IsBoolean() shared?: boolean;
}
export class UpdateMacroDto extends PartialType(CreateMacroDto) {}

export class RenderMacroDto {
  @IsUUID() ticketId: string;
}

export class CreateSavedViewDto {
  @Trim() @IsString() @Length(1, 80) name: string;
  /** Mesmos parâmetros de GET /tickets (status, assignee, sla, q, sort...). */
  @IsObject() filters: Record<string, unknown>;
  @IsOptional() @IsBoolean() shared?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) position?: number;
}
export class UpdateSavedViewDto extends PartialType(CreateSavedViewDto) {}
