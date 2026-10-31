import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantAuth } from '../common/auth/auth.types.js';
import { CurrentAuth, Roles } from '../common/auth/decorators.js';
import { CreateOrganizationDto, UpdateOrganizationDto } from '../catalog/dto/catalog.dto.js';
import { CreateInvitationDto, ListMembersQuery, ListOrganizationsQuery, UpdateMemberDto } from './dto/users.dto.js';
import { MembersService } from './members.service.js';
import { OrganizationsService } from './organizations.service.js';

const Id = (name = 'id') => Param(name, new ParseUUIDPipe());

@ApiTags('team')
@ApiBearerAuth()
@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Roles('admin', 'agent')
  @Get('members')
  list(@CurrentAuth() auth: TenantAuth, @Query() q: ListMembersQuery) {
    return this.members.list(auth, q);
  }

  @Patch('members/:userId')
  update(@CurrentAuth() auth: TenantAuth, @Id('userId') userId: string, @Body() dto: UpdateMemberDto) {
    return this.members.update(auth, userId, dto);
  }

  @Get('agents')
  agents(@CurrentAuth() auth: TenantAuth) {
    return this.members.agents(auth);
  }

  @Post('invitations')
  invite(@CurrentAuth() auth: TenantAuth, @Body() dto: CreateInvitationDto) {
    return this.members.invite(auth, dto);
  }

  @Roles('admin')
  @Get('invitations')
  invitations(@CurrentAuth() auth: TenantAuth) {
    return this.members.invitations(auth);
  }

  @Roles('admin')
  @Delete('invitations/:id')
  @HttpCode(204)
  revoke(@CurrentAuth() auth: TenantAuth, @Id() id: string): Promise<void> {
    return this.members.revokeInvitation(auth, id);
  }
}

@ApiTags('customers')
@ApiBearerAuth()
@Roles('admin', 'agent')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  list(@CurrentAuth() auth: TenantAuth, @Query() q: ListOrganizationsQuery) {
    return this.orgs.list(auth, q);
  }

  @Get(':id')
  get(@CurrentAuth() auth: TenantAuth, @Id() id: string) {
    return this.orgs.get(auth, id);
  }

  @Post()
  create(@CurrentAuth() auth: TenantAuth, @Body() dto: CreateOrganizationDto) {
    return this.orgs.create(auth, dto);
  }

  @Patch(':id')
  update(@CurrentAuth() auth: TenantAuth, @Id() id: string, @Body() dto: UpdateOrganizationDto) {
    return this.orgs.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: TenantAuth, @Id() id: string): Promise<void> {
    return this.orgs.remove(auth, id);
  }
}
