import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AppConfig } from '../config/app-config.js';
import { AppError } from '../common/errors/app-error.js';

/** bcrypt só considera os primeiros 72 bytes: senhas maiores seriam truncadas em silêncio. */
const BCRYPT_MAX_BYTES = 72;

@Injectable()
export class PasswordService {
  private readonly cost: number;
  /** Hash descartável para gastar o mesmo tempo quando o e-mail não existe (evita enumeração). */
  private readonly dummyHash: string;

  constructor(config: AppConfig) {
    this.cost = config.get('BCRYPT_COST');
    this.dummyHash = bcrypt.hashSync('timing-equalizer-not-a-password', this.cost);
  }

  async hash(password: string): Promise<string> {
    if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
      throw new AppError(400, 'password_too_long', 'A senha é longa demais (máximo de 72 bytes).');
    }
    return bcrypt.hash(password, this.cost);
  }

  /** Sempre executa uma comparação bcrypt, exista ou não um hash. */
  async verify(password: string, hash: string | null | undefined): Promise<boolean> {
    const ok = await bcrypt.compare(password, hash ?? this.dummyHash);
    return ok && !!hash;
  }
}
