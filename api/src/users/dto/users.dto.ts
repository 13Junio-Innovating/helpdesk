import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { nullableIf, Trim } from '../../common/http/validators.js';

export const ROLES = ['admin', 'agent', 'requester'] as const;
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class ListMembersQuery {
  @IsOptional() @IsIn(ROLES) role?: (typeof ROLES)[number];
  /** `staff` = admin + agent. */
  @IsOptional() @IsIn(['staff']) group?: 'staff';
  @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
  @IsOptional() @IsUUID() organization?: string;
  @IsOptional() @IsString() @Length(1, 100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}

export class UpdateMemberDto {
  @IsOptional() @IsIn(ROLES) role?: (typeof ROLES)[number];
  @IsOptional() @IsBoolean() active?: boolean;
  @ValidateIf(nullableIf) @IsUUID() organizationId?: string | null;
  @ValidateIf(nullableIf) @Trim() @IsString() @MaxLength(40) phone?: string | null;
  @ValidateIf(nullableIf) @Trim() @IsString() @MaxLength(80) jobTitle?: string | null;
}

export class CreateInvitationDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'E-mail inválido.' }) @MaxLength(254)
  email: string;

  @IsIn(ROLES) role: (typeof ROLES)[number];
  @IsOptional() @IsUUID() organizationId?: string;
}

export class ListOrganizationsQuery {
  @IsOptional() @IsString() @Length(1, 100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}
