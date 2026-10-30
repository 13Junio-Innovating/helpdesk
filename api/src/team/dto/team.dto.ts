import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { MEMBER_ROLES, type MemberRole } from '@helpdesk/shared';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class ListMembersQuery {
  @ApiPropertyOptional({ enum: MEMBER_ROLES }) @IsOptional() @IsIn(MEMBER_ROLES) role?: MemberRole;
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') organization?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) q?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: MEMBER_ROLES }) @IsOptional() @IsIn(MEMBER_ROLES) role?: MemberRole;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID('all') organizationId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) jobTitle?: string | null;
}

export class CreateInvitationDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @ApiProperty({ enum: MEMBER_ROLES }) @IsIn(MEMBER_ROLES) role: MemberRole;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') organizationId?: string;
}

export class CreateOrganizationDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) name: string;
  @ApiPropertyOptional({ nullable: true, description: 'CNPJ' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(30) document?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(5000) notes?: string | null;
}
export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {}

export class ListOrganizationsQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) q?: string;
}

