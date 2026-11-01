import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { AutomationsProcessor } from './automations.processor.js';
import { MailerService } from './mailer.service.js';
import { OutboxProcessor } from './outbox.processor.js';
import { SlaJobs } from './sla.jobs.js';
import { WorkerConfig } from './worker-config.js';
import { WorkerDbService } from './worker-db.service.js';
import { validateWorkerEnv } from './worker-env.js';
import { WorkerScheduler } from './worker.scheduler.js';

/** Peças do worker sem o agendador (os testes usam direto). */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ envFilePath: ['.env', '../.env'], validate: validateWorkerEnv, cache: true }),
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: {
          level: process.env.LOG_LEVEL ?? 'info',
          base: { service: 'worker' },
          transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        },
      }),
    }),
  ],
  providers: [WorkerConfig, WorkerDbService, MailerService, OutboxProcessor, AutomationsProcessor, SlaJobs],
  exports: [WorkerConfig, WorkerDbService, MailerService, OutboxProcessor, AutomationsProcessor, SlaJobs],
})
export class WorkerCoreModule {}

/** Processo do worker: núcleo + agendamento. Nunca importado pelo AppModule (HTTP). */
@Module({
  imports: [WorkerCoreModule, ScheduleModule.forRoot()],
  providers: [WorkerScheduler],
})
export class WorkerModule {}
