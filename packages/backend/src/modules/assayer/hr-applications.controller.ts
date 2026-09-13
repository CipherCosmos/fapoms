import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole, ApplicationStatus } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { RegistrationApplicationService } from './registration-application.service';

class RejectApplicationDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  reason: string;
}

/**
 * What the reviewer fills in as they approve.
 *
 * Deliberately loose as a shape: each group is filtered server-side against one shared list
 * (`pickRegistrationRecordFields`, `pickEmploymentTermFields`), and thirty decorators repeating
 * those lists here is exactly how a form and its server drift apart.
 */
class ApproveApplicationDto {
  /** Record fields the candidate got wrong. */
  @IsOptional() @IsObject()
  corrections?: Record<string, unknown>;

  /** Joining date, employment type, reporting line, workload ceilings. */
  @IsOptional() @IsObject()
  terms?: Record<string, unknown>;

  /** The rate card, filed in the same action. */
  @IsOptional() @IsObject()
  commercial?: Record<string, unknown>;

  /** First client standings. Without one, nobody can be given work for anybody. */
  @IsOptional() @IsArray()
  empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
}

class RequestMoreInfoDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  notes: string;
}

/**
 * HR's review queue for candidate applications — the Appraiser Recruitment spec's Module 4.
 *
 * Everything here is the CANDIDATE's own work. A second desk intake once lived on this controller
 * — a staff account typing an application and approving it, with maker-checker between the two —
 * and was withdrawn on 2026-09-13 because no screen ever called it and the registration wizard
 * already is the desk's door. Its DTO, its multer options and nine imports outlived it by a day;
 * the docblock describing the segregation control it carried outlived it by longer, which is worse
 * than the dead code, because it reads as a control that exists.
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
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApplicationDto,
    @Req() req: any,
  ) {
    const userRoles = (req.user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    const { assayer, gaps } = await this.registrationApplications.approve(
      id, req.user.id, userRoles, req.user.organizationId, dto,
    );
    // `gaps` goes back to the caller, not only to the audit trail. A promotion whose rate card or
    // identity fields were refused used to read as a clean success on the screen that approved it.
    return { success: true, data: { ...assayer, gaps } };
  }

  @Post(':id/resend-invite')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Send the candidate a fresh registration link, invalidating any earlier one' })
  async resendInvite(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.registrationApplications.resendInvite(id, req.user.id) };
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
