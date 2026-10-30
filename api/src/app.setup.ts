import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

/** Configuração HTTP compartilhada entre main.ts e os testes e2e (os testes exercitam o mesmo pipeline). */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const trustProxy = config.get('TRUST_PROXY', { infer: true });

  app.useLogger(app.get(Logger));
  app.set('trust proxy', trustProxy === 'false' ? false : trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: config.get('BODY_LIMIT', { infer: true }) });
  app.useBodyParser('urlencoded', { limit: config.get('BODY_LIMIT', { infer: true }), extended: false });
  app.enableCors({
    origin: config.get('CORS_ORIGIN', { infer: true }).split(',').map((o) => o.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['docs'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = new DocumentBuilder().setTitle('Helpdesk API').setVersion('0.1').addBearerAuth().build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
  }
  return app;
}
