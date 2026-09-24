import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength } from 'class-validator';
import { SystemRole, CheckReviewDecision } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AllowPermissionFallback } from '../auth/guards';
import { ComplianceStandingService } from './compliance-standing.service';
import { ComplianceReviewService } from './compliance-review.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

class CheckReviewRequestDto {
  @IsEnum(CheckReviewDecision)
  decision: CheckReviewDecision;

  @IsString() @MaxLength(2000)
  reason: string;
}

/**
 * RE-CHECKS OVER TIME: HR's list of who needs one, and a senior's decision on an adverse result.
 * See `periodic-checks.ts` in shared and `ComplianceStandingService`.
 */
@ApiTags('Assayer re-checks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayers')
export class ComplianceController {
  constructor(
    private readonly standing: ComplianceStandingService,
    private readonly review: ComplianceReviewService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  /** Everybody working whose re-checks need attention — due soon, due, overdue, or held. */
  @Get('rechecks/attention')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Working assayers whose re-checks are due, overdue, or held' })
  async attention() {
    return await this.standing.attentionList();
  }

  @Post(':assayerId/checks/:checkId/review')
  @HttpCode(200)
  @Roles(SystemRole.ADMIN)
  @AllowPermissionFallback()
  @RequirePermissions('assayer:approve:organization')
  @ApiOperation({ summary: 'Decide an adverse re-check: keep them working, or suspend them' })
  async decide(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() body: CheckReviewRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return await this.review.decide(assayerId, checkId, body.decision, body.reason, {
      id: req.user.id, name: req.user.displayName ?? req.user.username ?? null,
    });
  }
}
