import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';
import { TimeEntriesController } from './time-entries.controller.js';
import { TimeEntriesService } from './time-entries.service.js';

@Module({
  controllers: [TicketsController, TimeEntriesController],
  providers: [TicketsService, TimeEntriesService],
  exports: [TicketsService],
})
export class TicketsModule {}
