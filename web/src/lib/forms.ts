import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api';

/** Leva os erros de validação da API (details[].field) para os campos do formulário. Devolve a mensagem geral. */
export function applyApiErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>, fields: ReadonlyArray<Path<T>>): string {
  if (!(err instanceof ApiError)) return 'Erro inesperado. Tente novamente.';
  for (const issue of err.fieldErrors) {
    if ((fields as readonly string[]).includes(issue.field)) setError(issue.field as Path<T>, { message: issue.message });
  }
  return err.message;
}
