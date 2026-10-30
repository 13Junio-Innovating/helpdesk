import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { SLA_FILTERS, STATUS_KINDS, TICKET_CHANNELS, TICKET_SORTS, type SlaFilter, type TicketChannel, type TicketSort } from '@helpdesk/shared';
import { MAX_LIMIT } from '../../common/pagination/cursor.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Tags: minúsculas, sem espaços nas pontas, sem repetição. */
const normalizeTags = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? [...new Set(value.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : t)))]
    : value;
/** "a,b" ou ["a","b"] → ["a","b"] (query string). */
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value;

const TAG = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,49}$/u;
const MAX_BODY = 50_000;

/** `undefined` = não mexe; o validador roda inclusive para `null` (campo obrigatório não pode ser limpo). */
const Present = () => ValidateIf((_o, v) => v !== undefined);

// ---------------------------------------------------------------------------
// listagem

export class ListTicketsQuery {
  @ApiPropertyOptional({ description: 'IDs de status e/ou tipos (open, pending, on_hold, resolved, closed), separados por vírgula' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(new RegExp(`^(${STATUS_KINDS.join('|')}|[0-9a-f-]{36})$`, 'i'), { each: true, message: 'status inválido' })
  status?: string[];

  @ApiPropertyOptional({ description: '"me", "none" ou ID do responsável' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== 'me' && v !== 'none')
  @IsUUID('all', { message: 'use "me", "none" ou o ID do responsável' })
  assignee?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID('all') queue?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') category?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') priority?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') organization?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') requester?: string;

  @ApiPropertyOptional({ enum: SLA_FILTERS })
  @IsOptional()
  @IsIn(SLA_FILTERS)
  sla?: SlaFilter;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(50)
  tag?: string;

  @ApiPropertyOptional({ description: 'Busca no assunto/descrição (full-text em português) ou pelo número (#123)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() createdFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() createdTo?: string;

  @ApiPropertyOptional({ enum: TICKET_SORTS, default: 'updated' })
  @IsOptional()
  @IsIn(TICKET_SORTS)
  sort: TicketSort = 'updated';

  @ApiPropertyOptional({ default: 25, maximum: MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;
}

// ---------------------------------------------------------------------------
// criação / edição

export class CreateTicketDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  subject: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BODY)
  description?: string;

  @ApiPropertyOptional({ description: 'Equipe: abrir em nome de um cliente. Cliente: omitido (é ele mesmo).' })
  @IsOptional()
  @IsUUID('all')
  requesterId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID('all') categoryId?: string;
  // os campos abaixo só valem para a equipe; para o cliente são descartados (e o banco também os ignora)
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') priorityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') statusId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') queueId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') assigneeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') organizationId?: string;

  @ApiPropertyOptional({ enum: TICKET_CHANNELS })
  @IsOptional()
  @IsIn(TICKET_CHANNELS)
  channel?: TicketChannel;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG, { each: true, message: 'tag inválida (letras, números, "-", "_" ou ".")' })
  tags?: string[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateTicketDto {
  @ApiPropertyOptional()
  @Present()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  subject?: string;

  @ApiPropertyOptional()
  @Present()
  @IsString()
  @MaxLength(MAX_BODY)
  description?: string;

  @ApiPropertyOptional() @Present() @IsUUID('all') statusId?: string;
  @ApiPropertyOptional() @Present() @IsUUID('all') priorityId?: string;

  // anuláveis: `null` limpa o campo
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') assigneeId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') queueId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') categoryId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') organizationId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @Present()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG, { each: true, message: 'tag inválida (letras, números, "-", "_" ou ".")' })
  tags?: string[];

  @ApiPropertyOptional({ type: Object })
  @Present()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class BulkChangesDto {
  @ApiPropertyOptional() @Present() @IsUUID('all') statusId?: string;
  @ApiPropertyOptional() @Present() @IsUUID('all') priorityId?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') assigneeId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') queueId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') categoryId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG, { each: true, message: 'tag inválida' })
  addTags?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG, { each: true, message: 'tag inválida' })
  removeTags?: string[];
}

export class BulkUpdateDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];

  @ApiProperty({ type: BulkChangesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => BulkChangesDto)
  changes: BulkChangesDto;
}

// ---------------------------------------------------------------------------
// mensagens e horas

export class CreateMessageDto {
  @ApiProperty({ enum: ['public_reply', 'internal_note'] })
  @IsIn(['public_reply', 'internal_note'])
  kind: 'public_reply' | 'internal_note';

  @ApiProperty()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? '' : value))
  @MinLength(1)
  @MaxLength(MAX_BODY)
  body: string;
}

export class CreateTimeEntryDto {
  @ApiProperty({ minimum: 1, maximum: 1440 })
  @IsInt()
  @Min(1)
  @Max(1440)
  minutes: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD (padrão: hoje)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'use o formato AAAA-MM-DD' })
  @IsISO8601({ strict: true })
  workedOn?: string;
}
