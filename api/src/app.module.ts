import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { AuthCoreModule } from './common/auth/auth-core.module.js';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard.js';
import { RolesGuard } from './common/auth/roles.guard.js';
import { DbModule } from './common/db/db.module.js';
import { throttlerOptions } from './common/http/throttling.js';
import { AppConfig } from './config/app-config.js';
import { ConfigCoreModule } from './config/config-core.module.js';
import { HealthModule } from './health/health.module.js';
import { TicketsModule } from './tickets/tickets.module.js';

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

@Module({
  imports: [
    ConfigCoreModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          customProps: (req) => ({ requestId: req.id }),
          // nunca logar credenciais: cabeçalhos de auth/cookie e qualquer campo sensível
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.password_hash',
              '*.token',
              '*.accessToken',
              '*.refreshToken',
            ],
            censor: '[redacted]',
          },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          transport: config.get('NODE_ENV') === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({ inject: [AppConfig], useFactory: throttlerOptions }),
    DbModule,
    AuthCoreModule,
    HealthModule,
    AuthModule,
    TicketsModule,
  ],
  providers: [
    // ordem importa: limite de tentativas -> autenticação -> papel
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
