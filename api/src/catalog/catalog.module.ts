import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogAdminService } from './catalog-admin.service.js';

@Module({ controllers: [CatalogController], providers: [CatalogAdminService] })
export class CatalogModule {}
