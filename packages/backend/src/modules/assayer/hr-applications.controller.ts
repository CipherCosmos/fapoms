import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post,
  Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole, ApplicationStatus, OnboardingDocument } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { UpdateDraftRequestDto } from './public-registration.controller';
import { RegistrationApplicationService } from './registration-application.service';
import { AuditRead } from '../../core/audit/audit-read.decorator';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

const staffUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};

/**
 * The desk filling a candidate's own form in for them.
 *
 * Every box the candidate has (references included — they ride the same normalized rule),
 * plus the two groups only a desk decides. Those two are left loose for the reason
 * `ApproveApplicationDto` below states: each is filtered server-side against an allow-list,
 * so re-declaring them as twenty decorators here is how the controller drifted from the
 * service in the first place.
 */
export class StaffDraftRequestDto extends UpdateDraftRequestDto {
  /** The rate card, filed in the same draft. */
  @IsOptional() @IsObject()
  commercial?: Record<string, unknown>;

  /** Client standing, filed in the same draft. */
  @IsOptional() @IsArray()
  empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
}

class RejectApplicationDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  reason: string;
}

/**
 * What a reviewer may add when they approve.
 *
 * Left loose for the same reason `StaffDraftRequestDto` is: each group is filtered server-side
 * against an allow-list, so sixty decorators here would be a second place to maintain the schema.
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

  @IsOptional() @IsBoolean()
  allowSharedContact?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  sharedContactReason?: string;
}

class UpdateMobileDto {
  @IsString() @MinLength(6) @MaxLength(20)
  mobile: string;
}

class RequestMoreInfoDto {
  /** Overall note. Optional now: a request can be only ticked documents/fields. */
  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  /** Document requirements to send back, each with its own instruction. */
  @IsOptional() @IsArray()
  documents?: Array<{ requirement: string; reason?: string; note?: string }>;

  /** Form fields to correct, each with its own instruction. */
  @IsOptional() @IsArray()
  fields?: Array<{ key: string; message?: string }>;
}

class ReviewApplicationDocumentDto {
  @IsString() @IsIn(['APPROVED', 'NEEDS_RESUBMIT'])
  decision: 'APPROVED' | 'NEEDS_RESUBMIT';

  @IsOptional() @IsString() @MaxLength(40)
  reason?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

/**
 * Adding a candidate no interview ever saw.
 *
 * `reason` carries a floor rather than merely `@IsNotEmpty()`, and it is the whole point of the
 * endpoint: a step that blocks real work and can be skipped with an empty box is a step that gets
 * skipped with an empty box. Ten characters is what stops "ok" from counting as a decision.
 * (`TrimStringsPipe` runs before validation, so a field of spaces is already `''` here.)
 */
export class OpenWithoutInterviewDto {
  @IsString() @MinLength(2) @MaxLength(200)
  fullName: string;

  /** The same shape `UpdateMobileDto` uses — one number, checked against the roster by the service. */
  @IsString() @MinLength(6) @MaxLength(20)
  mobile: string;

  @IsOptional() @IsEmail() @MaxLength(255)
  email?: string;

  @IsString() @MinLength(10) @MaxLength(500)
  reason: string;

