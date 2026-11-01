import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from './worker-env.js';

@Injectable()
export class WorkerConfig {
  constructor(private readonly config: ConfigService<WorkerEnv, true>) {}

  get<K extends keyof WorkerEnv>(key: K): WorkerEnv[K] {
    return this.config.get(key, { infer: true });
  }
}
