import { Controller, Get, Post, Body, Query, Req, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsUUID, IsEnum, Min } from 'class-validator';

import { CallLogService, CallOutcome } from './call-log.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

class CreateCallLogRequestDto {
  @IsUUID()
  projectBranchId: string;

  @IsUUID()
  assayerId: string;

  @IsEnum(CallOutcome)
  outcome: CallOutcome;

  @IsOptional() @IsNumber() @Min(0)
  negotiatedFee?: number;

  @IsOptional() @IsString()
  notes?: string;
}

@ApiTags('Call Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('call-logs')
@Roles(...STAFF_ROLES)
export class CallLogController {
  constructor(
    private readonly callLogService: CallLogService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  /**
   * Every route here is keyed on a project branch, and none of them checked it.
   *
   * A call log is who rang which assayer about which branch, what was said, and what fee was
   * discussed — the negotiation history behind an offer. `GET /projects/branches/:id/history`
   * asserts the region ceiling on this same identifier; these three did not, so an operator
   * refused the branch's history could read the calls made about it by pasting the id into a
   * query string, and could write new ones. Confirmed live: `cert_ops_east` read a Maharashtra
   * branch's call history (200) and recorded a call against it (201).
   *
   * The id arrives as a query parameter rather than a path segment, which is exactly why it was
   * missed — it does not look like a detail route. It is one.
   */
  @Post()
  // Recording a call is part of doing the planning, so it sits with the roles that plan.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Record a call made to an assayer about a branch' })
  async create(@Body() dto: CreateCallLogRequestDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertProjectBranchInScope(dto.projectBranchId, scope);
    return { success: true, data: await this.callLogService.create(dto, req.user.userId ?? req.user.id) };
  }

  @Get()
  @ApiOperation({ summary: 'Call history for a branch, newest first' })
  async findForBranch(
    @Query('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope);
    return { success: true, data: await this.callLogService.findForProjectBranch(projectBranchId) };
  }

  @Get('last-contact')
  @ApiOperation({ summary: 'Most recent contact per assayer for a branch' })
  async lastContact(
    @Query('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope);
    return { success: true, data: await this.callLogService.lastContactByAssayer(projectBranchId) };
  }
}
