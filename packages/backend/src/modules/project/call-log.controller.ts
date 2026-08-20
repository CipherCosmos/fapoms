import { Controller, Get, Post, Body, Query, Req, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsUUID, IsEnum, Min } from 'class-validator';

import { CallLogService, CallOutcome } from './call-log.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';

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
  constructor(private readonly callLogService: CallLogService) {}

  // Recording a call is part of doing the planning, so it sits with the roles that plan.
  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Record a call made to an assayer about a branch' })
  async create(@Body() dto: CreateCallLogRequestDto, @Req() req: any) {
    return { success: true, data: await this.callLogService.create(dto, req.user.userId ?? req.user.id) };
  }

  @Get()
  @ApiOperation({ summary: 'Call history for a branch, newest first' })
  async findForBranch(@Query('projectBranchId', ParseUUIDPipe) projectBranchId: string) {
    return { success: true, data: await this.callLogService.findForProjectBranch(projectBranchId) };
  }

  @Get('last-contact')
  @ApiOperation({ summary: 'Most recent contact per assayer for a branch' })
  async lastContact(@Query('projectBranchId', ParseUUIDPipe) projectBranchId: string) {
    return { success: true, data: await this.callLogService.lastContactByAssayer(projectBranchId) };
  }
}
