import { Transform } from 'class-transformer';

/** Normaliza lista de tags: minúsculas, sem espaços nas pontas, sem repetição. */
export const NormalizeTags = () =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? [...new Set(value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)))]
      : value,
  );

export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
