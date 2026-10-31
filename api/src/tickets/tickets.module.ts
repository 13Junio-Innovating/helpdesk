import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';
import { AttachmentsController, AttachmentsService } from './attachments.js';

@Module({ controllers: [TicketsController, AttachmentsController], providers: [TicketsService, AttachmentsService] })
export class TicketsModule {}
