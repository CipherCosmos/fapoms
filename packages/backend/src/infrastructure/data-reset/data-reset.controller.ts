/**
 * FAPOMS — Data Reset ("Danger Zone")
 *
 * Lets a developer clear accumulated test/seed data, with a comprehensive picker of what to keep
 * vs. remove — see wipe-domains.registry.ts for the domain list and data-reset.service.ts for the
 * safety mechanics (live FK-graph conflict checking, force-kept caller, transactional execution,
 * an audit write that cannot silently fail).
 *
 * The wipe belongs to the DEVELOPER role — the class gate is deliberately a permissionless name
 * match, and one-way implication means admins do NOT inherit it — but no developer wipes alone:
 * the two-person rule (destructive-approval.service.ts) has a developer file a request, an ADMIN
 * approve it (never their own; the approve routes below are the one place fenced by
 * SYSTEM:APPROVE:PLATFORM + @RoleOnly), and only then does the REQUESTING developer execute,
 * quoting the approved request's id alongside the same confirmation phrase as ever.
 */

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import { SystemRole } from '@fapoms/shared';

import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RoleOnly, RequirePermissions } from '../../modules/auth/guards';
import { DataResetService } from './data-reset.service';
import { BackupOnDemandService } from './backup-on-demand.service';
import { DestructiveApprovalService } from './destructive-approval.service';

/**
 * Typed exactly so a fat-fingered or scripted request can't slip past the intent-to-delete step.
 * Not real security — the caller already cleared the DEVELOPER-only guards and holds an approved
 * request to get here — just friction proportional to the action.
 */
export const DATA_RESET_CONFIRMATION_PHRASE = 'DELETE ALL SELECTED DATA';

export class PreviewDataResetDto {
  @IsArray()
  @IsString({ each: true })
  domainKeys: string[];
}

export class CreateDestructiveRequestDto {
  @IsArray()
  @IsString({ each: true })
  domains: string[];
}

export class RejectDestructiveRequestDto {
  @IsString()
  reason: string;
}

export class ExecuteDataResetDto {
  @IsArray()
  @IsString({ each: true })
  domainKeys: string[];

  /** The APPROVED destructive-action request this execute consumes. Required — no request, no wipe. */
  @IsUUID('4')
  requestId: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  keepUserIds?: string[];

  @IsOptional()
  @IsBoolean()
  billingConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  takeBackupFirst?: boolean;

  @IsString()
  confirmationPhrase: string;
}

@ApiTags('Data Reset')
@ApiBearerAuth()
@Controller('admin/data-reset')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(SystemRole.DEVELOPER)
export class DataResetController {
  constructor(
    private readonly dataReset: DataResetService,
    private readonly backup: BackupOnDemandService,
    private readonly approvals: DestructiveApprovalService,
  ) {}

  @Get('domains')
  @ApiOperation({ summary: 'Every wipeable domain, with current row counts' })
  async domains() {
    return { success: true, data: await this.dataReset.describeDomains() };
  }

  @Post('preview')
  @ApiOperation({ summary: 'What a selection would actually touch, before committing to it' })
  async preview(@Body() dto: PreviewDataResetDto) {
    return { success: true, data: await this.dataReset.preview(dto.domainKeys) };
  }

  // ── The two-person rule ─────────────────────────────────────────────────

  @Post('requests')
  @ApiOperation({ summary: 'File a data-wipe request for an admin to approve' })
  async createRequest(@Body() dto: CreateDestructiveRequestDto, @Req() req: any) {
    return { success: true, data: await this.approvals.request(req.user.id, dto.domains) };
  }

  @Get('requests')
  // Widened past the class gate: admins must see what they are being asked to approve. What each
  // caller SEES is shaped by a direct-role query in the service — deliberately not the implication
  // map, so an implied admin (i.e. a developer) still gets the requester's view of their own rows.
  @Roles(SystemRole.DEVELOPER, SystemRole.ADMIN)
  @ApiOperation({ summary: 'Destructive-action requests — all of them for a direct admin, your own otherwise' })
  async listRequests(@Req() req: any) {
    const isAdminDirect = await this.approvals.isDirectAdmin(req.user.id);
    const roleNames: string[] = (req.user?.roles ?? []).map((r: { name: string }) => r.name);
    const data = await this.approvals.list({
      id: req.user.id,
      isAdminDirect,
      isDeveloper: roleNames.includes(SystemRole.DEVELOPER),
    });
    return { success: true, data, meta: { isAdminDirect } };
  }

