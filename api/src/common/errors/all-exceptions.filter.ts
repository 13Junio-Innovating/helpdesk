import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import type { ApiError, ErrorCode } from '@helpdesk/shared';
import { AppException } from './app-exception.js';
import { isPgError, mapPgError } from './pg-errors.js';

const STATUS_CODES: Partial<Record<number, { code: ErrorCode; message: string }>> = {
  400: { code: 'bad_request', message: 'Requisição inválida.' },
  401: { code: 'unauthorized', message: 'Autenticação necessária.' },
  403: { code: 'forbidden', message: 'Você não tem permissão para esta ação.' },
  404: { code: 'not_found', message: 'Recurso não encontrado.' },
  409: { code: 'conflict', message: 'Conflito com o estado atual do recurso.' },
  413: { code: 'bad_request', message: 'Conteúdo grande demais.' },
  503: { code: 'service_unavailable', message: 'Serviço temporariamente indisponível.' },
  429: { code: 'too_many_requests', message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
};

/**
 * Ponto único de tradução de erros. Nunca devolve SQLERRM/stack ao cliente:
 * o detalhe vai para o log (com requestId), o cliente recebe `{ code, message }`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    } else if (isPgError(exception)) {
      this.logger.warn(`pg ${exception.code}: ${exception.message}`);
    }
    if (!res.headersSent) res.status(status).json(body);
  }

  private toResponse(e: unknown): { status: number; body: ApiError } {
    if (e instanceof AppException) {
      return { status: e.getStatus(), body: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
    }
    if (e instanceof ThrottlerException) {
      const t = STATUS_CODES[429]!;
      return { status: 429, body: t };
    }
    if (isPgError(e)) {
      const m = mapPgError(e);
      return { status: m.status, body: { code: m.code, message: m.message } };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const resp = e.getResponse();
      // ValidationPipe: { message: string[] }
      if (status === 400 && typeof resp === 'object' && resp !== null && Array.isArray((resp as { message?: unknown }).message)) {
        return {
          status,
          body: { code: 'validation_failed', message: 'Verifique os campos informados.', details: (resp as { message: string[] }).message },
        };
      }
      const known = STATUS_CODES[status] ?? { code: 'internal_error' as const, message: 'Erro inesperado.' };
      return { status, body: known };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'internal_error', message: 'Erro interno. Tente novamente em instantes.' },
    };
  }
}
