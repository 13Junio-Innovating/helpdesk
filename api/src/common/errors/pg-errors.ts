export interface MappedError {
  status: number;
  code: string;
  message: string;
}

/** Mensagens levantadas pelo banco com RAISE EXCEPTION '<chave>' (ver migrations 006/007/010/012). */
const BY_MESSAGE: Record<string, MappedError> = {
  ticket_quota_exceeded: {
    status: 402,
    code: 'ticket_quota_exceeded',
    message: 'O limite de chamados do seu plano neste mês foi atingido.',
  },
  agent_limit_reached: {
    status: 402,
    code: 'agent_limit_reached',
    message: 'O limite de agentes do seu plano foi atingido. Faça upgrade para adicionar mais.',
  },
  tenant_inactive: {
    status: 402,
    code: 'tenant_inactive',
    message: 'Esta conta está suspensa ou cancelada.',
  },
  assignee_must_be_staff: {
    status: 422,
    code: 'assignee_must_be_staff',
    message: 'O responsável precisa ser um agente ou administrador ativo.',
  },
  email_already_registered: {
    status: 409,
    code: 'email_already_registered',
    message: 'Este e-mail já está cadastrado. Entre com sua conta.',
  },
  invitation_invalid_or_expired: {
    status: 410,
    code: 'invitation_invalid',
    message: 'Convite inválido, expirado ou já utilizado.',
  },
};

/** Violações de unicidade com significado próprio, pelo nome da constraint. */
const BY_CONSTRAINT: Record<string, MappedError> = {
  tenants_slug_key: { status: 409, code: 'slug_taken', message: 'Este endereço de workspace já está em uso.' },
};

const BY_SQLSTATE: Record<string, MappedError> = {
  '42501': { status: 403, code: 'forbidden', message: 'Você não tem permissão para esta ação.' },
  '23503': {
    status: 422,
    code: 'invalid_reference',
    message: 'Um dos registros informados não existe ou não pertence a este workspace.',
  },
  '23505': { status: 409, code: 'conflict', message: 'Já existe um registro com esses dados.' },
  '23514': { status: 422, code: 'constraint_violation', message: 'Os dados informados violam uma regra do sistema.' },
  '23502': { status: 422, code: 'missing_field', message: 'Um campo obrigatório não foi informado.' },
  '22023': { status: 400, code: 'invalid_parameter', message: 'Parâmetro inválido.' },
  '22P02': { status: 400, code: 'invalid_input', message: 'Formato de dado inválido.' },
  '22001': { status: 400, code: 'value_too_long', message: 'Um dos valores informados é longo demais.' },
  '22007': { status: 400, code: 'invalid_input', message: 'Data inválida.' },
  '22008': { status: 400, code: 'invalid_input', message: 'Data fora do intervalo permitido.' },
};

export interface PgLikeError {
  code: string;
  message: string;
  constraint?: string;
  severity?: string;
}

export function isPgError(err: unknown): err is PgLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code) &&
    'severity' in err
  );
}

const IN_USE: MappedError = {
  status: 409,
  code: 'in_use',
  message: 'Este registro está em uso e não pode ser removido. Desative-o ou mova o que depende dele antes.',
};

export function mapPgError(err: PgLikeError): MappedError | undefined {
  // 23503 serve para os dois lados da FK: apontar para algo inexistente OU apagar algo referenciado
  if (err.code === '23503' && err.message.startsWith('update or delete on table')) return IN_USE;
  return (
    BY_MESSAGE[err.message] ??
    (err.constraint ? BY_CONSTRAINT[err.constraint] : undefined) ??
    BY_SQLSTATE[err.code]
  );
}
