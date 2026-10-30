import { HttpException } from '@nestjs/common';
import type { ErrorCode } from '@helpdesk/shared';

/** Erro de domínio com `code` estável; o filtro global o converte em `{ code, message }`. */
export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
