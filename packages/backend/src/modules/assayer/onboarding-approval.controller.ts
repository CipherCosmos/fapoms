import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SystemRole } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AllowPermissionFallback } from '../auth/guards';
import { OnboardingApprovalService } from './onboarding-approval.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/** The approver's or HR's words on a round — checked in full by the shared `approvalTextProblem`. */
class ApprovalTextRequestDto {
  @IsOptional() @IsString() @MaxLength(2000)
  text?: string;
}

/**
 * THE APPROVAL BEFORE TRAINING. Reading and answering are HR's (`assayer:edit`); deciding — approve,
 * reject, ask for more — needs `assayer:approve`, which Admin holds and a custom role can be given.
 * That the decider did not prepare the round is the service's check.
 */
@ApiTags('Assayer approval')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayers')
export class OnboardingApprovalController {
  constructor(
    private readonly approvals: OnboardingApprovalService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  private actor(req: any) {
    return { id: req.user.id, name: req.user.displayName ?? req.user.username ?? null };
  }

  /**
   * Everybody awaiting a decision — the approver's list. Declared before `:assayerId` routes.
   *
   * Held to the caller's regions, like every other route here: opening a person already asserts
   * their region (`history`), so a regional approver used to be listed joiners from every region
   * and refused on each one they opened. The list now leaves those out, by the same rule.
   */
  @Get('approvals/queue')
  @Roles(SystemRole.ADMIN)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:approve:organization')
  @ApiOperation({ summary: 'People awaiting approval before training' })
  async queue(@GlobalScopeFilter() scope?: GlobalScope) {
    const rows = await this.approvals.queue();
    return rows.filter((r) => this.regionGuard.isRegionAllowed(r.region, scope));
  }

  @Get(':assayerId/approval')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'The approval rounds for one person, with their conversation' })
  async history(@Param('assayerId', ParseUUIDPipe) assayerId: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return await this.approvals.history(assayerId);
  }

  @Post(':assayerId/approval/answer')
  @HttpCode(200)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'HR answers what the approver asked, and sends it back to them' })
  async answer(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Body() body: ApprovalTextRequestDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return await this.approvals.answer(assayerId, body.text ?? '', this.actor(req));
  }

  @Post(':assayerId/approval/request-info')
  @HttpCode(200)
  @Roles(SystemRole.ADMIN)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:approve:organization')
  @ApiOperation({ summary: 'The approver asks HR for more before deciding' })
  async requestInfo(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Body() body: ApprovalTextRequestDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return await this.approvals.requestInfo(assayerId, body.text ?? '', this.actor(req));
  }

  @Post(':assayerId/approval/approve')
  @HttpCode(200)
  @Roles(SystemRole.ADMIN)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:approve:organization')
  @ApiOperation({ summary: 'Approve: the person goes on to training' })
  async approve(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Body() body: ApprovalTextRequestDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return await this.approvals.approve(assayerId, body.text, this.actor(req));
  }

  @Post(':assayerId/approval/reject')
  @HttpCode(200)
  @Roles(SystemRole.ADMIN)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:approve:organization')
  @ApiOperation({ summary: 'Reject, with the reason: the person is parked as not approved' })
  async reject(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Body() body: ApprovalTextRequestDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return await this.approvals.reject(assayerId, body.text ?? '', this.actor(req));
  }
}
