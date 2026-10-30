import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { validateWorkerEnv, type WorkerEnv } from './worker.env.js';
import { WorkerDbService } from './worker-db.service.js';
import { MailerService } from './email/mailer.service.js';
import { OutboxJob } from './email/outbox.job.js';
import { SlaJob } from './sla.job.js';
import { AutomationJob } from './automation/automation.job.js';
import { WorkerScheduler } from './worker.scheduler.js';

/** Jobs sem o agendador: usado pelos testes para chamar runOnce() diretamente. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateWorkerEnv, ignoreEnvFile: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>) => ({
        pinoHttp: { level: config.get('LOG_LEVEL', { infer: true }), base: { service: 'worker' } },
      }),
    }),
  ],
  providers: [WorkerDbService, MailerService, OutboxJob, SlaJob, AutomationJob],
  exports: [WorkerDbService, MailerService, OutboxJob, SlaJob, AutomationJob],
})
export class WorkerJobsModule {}

@Module({
  imports: [WorkerJobsModule, ScheduleModule.forRoot()],
  providers: [WorkerScheduler],
})
export class WorkerModule {}
