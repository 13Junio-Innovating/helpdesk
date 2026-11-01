import { Module } from '@nestjs/common';
import { MacrosController } from './macros.controller.js';
import { MacrosService } from './macros.service.js';

@Module({ controllers: [MacrosController], providers: [MacrosService] })
export class MacrosModule {}
