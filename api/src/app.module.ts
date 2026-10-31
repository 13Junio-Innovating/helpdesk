import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { validateEnv, type Env } from './config/env.js';
import { DbModule } from './common/db/db.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard.js';
import { throttleOptions } from './common/throttle/throttle.config.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { TeamModule } from './team/team.module.js';
import { KbModule } from './kb/kb.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { StorageModule } from './storage/storage.module.js';
import { BillingModule } from './billing/billing.module.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv, ignoreEnvFile: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: (req: IncomingMessage) => {
            const incoming = req.headers['x-request-id'];
            return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
          },
          // nunca registrar credenciais: cabeçalhos de auth, cookies e campos sensíveis
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.password_hash'],
            censor: '[redacted]',
          },
          customProps: (req: IncomingMessage) => ({ requestId: (req as IncomingMessage & { id?: unknown }).id }),
          autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/api/v1/health') ?? false },
        },
      }),
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256', issuer: 'helpdesk-api', audience: 'helpdesk' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'helpdesk-api', audience: 'helpdesk' },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        throttleOptions({
          THROTTLE_DEFAULT_LIMIT: config.get('THROTTLE_DEFAULT_LIMIT', { infer: true }),
          THROTTLE_AUTH_TTL_SECONDS: config.get('THROTTLE_AUTH_TTL_SECONDS', { infer: true }),
          THROTTLE_AUTH_IP_LIMIT: config.get('THROTTLE_AUTH_IP_LIMIT', { infer: true }),
          THROTTLE_AUTH_EMAIL_LIMIT: config.get('THROTTLE_AUTH_EMAIL_LIMIT', { infer: true }),
        }),
    }),
    DbModule,
    StorageModule,
    HealthModule,
    AuthModule,
    CatalogModule,
    TicketsModule,
    TeamModule,
    KbModule,
    ReportsModule,
    TenantsModule,
    BillingModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
