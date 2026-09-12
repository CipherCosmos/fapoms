import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole, ApplicationStatus } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { RegistrationApplicationService } from './registration-application.service';

class RejectApplicationDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  reason: string;
}

class RequestMoreInfoDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  notes: string;
}

/**
 * HR's review queue for self-registration applications — the Appraiser Recruitment spec's
 * Module 4 (Internal Validation), scoped to the NEW candidate-facing intake path only. The
 * HR-desk registration wizard has no equivalent screen because it never produces a pending
 * application: it writes a live assayer directly, exactly as it always has.
 */
@ApiTags('HR applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('hr/applications')
export class HrApplicationsController {
  constructor(private readonly registrationApplications: RegistrationApplicationService) {}

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'List self-registration applications, optionally filtered by status' })
  async list(@Query('status') status?: ApplicationStatus) {
    return { success: true, data: await this.registrationApplications.listApplications(status) };
  }

  @Get(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'One application, with its uploaded documents' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.registrationApplications.getApplication(id) };
  }

  @Post(':id/approve')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Approve and promote to a real assayer record' })
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userRoles = (req.user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    const assayer = await this.registrationApplications.approve(id, req.user.id, userRoles, req.user.organizationId);
    return { success: true, data: assayer };
  }

  @Post(':id/reject')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Decline the application' })
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectApplicationDto, @Req() req: any) {
    return { success: true, data: await this.registrationApplications.reject(id, req.user.id, dto.reason) };
  }

  @Post(':id/request-info')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Ask the candidate for a correction or an additional document' })
  async requestMoreInfo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestMoreInfoDto, @Req() req: any) {
    return { success: true, data: await this.registrationApplications.requestMoreInfo(id, req.user.id, dto.notes) };
  }
}
