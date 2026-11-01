import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AutomationsProcessor } from './automations.processor.js';
import { OutboxProcessor } from './outbox.processor.js';
import { SlaJobs } from './sla.jobs.js';
import { WorkerConfig } from './worker-config.js';

/**
 * Agenda os jobs. Em cada instância um job nunca roda sobreposto a si mesmo; entre instâncias,
 * a segurança vem do banco (SKIP LOCKED, trava por evento, warned_at).
 */
@Injectable()
export class WorkerScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerScheduler.name);
  private readonly running = new Map<string, Promise<unknown>>();
  private stopping = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly config: WorkerConfig,
    private readonly outbox: OutboxProcessor,
    private readonly automations: AutomationsProcessor,
    private readonly sla: SlaJobs,
  ) {}

  onApplicationBootstrap(): void {
    this.every('outbox', this.config.get('OUTBOX_POLL_MS'), () => this.outbox.drain());
    this.every('automations', this.config.get('AUTOMATIONS_POLL_MS'), () => this.automations.drain());
    this.cron('sla', this.config.get('SLA_CRON'), async () => {
      await this.sla.markBreaches();
      await this.sla.warnNearDue();
    });
    this.cron('purge', this.config.get('PURGE_CRON'), () => this.sla.purge());
    this.logger.log('worker iniciado');
  }

  /** Executa `fn` se a mesma tarefa não estiver rodando nesta instância. Erros são logados, nunca derrubam o processo. */
  run(name: string, fn: () => Promise<unknown>): Promise<unknown> {
    if (this.stopping) return Promise.resolve();
    const current = this.running.get(name);
    if (current) return current;
    const p = fn()
      .catch((err: unknown) => this.logger.error({ job: name, error: err instanceof Error ? err.message : String(err) }, 'job falhou'))
      .finally(() => this.running.delete(name));
    this.running.set(name, p);
    return p;
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const name of this.registry.getIntervals()) this.registry.deleteInterval(name);
    for (const [name] of this.registry.getCronJobs()) this.registry.deleteCronJob(name);
    await Promise.allSettled(this.running.values()); // termina o que está em andamento antes de fechar o pool
  }

  private every(name: string, ms: number, fn: () => Promise<unknown>): void {
    this.registry.addInterval(name, setInterval(() => void this.run(name, fn), ms));
  }

  private cron(name: string, expr: string, fn: () => Promise<unknown>): void {
    const job = CronJob.from({ cronTime: expr, onTick: () => void this.run(name, fn), start: false });
    this.registry.addCronJob(name, job as never);
    job.start();
  }
}
