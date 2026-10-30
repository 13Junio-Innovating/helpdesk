import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { WorkerEnv } from './worker.env.js';
import { SlaJob } from './sla.job.js';
import { OutboxJob } from './email/outbox.job.js';
import { AutomationJob } from './automation/automation.job.js';

/**
 * Registra os jobs em intervalos configuráveis. Um job nunca roda sobreposto a si mesmo
 * (se a execução anterior ainda não terminou, a rodada é pulada). Intervalo 0 desliga o job.
 */
@Injectable()
export class WorkerScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerScheduler.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService<WorkerEnv, true>,
    private readonly sla: SlaJob,
    private readonly outbox: OutboxJob,
    private readonly automation: AutomationJob,
  ) {}

  onApplicationBootstrap(): void {
    this.every('sla', this.config.get('WORKER_SLA_INTERVAL_MS', { infer: true }), () => this.sla.runOnce());
    this.every('email', this.config.get('WORKER_EMAIL_INTERVAL_MS', { infer: true }), () => this.outbox.runOnce());
    this.every('automation', this.config.get('WORKER_AUTOMATION_INTERVAL_MS', { infer: true }), () => this.automation.runOnce());
  }

  onApplicationShutdown(): void {
    for (const name of this.registry.getIntervals()) this.registry.deleteInterval(name);
  }

  private every(name: string, ms: number, job: () => Promise<unknown>): void {
    if (ms <= 0) {
      this.logger.log(`job "${name}" desligado`);
      return;
    }
    const tick = async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (e) {
        this.logger.error(`job "${name}" falhou: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.running.delete(name);
      }
    };
    this.registry.addInterval(name, setInterval(() => void tick(), ms));
    void tick(); // primeira rodada já no boot
    this.logger.log(`job "${name}" a cada ${ms} ms`);
  }
}
