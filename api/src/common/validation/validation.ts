import { ValidationPipe, type ValidationError } from '@nestjs/common';
import type { ValidationIssue } from '@helpdesk/shared';
import { AppException } from '../errors/app-exception.js';

/** Mensagens pt-BR por tipo de restrição do class-validator (as padrão vêm em inglês). */
const MESSAGES: Record<string, string> = {
  whitelistValidation: 'campo não permitido',
  isUuid: 'identificador inválido',
  isEmail: 'e-mail inválido',
  isString: 'deve ser um texto',
  isNotEmpty: 'obrigatório',
  minLength: 'muito curto',
  maxLength: 'muito longo',
  isInt: 'deve ser um número inteiro',
  min: 'valor abaixo do mínimo',
  max: 'valor acima do máximo',
  isIn: 'valor não permitido',
  isEnum: 'valor não permitido',
  isArray: 'deve ser uma lista',
  arrayMinSize: 'lista vazia',
  arrayMaxSize: 'lista grande demais',
  arrayUnique: 'itens repetidos',
  isDateString: 'data inválida',
  isISO8601: 'data inválida',
  isBoolean: 'deve ser verdadeiro ou falso',
  isObject: 'deve ser um objeto',
  matches: 'formato inválido',
  isNotIn: 'valor não permitido',
};

function flatten(errors: ValidationError[], prefix = ''): ValidationIssue[] {
  return errors.flatMap((e) => {
    const field = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.entries(e.constraints ?? {}).map(([key, original]) => {
      // mensagens padrão do class-validator começam com o nome do campo; as nossas (personalizadas) não
      const isDefault = original.startsWith(`${e.property} `) || original.startsWith('each value in ') || original.startsWith('property ');
      return { field, message: isDefault ? MESSAGES[key] ?? 'valor inválido' : original };
    });
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppException(400, 'validation_failed', 'Verifique os campos informados.', flatten(errors)),
  });
}
