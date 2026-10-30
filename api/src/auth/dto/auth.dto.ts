import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotIn, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const RESERVED_SLUGS = ['www', 'api', 'admin', 'app'];
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export class LoginDto {
  @ApiProperty({ example: 'admin@demo.local' })
  @Transform(lowerTrim)
  @IsEmail({}, { message: 'e-mail inválido' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'demo1234' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}

export class SelectTenantDto {
  @ApiProperty()
  @IsUUID('4', { message: 'workspace inválido' })
  tenantId: string;
}

export class SignupDto {
  @ApiProperty({ example: 'Minha Empresa' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  workspaceName: string;

  @ApiProperty({ example: 'minha-empresa' })
  @Transform(lowerTrim)
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'endereço deve ter 3 a 40 caracteres: letras minúsculas, números e hífen' })
  @IsNotIn(RESERVED_SLUGS, { message: 'este endereço é reservado' })
  slug: string;

  @ApiProperty({ example: 'Ana Silva' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'ana@empresa.com' })
  @Transform(lowerTrim)
  @IsEmail({}, { message: 'e-mail inválido' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'a senha precisa ter pelo menos 8 caracteres' })
  @MaxLength(72, { message: 'a senha pode ter no máximo 72 caracteres' }) // limite do bcrypt
  password: string;
}

export class AcceptInviteDto {
  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'a senha precisa ter pelo menos 8 caracteres' })
  @MaxLength(72)
  password: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @Transform(lowerTrim)
  @IsEmail({}, { message: 'e-mail inválido' })
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'a senha precisa ter pelo menos 8 caracteres' })
  @MaxLength(72)
  password: string;
}
