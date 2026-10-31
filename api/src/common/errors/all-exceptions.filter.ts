import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isPgError, mapPgError } from './pg-errors.js';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

const DEFAULT_CODES: Record<number, ErrorBody> = {
  400: { code: 'bad_request', message: 'Requisição inválida.' },
  401: { code: 'unauthorized', message: 'Faça login para continuar.' },
  403: { code: 'forbidden', message: 'Você não tem permissão para esta ação.' },
  404: { code: 'not_found', message: 'Recurso não encontrado.' },
  413: { code: 'payload_too_large', message: 'Conteúdo grande demais.' },
  429: { code: 'too_many_requests', message: 'Muitas tentativas. Aguarde um pouco e tente de novo.' },
};

/**
 * Formato único de erro: `{ code, message, details? }`. Erros do Postgres são traduzidos pela
 * tabela de pg-errors.ts; nada de SQLERRM, stack ou nomes internos chega ao cliente.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const { status, body } = this.toResponse(exception, req);
    if (!res.headersSent) res.status(status).json(body);
  }

  private toResponse(exception: unknown, req: Request): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, body: this.fromHttpException(exception, status) };
    }

    if (isPgError(exception)) {
      const mapped = mapPgError(exception);
      if (mapped) {
        this.logger.warn({ sqlstate: exception.code, pgMessage: exception.message, path: req.path }, 'erro do banco');
        return { status: mapped.status, body: { code: mapped.code, message: mapped.message } };
      }
    }

    this.logger.error(
      { err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception, path: req.path },
      'erro não tratado',
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'internal_error', message: 'Erro inesperado. Tente novamente em instantes.' },
    };
  }

  private fromHttpException(exception: HttpException, status: number): ErrorBody {
    const raw = exception.getResponse();
    const fallback = DEFAULT_CODES[status] ?? { code: 'error', message: exception.message };
    if (typeof raw === 'object' && raw !== null) {
      const r = raw as { code?: unknown; message?: unknown; details?: unknown };
      if (typeof r.code === 'string') {
        return { code: r.code, message: String(r.message ?? fallback.message), details: r.details };
      }
      // ValidationPipe: { message: string[], error, statusCode }
      if (status === 400 && Array.isArray(r.message)) {
        return { code: 'validation_failed', message: 'Verifique os campos informados.', details: r.message };
      }
    }
    return fallback;
  }
}