  /** Who referred the candidate. Checked in full by the shared `normalizeSourceReferral`. */
  @IsOptional() @IsObject()
  sourceReferral?: Record<string, unknown> | null;
}

/**
 * HR's review queue for candidate applications — the Appraiser Recruitment spec's Module 4 — and
 * the desk's own way of filling one in.
 *
 * **One entry, two typists.** An application is still created only by an interview PASS, and the
 * candidate still verifies their own number, accepts the declaration and presses Submit. What the
 * desk can now do is save them the typing: the same fields, the same filters, the same row, keyed
 * on a session instead of a token. The seven-step wizard at `/hr/register` used to write a live
 * roster row directly and skip all of this, which is why the pipeline looked optional.
 *
 * That makes the maker–checker in `approve()` live rather than theoretical: whoever typed the form
 * in cannot be the one who approves it. This controller carried a docblock claiming the opposite
 * for a day after the first attempt at a desk intake was withdrawn — worse than the dead code it
 * described, because it read as a control that existed.
 */
@ApiTags('HR applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('hr/applications')
export class HrApplicationsController {
  /**
   * The region ceiling (audit F5, 2026-09-24). The hiring pipeline carried none: a region-assigned
   * account could list, open, approve or reject a candidate from anywhere in India, while the
   * roster those candidates join was already scoped. A candidate's region is their application's
   * state — see `RegionGuardService.assertApplicationInScope`. Reads honour
   * `security.regionScope.mode`; writes always enforce. Every `:id` route asserts before it
   * touches the row, so a refusal says "not yours" rather than disclosing the row's state.
   */
  constructor(
    private readonly registrationApplications: RegistrationApplicationService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'List self-registration applications, optionally filtered by status' })
  async list(@Query('status') status?: ApplicationStatus, @GlobalScopeFilter() scope?: GlobalScope) {
    const rows = await this.registrationApplications.listApplications(status);
    return await this.regionGuard.narrowApplicationsToScope(rows, scope);
  }

  @Get(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'One application, with its uploaded documents' })
  async get(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'read');
    return await this.registrationApplications.getApplication(id);
  }

  /**
   * The second door into the pipeline: a candidate with no interview behind them.
   *
   * Declared ahead of every other `@Post` here, so a literal segment is matched before any
   * pattern that could swallow it. Thin on purpose: every rule — the roster check, the
   * already-open check, the stamp, the audit row — lives in the service, beside the interview
   * path that has to agree with it.
   */
  @Post('invite')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Add a candidate to the hiring pipeline without an interview, on a recorded reason' })
  async openWithoutInterview(@Body() dto: OpenWithoutInterviewDto, @Req() req: any) {
    return await this.registrationApplications.openWithoutInterview(dto, {
      id: req.user.id,
      // The same three-deep fallback the interview screen uses for the interviewer's name.
      name: req.user.displayName ?? req.user.username ?? req.user.email ?? null,
      organizationId: req.user.organizationId,
    });
  }

  /**
   * The desk saving a step of the form on the candidate's behalf.
   *
   * A diff, not the whole form: the wizard sends only what moved, which is what keeps a desk save
   * and a candidate save from overwriting each other in the window where both are typing.
   */
  @Patch(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: "Fill in a candidate's application at the HR desk" })
  async updateStaffDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StaffDraftRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    return await this.registrationApplications.updateStaffDraft(id, dto, req.user.id);
  }

  @Patch(':id/mobile')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: "Correct a candidate's registered mobile number" })
  async updateMobile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMobileDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    return await this.registrationApplications.updateApplicationMobile(id, dto.mobile, req.user.id);
  }

  @Post(':id/documents/:requirement')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @UseInterceptors(FileInterceptor('file', staffUploadMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Attach a scan to a candidate's application from the desk" })
  async uploadDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requirement') requirement: string,
    @UploadedFile() file: any,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    return await this.registrationApplications.uploadDocumentAsStaff(
      id,
      requirement as OnboardingDocument,
      {
        originalname: file.originalname,
        buffer: file.buffer,
        mimetype: file.mimetype,
        size: file.size,
      },
      req.user.id,
    );
  }

  /**
   * One of a candidate's scans, so the reviewer can look at what they are approving.
   *
   * There was no way to read these bytes at all. The review screen listed "3 files" and offered no
   * way to open one, so approval was sight-unseen — including the PHOTOGRAPH rule, which refuses
   * an application without one and could only ever check that a file existed.
   */
  @Get(':id/documents/:requirement/file/:index')
  // Opening an identity scan is recorded: "who looked at whose Aadhaar card" had no answer at all.
  @AuditRead({ resource: 'ASSAYER_APPLICATION', idParam: 'id', eventType: 'APPLICATION_DOCUMENT_SCAN_VIEWED' })
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Stream one attached scan' })
  async readDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requirement') requirement: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ): Promise<void> {
    // Before the file is looked up, so another region's candidate is refused, not described.
    await this.regionGuard.assertApplicationInScope(id, scope, 'read');
    const { key, fileName } = await this.registrationApplications.documentFileKey(
      id, requirement as OnboardingDocument, index,
    );
    const stream = await this.registrationApplications.openDocumentStream(key);
    // `inline` so a reviewer sees the scan rather than downloading it to look at it.
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    // Never cached: an identity scan must not survive in a shared machine's browser cache.
    res.setHeader('Cache-Control', 'private, no-store');
    stream.pipe(res);
  }

  @Post(':id/approve')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Approve and promote to a real assayer record' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApplicationDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    const userRoles = (req.user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    const { assayer, gaps } = await this.registrationApplications.approve(
      id, req.user.id, userRoles, req.user.organizationId, dto,
    );
    // `gaps` goes back to the caller, not only to the audit trail. A promotion whose rate card or
    // identity fields were refused used to read as a clean success on the screen that approved it.
    return { ...assayer, gaps };
  }

  @Post(':id/resend-invite')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Send the candidate a fresh registration link, invalidating any earlier one' })
  async resendInvite(@Param('id', ParseUUIDPipe) id: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    return await this.registrationApplications.resendInvite(id, req.user.id);
  }

  @Post(':id/reject')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Decline the application' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApplicationDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    return await this.registrationApplications.reject(id, req.user.id, dto.reason);
  }

  @Post(':id/request-info')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Ask the candidate for specific documents or corrections on the same link' })
  async requestMoreInfo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestMoreInfoDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    return await this.registrationApplications.requestMoreInfo(id, req.user.id, {
      notes: dto.notes,
      documents: (dto.documents ?? []).map((d) => ({
        requirement: d.requirement as OnboardingDocument,
        reason: d.reason,
        note: d.note,
      })),
      fields: (dto.fields ?? []).map((f) => ({ key: f.key, message: f.message })),
    });
  }

  /**
   * One document requirement judged on its own — approve the scans, or send just this file
   * back with a structured reason so the candidate re-uploads it on the same link.
   */
  @Post(':id/documents/:requirement/review')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Approve or send back one document of a candidate application' })
  async reviewDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requirement') requirement: string,
    @Body() dto: ReviewApplicationDocumentDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertApplicationInScope(id, scope, 'write');
    return await this.registrationApplications.reviewApplicationDocument(
      id,
      requirement as OnboardingDocument,
      dto.decision,
      { reason: dto.reason, note: dto.note },
      req.user.id,
    );
  }
}
