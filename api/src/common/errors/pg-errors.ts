import type { ErrorCode } from '@helpdesk/shared';

export interface MappedError {
  status: number;
  code: ErrorCode;
  message: string;
}

/** Forma mínima de um erro do driver `pg` (DatabaseError). */
export interface PgLikeError {
  code: string;
  message: string;
  constraint?: string;
}

export function isPgError(e: unknown): e is PgLikeError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((e as { code: string }).code) &&
    'severity' in e
  );
}

const QUOTA: Record<string, MappedError> = {
  ticket_quota_exceeded: {
    status: 402,
    code: 'ticket_quota_exceeded',
    message: 'O limite de chamados do seu plano neste mês foi atingido. Faça upgrade para continuar.',
  },
  agent_limit_reached: {
    status: 402,
    code: 'agent_limit_reached',
    message: 'O limite de agentes do seu plano foi atingido. Faça upgrade para adicionar mais agentes.',
  },
  tenant_inactive: {
    status: 402,
    code: 'tenant_inactive',
    message: 'Esta conta está suspensa ou cancelada. Regularize a assinatura para continuar.',
  },
};

/**
 * Traduz SQLSTATE + mensagem do banco em resposta HTTP. As mensagens de negócio
 * (ex.: 'ticket_quota_exceeded') são as usadas nos RAISE das migrations 006/007/010.
 */
export function mapPgError(e: PgLikeError): MappedError {
  switch (e.code) {
    case '42501':
      return { status: 403, code: 'forbidden', message: 'Você não tem permissão para esta ação.' };
    case '23503':
      if (e.message.startsWith('update or delete on table')) {
        return { status: 409, code: 'in_use', message: 'Este registro está em uso e não pode ser removido.' };
      }
      return { status: 422, code: 'invalid_reference', message: 'Um dos registros referenciados não existe ou não está disponível.' };
    case '23505':
      if (e.message === 'email_already_registered') {
        return { status: 409, code: 'email_already_registered', message: 'Este e-mail já está cadastrado. Entre com sua conta.' };
      }
      if (e.constraint === 'tenants_slug_key') {
        return { status: 409, code: 'slug_taken', message: 'Este endereço de workspace já está em uso.' };
      }
      return { status: 409, code: 'conflict', message: 'Já existe um registro com estes dados.' };
    case '23514': {
      const quota = QUOTA[e.message];
      if (quota) return quota;
      if (e.message === 'assignee_must_be_staff') {
        return { status: 422, code: 'assignee_must_be_staff', message: 'O responsável precisa ser um membro ativo da equipe.' };
      }
      return { status: 422, code: 'invalid_value', message: 'Algum valor informado não é válido.' };
    }
    case '23502':
    case '22001':
    case '22003':
    case '22007':
    case '22008':
      return { status: 422, code: 'invalid_value', message: 'Algum valor informado não é válido.' };
    case '22P02':
      return { status: 400, code: 'bad_request', message: 'Requisição inválida.' };
    case 'P0002':
      if (e.message === 'invitation_invalid_or_expired') {
        return { status: 410, code: 'invitation_invalid', message: 'Este convite é inválido, já foi usado ou expirou.' };
      }
      if (e.message === 'reset_token_invalid') {
        return { status: 410, code: 'reset_token_invalid', message: 'Este link de redefinição é inválido, já foi usado ou expirou.' };
      }
      return { status: 404, code: 'not_found', message: 'Registro não encontrado.' };
    case '28000':
      return { status: 401, code: 'session_invalid', message: 'Sua sessão não é mais válida. Entre novamente.' };
    default:
      return { status: 500, code: 'internal_error', message: 'Erro interno. Tente novamente em instantes.' };
  }
}
