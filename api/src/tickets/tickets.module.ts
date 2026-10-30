import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';

@Module({ controllers: [TicketsController], providers: [TicketsService] })
export class TicketsModule {}
