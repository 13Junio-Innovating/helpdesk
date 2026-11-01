import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';

/** Normaliza lista de tags: minúsculas, sem espaços nas pontas, sem repetição. */
export const NormalizeTags = () =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? [...new Set(value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)))]
      : value,
  );

export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    return Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/** Fuso IANA válido (ex.: America/Sao_Paulo). */
export function IsTimeZone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isTimeZone',
      target: object.constructor,
      propertyName,
      options: { message: 'Fuso horário inválido (use o formato IANA, ex.: America/Sao_Paulo).', ...options },
      validator: { validate: isValidTimeZone },
    });
}

/** Para @ValidateIf: campos nulos são "limpar" e ausentes são "não mexer" (nenhum dos dois é validado). */
export const nullableIf = (_o: object, v: unknown) => v !== null && v !== undefined;
