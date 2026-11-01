import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsHexColor, IsIn, IsInt, IsOptional, IsString, IsUUID, Length,
  Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { IsTimeZone, nullableIf, Trim } from '../../common/http/validators.js';

const Name = (max = 80) => (target: object, key: string) => {
  Trim()(target, key);
  IsString()(target, key);
  Length(1, max, { message: `O nome deve ter entre 1 e ${max} caracteres.` })(target, key);
};

// ---------- filas ----------
export class CreateQueueDto {
  @Name() name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
export class UpdateQueueDto extends PartialType(CreateQueueDto) {}

export class SetQueueMembersDto {
  @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) userIds: string[];
}

// ---------- categorias ----------
export class CreateCategoryDto {
  @Name() name: string;
  @ValidateIf(nullableIf) @IsUUID() parentId?: string | null;
  @ValidateIf(nullableIf) @IsUUID() defaultQueueId?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

// ---------- prioridades ----------
export class CreatePriorityDto {
  @Name(40) name: string;
  @IsInt() @Min(1) @Max(10) level: number;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
export class UpdatePriorityDto extends PartialType(CreatePriorityDto) {}

// ---------- status ----------
export const STATUS_KINDS = ['open', 'pending', 'on_hold', 'resolved', 'closed'] as const;
export class CreateStatusDto {
  @Name(40) name: string;
  @IsIn(STATUS_KINDS) kind: (typeof STATUS_KINDS)[number];
  @IsOptional() @IsBoolean() slaPauses?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) position?: number;
  @IsOptional() @IsHexColor() color?: string;
}
export class UpdateStatusDto extends PartialType(CreateStatusDto) {}

// ---------- horário comercial ----------
export class CreateBusinessHoursDto {
  @Name() name: string;
  @IsOptional() @IsTimeZone() timezone?: string;
}
export class UpdateBusinessHoursDto extends PartialType(CreateBusinessHoursDto) {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export class SlotDto {
  @IsInt() @Min(0) @Max(6) weekday: number;
  @Matches(HHMM, { message: 'Use HH:MM.' }) start: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, { message: 'Use HH:MM.' }) end: string;
}
export class SetSlotsDto {
  @IsArray() @ArrayMaxSize(70) @ValidateNested({ each: true }) @Type(() => SlotDto) slots: SlotDto[];
}
export class CreateHolidayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use o formato AAAA-MM-DD.' }) date: string;
  @IsOptional() @Trim() @IsString() @MaxLength(80) name?: string;
}

// ---------- políticas de SLA ----------
export class CreateSlaPolicyDto {
  @Name() name: string;
  @ValidateIf(nullableIf) @IsUUID() priorityId?: string | null;
  @IsInt() @Min(1) @Max(525600) firstResponseMinutes: number;
  @IsInt() @Min(1) @Max(525600) resolutionMinutes: number;
  @ValidateIf(nullableIf) @IsUUID() businessHoursId?: string | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateSlaPolicyDto extends PartialType(CreateSlaPolicyDto) {}

// ---------- automações (formato validado no service, ver automation-rules.ts) ----------
export const AUTOMATION_EVENTS = ['ticket_created', 'ticket_updated', 'sla_warning', 'sla_breached'] as const;
export class CreateAutomationRuleDto {
  @Name(120) name: string;
  @IsIn(AUTOMATION_EVENTS) event: (typeof AUTOMATION_EVENTS)[number];
  @IsArray() @ArrayMaxSize(20) conditions: unknown[];
  @IsArray() @ArrayMaxSize(20) actions: unknown[];
  @IsOptional() @IsInt() @Min(0) @Max(10000) position?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateAutomationRuleDto extends PartialType(CreateAutomationRuleDto) {}

// ---------- organizações (clientes) ----------
export class CreateOrganizationDto {
  @Name(120) name: string;
  @ValidateIf(nullableIf) @IsString() @MaxLength(32) document?: string | null;
  @ValidateIf(nullableIf) @IsString() @MaxLength(2000) notes?: string | null;
}
export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {}
