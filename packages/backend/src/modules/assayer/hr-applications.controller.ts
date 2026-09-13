import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post,
  Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole, ApplicationStatus, OnboardingDocument } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { UpdateDraftRequestDto } from './public-registration.controller';
import { RegistrationApplicationService } from './registration-application.service';

const staffUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};

/**
 * The desk filling a candidate's own form in for them.
 *
 * Every box the candidate has, plus the three groups only a desk decides. Those three are left
 * loose for the reason `ApproveApplicationDto` below states: each is filtered server-side against
 * one shared list, and repeating the list as decorators here is how a form and its server drift.
 */
class StaffDraftRequestDto extends UpdateDraftRequestDto {
  @IsOptional() @IsObject()
  commercial?: Record<string, unknown>;

  @IsOptional() @IsArray()
  references?: Array<Record<string, unknown>>;

  @IsOptional() @IsArray()
  empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
}

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
  constructor(private readonly registrationApplications: RegistrationApplicationService) {}

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'List self-registration applications, optionally filtered by status' })
  async list(@Query('status') status?: ApplicationStatus) {
    return await this.registrationApplications.listApplications(status);
  }

  @Get(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'One application, with its uploaded documents' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return await this.registrationApplications.getApplication(id);
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
  ) {
    return await this.registrationApplications.updateStaffDraft(id, dto, req.user.id);
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
  ) {
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Stream one attached scan' })
  async readDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requirement') requirement: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: any,
  ): Promise<void> {
    const { key, fileName } = await this.registrationApplications.documentFileKey(
      id, requirement as OnboardingDocument, index,
    );
    const stream = await this.registrationApplications.openDocumentStream(key);
    // `inline` so a reviewer sees the scan rather than downloading it to look at it.
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
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
  ) {
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
  async resendInvite(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return await this.registrationApplications.resendInvite(id, req.user.id);
  }

  @Post(':id/reject')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Decline the application' })
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectApplicationDto, @Req() req: any) {
    return await this.registrationApplications.reject(id, req.user.id, dto.reason);
  }

  @Post(':id/request-info')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Ask the candidate for a correction or an additional document' })
  async requestMoreInfo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestMoreInfoDto, @Req() req: any) {
    return await this.registrationApplications.requestMoreInfo(id, req.user.id, dto.notes);
  }
}
