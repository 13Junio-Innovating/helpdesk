import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import type { Env } from '../config/env.js';

@Injectable()
export class PasswordService implements OnModuleInit {
  private readonly cost: number;
  /** Hash descartável: login com e-mail inexistente gasta o mesmo tempo de um bcrypt real. */
  private dummyHash = '';

  constructor(config: ConfigService<Env, true>) {
    this.cost = config.get('BCRYPT_COST', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    this.dummyHash = await bcrypt.hash('dummy-password-for-timing', this.cost);
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cost);
  }

  /** Sempre executa um compare, mesmo sem hash (usuário inexistente ou convidado sem senha). */
  async verify(plain: string, hash: string | null | undefined): Promise<boolean> {
    const ok = await bcrypt.compare(plain, hash ?? this.dummyHash);
    return ok && !!hash;
  }
}
