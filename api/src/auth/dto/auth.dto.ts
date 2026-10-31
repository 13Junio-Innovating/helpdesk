import { Transform } from 'class-transformer';
import { IsEmail, IsNotIn, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const RESERVED_SLUGS = ['www', 'api', 'admin', 'app'];
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export class LoginDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'E-mail inválido.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @Length(1, 128)
  password: string;
}

export class SelectTenantDto {
  @IsUUID('all', { message: 'Workspace inválido.' })
  tenantId: string;
}

export class SignupDto {
  @Transform(trim)
  @IsString()
  @Length(2, 80, { message: 'O nome do workspace deve ter entre 2 e 80 caracteres.' })
  workspaceName: string;

  @Transform(normalizeEmail)
  @Matches(SLUG_PATTERN, {
    message: 'Endereço inválido: use 3 a 40 letras minúsculas, números ou hífens (sem hífen nas pontas).',
  })
  @IsNotIn(RESERVED_SLUGS, { message: 'Este endereço é reservado.' })
  slug: string;

  @Transform(trim)
  @IsString()
  @Length(2, 120, { message: 'Informe seu nome (2 a 120 caracteres).' })
  name: string;

  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'E-mail inválido.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8, { message: 'A senha deve ter pelo menos 8 caracteres.' })
  @MaxLength(128)
  password: string;
}
