import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Invitation, Member } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, Roles } from '../common/auth/decorators.js';
import { TeamService } from './team.service.js';
import {
  CreateInvitationDto,
  CreateOrganizationDto,
  ListMembersQuery,
  ListOrganizationsQuery,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from './dto/team.dto.js';

const uuid = new ParseUUIDPipe();
type U = TenantUser;

@ApiTags('team')
@ApiBearerAuth()
@Controller()
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Roles('admin', 'agent') @Get('members')
  listMembers(@CurrentTenantUser() u: U, @Query() q: ListMembersQuery): Promise<Member[]> { return this.team.listMembers(u, q); }

  @Roles('admin') @Patch('members/:userId')
  updateMember(@CurrentTenantUser() u: U, @Param('userId', uuid) id: string, @Body() d: UpdateMemberDto): Promise<Member> {
    return this.team.updateMember(u, id, d);
  }

  @Roles('admin', 'agent') @Get('agents')
  agents(@CurrentTenantUser() u: U) { return this.team.agents(u); }

  @Roles('admin') @Get('invitations')
  listInvitations(@CurrentTenantUser() u: U): Promise<Invitation[]> { return this.team.listInvitations(u); }

  @Roles('admin') @Post('invitations')
  invite(@CurrentTenantUser() u: U, @Body() d: CreateInvitationDto): Promise<Invitation> { return this.team.invite(u, d); }

  @Roles('admin') @Delete('invitations/:id') @HttpCode(204)
  revoke(@CurrentTenantUser() u: U, @Param('id', uuid) id: string): Promise<void> { return this.team.revokeInvitation(u, id); }

  @Roles('admin', 'agent') @Get('organizations')
  listOrgs(@CurrentTenantUser() u: U, @Query() q: ListOrganizationsQuery) { return this.team.listOrganizations(u, q); }

  @Roles('admin', 'agent') @Get('organizations/:id')
  getOrg(@CurrentTenantUser() u: U, @Param('id', uuid) id: string) { return this.team.getOrganization(u, id); }

  @Roles('admin', 'agent') @Post('organizations')
  createOrg(@CurrentTenantUser() u: U, @Body() d: CreateOrganizationDto) { return this.team.createOrganization(u, d); }

  @Roles('admin', 'agent') @Patch('organizations/:id')
  updateOrg(@CurrentTenantUser() u: U, @Param('id', uuid) id: string, @Body() d: UpdateOrganizationDto) { return this.team.updateOrganization(u, id, d); }

  @Roles('admin', 'agent') @Delete('organizations/:id') @HttpCode(204)
  removeOrg(@CurrentTenantUser() u: U, @Param('id', uuid) id: string): Promise<void> { return this.team.removeOrganization(u, id); }
}
