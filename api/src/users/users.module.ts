import { Module } from '@nestjs/common';
import { MembersService } from './members.service.js';
import { OrganizationsService } from './organizations.service.js';
import { MembersController, OrganizationsController } from './users.controllers.js';

@Module({ controllers: [MembersController, OrganizationsController], providers: [MembersService, OrganizationsService] })
export class UsersModule {}