  @Post('requests/:id/cancel')
  @ApiOperation({ summary: 'Withdraw your own request before it is decided' })
  async cancelRequest(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: any) {
    return { success: true, data: await this.approvals.cancel(id, req.user.id) };
  }

  /**
   * The approve/reject pair is the ADMIN half of the two-person rule, and the one spot where an
   * implied admin must be turned away: a DEVELOPER passes any `@Roles(ADMIN)` name-gate through
   * the implication map, so the fence here is the permission — SYSTEM:APPROVE:PLATFORM is granted
   * to ADMIN and deliberately withheld from DEVELOPER, and `PermissionsGuard` enforces it on every
   * caller however RolesGuard admitted them. `@RoleOnly()` closes the remaining door (a custom
   * role granted the permission slipping in through the name-fallback); the service then checks
   * the approver's DIRECT role rows in the database as the final, cache-proof word.
   */
  @Post('requests/:id/approve')
  @Roles(SystemRole.ADMIN)
  @RoleOnly()
  @RequirePermissions('system:approve:platform')
  @ApiOperation({ summary: "Approve a developer's data-wipe request (never your own)" })
  async approveRequest(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: any) {
    return { success: true, data: await this.approvals.decide(id, req.user.id, true) };
  }

  @Post('requests/:id/reject')
  @Roles(SystemRole.ADMIN)
  @RoleOnly()
  @RequirePermissions('system:approve:platform')
  @ApiOperation({ summary: "Reject a developer's data-wipe request, with a reason" })
  async rejectRequest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectDestructiveRequestDto,
    @Req() req: any,
  ) {
    return { success: true, data: await this.approvals.decide(id, req.user.id, false, dto.reason) };
  }

  // ── Execution ───────────────────────────────────────────────────────────

  @Post('execute')
  @ApiOperation({ summary: 'Wipe the selected domains, consuming an approved request' })
  async execute(@Body() dto: ExecuteDataResetDto, @Req() req: any) {
    if (dto.confirmationPhrase !== DATA_RESET_CONFIRMATION_PHRASE) {
      return {
        success: false,
        error: `Confirmation text did not match. Type exactly "${DATA_RESET_CONFIRMATION_PHRASE}".`,
      };
    }

    // The frontend's own "keep me" checkbox is UX only — never trusted as the actual guarantee.
    // Whatever it sent, the caller's own account is force-kept here so "locked myself out" is
    // structurally impossible rather than merely discouraged.
    const keepUserIds = [...new Set([...(dto.keepUserIds ?? []), req.user.id])];

    // A fresh preview, re-run server-side, so a confirm click that raced ahead of what was
    // actually looked at (a conflict introduced by another change in between) is caught here
    // rather than silently executed — DataResetService.execute() re-derives this itself and
    // throws a 409 with the same shape preview() would have returned.
    let backup = null as Awaited<ReturnType<BackupOnDemandService['createDump']>> | null;
    if (dto.takeBackupFirst) {
      // On failure this throws and the wipe never starts — see BackupOnDemandService.createDump.
      backup = await this.backup.createDump();
    }

    const result = await this.dataReset.execute({
      domainKeys: dto.domainKeys,
      keepUserIds,
      billingConfirmed: dto.billingConfirmed,
      actorUserId: req.user.id,
      backup,
      requestId: dto.requestId,
      // Runs as the first statement inside the wipe's transaction: executor must be the
      // requester, the selection must match the approval exactly, and the APPROVED row is
      // atomically consumed — or the whole thing throws before a single row is deleted.
      consumeApproval: (manager) =>
        this.approvals.assertExecutableAndConsume(dto.requestId, req.user.id, dto.domainKeys, manager),
    });

    return { success: true, data: result };
  }
}
