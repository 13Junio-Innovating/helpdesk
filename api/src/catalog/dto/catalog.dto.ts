import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { AUTOMATION_EVENTS, STATUS_KINDS, type AutomationEvent, type StatusKind } from '@helpdesk/shared';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

@ValidatorConstraint({ name: 'isTimeZone' })
class IsTimeZone implements ValidatorConstraintInterface {
  private static readonly zones = new Set(Intl.supportedValuesOf('timeZone'));
  validate(value: unknown): boolean {
    return typeof value === 'string' && (IsTimeZone.zones.has(value) || value === 'UTC');
  }
  defaultMessage(): string {
    return 'fuso horário inválido (ex.: America/Sao_Paulo)';
  }
}
export const TimeZoneField = () => Validate(IsTimeZone);

class NameField {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

// ---------- filas ----------
export class CreateQueueDto extends NameField {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) description?: string | null;
}
export class UpdateQueueDto extends PartialType(CreateQueueDto) {}

export class SetQueueMembersDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  userIds: string[];
}

// ---------- categorias ----------
export class CreateCategoryDto extends NameField {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') parentId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') defaultQueueId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

// ---------- prioridades ----------
export class CreatePriorityDto extends NameField {
  @ApiProperty({ minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) level: number;
  @ApiPropertyOptional() @IsOptional() @Matches(COLOR, { message: 'cor no formato #RRGGBB' }) color?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}
export class UpdatePriorityDto extends PartialType(CreatePriorityDto) {}

// ---------- status ----------
export class CreateStatusDto extends NameField {
  @ApiProperty({ enum: STATUS_KINDS }) @IsIn(STATUS_KINDS) kind: StatusKind;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() slaPauses?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) position?: number;
  @ApiPropertyOptional() @IsOptional() @Matches(COLOR, { message: 'cor no formato #RRGGBB' }) color?: string;
}
export class UpdateStatusDto extends PartialType(CreateStatusDto) {}

// ---------- horário comercial ----------
export class CreateBusinessHoursDto extends NameField {
  @ApiPropertyOptional({ example: 'America/Sao_Paulo' }) @IsOptional() @TimeZoneField() timezone?: string;
}
export class UpdateBusinessHoursDto extends PartialType(CreateBusinessHoursDto) {}

export class SlotDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo' }) @IsInt() @Min(0) @Max(6) weekday: number;
  @ApiProperty({ example: '08:00' }) @Matches(TIME, { message: 'horário no formato HH:MM' }) startTime: string;
  @ApiProperty({ example: '12:00' }) @Matches(TIME, { message: 'horário no formato HH:MM' }) endTime: string;
}

export class SetSlotsDto {
  @ApiProperty({ type: [SlotDto] })
  @IsArray()
  @ArrayMaxSize(70)
  @ValidateNested({ each: true })
  @Type(() => SlotDto)
  slots: SlotDto[];
}

export class CreateHolidayDto {
  @ApiProperty({ example: '2026-12-25' }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'data no formato AAAA-MM-DD' }) date: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(100) name?: string;
}

// ---------- políticas de SLA ----------
export class CreateSlaPolicyDto extends NameField {
  @ApiPropertyOptional({ nullable: true, description: 'null = política padrão (fallback)' }) @IsOptional() @IsUUID('all') priorityId?: string | null;
  @ApiProperty() @IsInt() @Min(1) @Max(525_600) firstResponseMinutes: number;
  @ApiProperty() @IsInt() @Min(1) @Max(525_600) resolutionMinutes: number;
  @ApiPropertyOptional({ nullable: true, description: 'null = 24x7' }) @IsOptional() @IsUUID('all') businessHoursId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateSlaPolicyDto extends PartialType(CreateSlaPolicyDto) {}

// ---------- automações ----------
export class CreateAutomationRuleDto extends NameField {
  @ApiProperty({ enum: AUTOMATION_EVENTS }) @IsIn(AUTOMATION_EVENTS) event: AutomationEvent;
  @ApiProperty({ type: 'array', items: { type: 'object' } }) @IsArray() @ArrayMaxSize(20) conditions: unknown[];
  @ApiProperty({ type: 'array', items: { type: 'object' } }) @IsArray() @ArrayMaxSize(10) actions: unknown[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10_000) position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateAutomationRuleDto extends PartialType(CreateAutomationRuleDto) {}
