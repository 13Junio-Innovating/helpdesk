import { Module } from '@nestjs/common';
import { CATALOG_CONTROLLERS } from './catalog.controllers.js';
import { CatalogExtrasService } from './catalog-extras.service.js';
import { CatalogService } from './catalog.service.js';

@Module({ controllers: CATALOG_CONTROLLERS, providers: [CatalogService, CatalogExtrasService] })
export class CatalogModule {}
