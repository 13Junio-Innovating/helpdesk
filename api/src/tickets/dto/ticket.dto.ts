import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID,
  Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { NormalizeTags, Trim } from '../../common/http/validators.js';

export const CHANNELS = ['portal', 'email', 'chat', 'phone', 'api'] as const;
export const SORTS = ['updated', 'created', 'priority', 'due'] as const;
export const SLA_FILTERS = ['breached', 'running', 'paused'] as const;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u;

/** Campos nulos são "limpar"; ausentes são "não mexer". */
const Nullable = () => ValidateIf((_o, v) => v !== null && v !== undefined);

export class CreateTicketDto {
  @Trim() @IsString() @Length(1, 300, { message: 'O assunto deve ter entre 1 e 300 caracteres.' })
  subject: string;

  @IsOptional() @IsString() @MaxLength(20000)
  description?: string;

  /** Equipe abrindo em nome de um cliente. Cliente só pode abrir para si. */
  @IsOptional() @IsUUID() requesterId?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() priorityId?: string;
  @IsOptional() @IsUUID() statusId?: string;
  @IsOptional() @IsUUID() queueId?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsUUID() organizationId?: string;
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];

  @IsOptional() @NormalizeTags() @IsArray() @ArrayMaxSize(20) @Matches(TAG, { each: true, message: 'Tag inválida.' })
  tags?: string[];

  @IsOptional() @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateTicketDto {
  @IsOptional() @Trim() @IsString() @Length(1, 300) subject?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @Nullable() @IsUUID() assigneeId?: string | null;
  @Nullable() @IsUUID() queueId?: string | null;
  @Nullable() @IsUUID() categoryId?: string | null;
  @Nullable() @IsUUID() organizationId?: string | null;
  @IsOptional() @IsUUID() priorityId?: string;
  @IsOptional() @IsUUID() statusId?: string;

  @IsOptional() @NormalizeTags() @IsArray() @ArrayMaxSize(20) @Matches(TAG, { each: true, message: 'Tag inválida.' })
  tags?: string[];

  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
}

export class BulkChangesDto {
  @Nullable() @IsUUID() assigneeId?: string | null;
  @Nullable() @IsUUID() queueId?: string | null;
  @IsOptional() @IsUUID() statusId?: string;
  @IsOptional() @IsUUID() priorityId?: string;

  @IsOptional() @NormalizeTags() @IsArray() @ArrayMaxSize(20) @Matches(TAG, { each: true, message: 'Tag inválida.' })
  addTags?: string[];
}

export class BulkUpdateDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true })
  ids: string[];

  @ValidateNested() @Type(() => BulkChangesDto)
  changes: BulkChangesDto;
}

export class ListTicketsQuery {
  /** Lista separada por vírgula de ids de status, `kind` (open, pending, on_hold, resolved, closed) ou `unresolved`. */
  @IsOptional() @IsString() @MaxLength(400) status?: string;
  /** `me`, `none` ou id do responsável. */
  @IsOptional() @Matches(/^(me|none|[0-9a-f-]{36})$/i, { message: 'assignee deve ser me, none ou um id.' }) assignee?: string;
  @IsOptional() @IsUUID() queue?: string;
  @IsOptional() @IsUUID() category?: string;
  @IsOptional() @IsUUID() priority?: string;
  @IsOptional() @IsUUID() organization?: string;
  @IsOptional() @IsUUID() requester?: string;
  @IsOptional() @IsIn(SLA_FILTERS) sla?: (typeof SLA_FILTERS)[number];
  @IsOptional() @IsString() @Length(1, 40) tag?: string;
  @IsOptional() @IsString() @Length(1, 200) q?: string;
  @IsOptional() @IsISO8601() createdFrom?: string;
  @IsOptional() @IsISO8601() createdTo?: string;
  @IsOptional() @IsIn(SORTS) sort?: (typeof SORTS)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}

export const MESSAGE_KINDS = ['public_reply', 'internal_note'] as const;

export class CreateMessageDto {
  @IsIn(MESSAGE_KINDS, { message: 'kind deve ser public_reply ou internal_note.' })
  kind: (typeof MESSAGE_KINDS)[number];

  @IsString() @Length(1, 50000, { message: 'A mensagem não pode ficar vazia.' })
  body: string;
}

export class CreateTimeEntryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1440, { message: 'Máximo de 1440 minutos por apontamento.' })
  minutes: number;

  @IsOptional() @Trim() @IsString() @MaxLength(1000) note?: string;

  /** Data trabalhada (AAAA-MM-DD). Padrão: hoje no fuso do workspace (definido pelo banco). */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use o formato AAAA-MM-DD.' }) workedOn?: string;
}
