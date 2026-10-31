import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false, rawBody: true });
configureApp(app);
await app.listen(Number(process.env['PORT'] ?? 3000));
