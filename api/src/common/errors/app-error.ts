import { HttpException } from '@nestjs/common';

/** Erro de negócio com `code` estável (consumido pelo front) e mensagem em pt-BR. */
export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, ...(details === undefined ? {} : { details }) }, status);
  }
}
