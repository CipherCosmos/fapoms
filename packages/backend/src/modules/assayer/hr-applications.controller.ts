import {
  BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { SystemRole, ApplicationStatus, EmploymentCategory, OnboardingDocument } from '@fapoms/shared';
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
 * HR's review queue for applications — the Appraiser Recruitment spec's Module 4 (Internal
 * Validation). Originally scoped to the candidate-facing intake only, while the HR-desk wizard
 * wrote a live assayer directly and ungated. The owner ended that split on 2026-09-12: the desk
 * now files an application here too (`POST /`, source HR_DESK), and `approve()` refuses the
 * account that entered it — one gate for all three doors, with maker-checker on the one HR
 * authors itself.
 */
const staffUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};

class CreateStaffApplicationDto {
  @IsString() @MinLength(1) @MaxLength(200)
  fullName: string;

  @IsString() @Matches(/^[0-9+\-() ]{6,20}$/, { message: 'mobile must be a phone number' })
  mobile: string;

  @IsOptional() @IsString() @MaxLength(255)
  email?: string;

  /** ISO date, the same shape the candidate form and CreateAssayerDto use. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth?: string;

  @IsOptional() @IsString() @MaxLength(20)
  gender?: string;

  @IsOptional() @IsString() @MaxLength(500)
  address?: string;

  @IsOptional() @IsString() @MaxLength(100)
  state?: string;

  @IsOptional() @IsString() @MaxLength(100)
  city?: string;

  @IsOptional() @IsString() @MaxLength(10)
  pincode?: string;

  @IsOptional() @IsInt() @Min(0) @Max(60)
  experienceYears?: number;

  @IsOptional() @IsString() @MaxLength(200)
  currentEmployer?: string;

  @IsOptional() @IsEnum(EmploymentCategory)
  employmentCategory?: EmploymentCategory;

  @IsOptional() @IsString() @MaxLength(2000)
  expertise?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  availability?: string;

  /**
   * What the wizard collects beyond these columns — identity and bank details, rates, standings.
   * Held on the application and applied at promotion; see the entity's own comment.
   */
  @IsOptional() @IsObject()
  extendedProfile?: Record<string, unknown>;
}

@ApiTags('HR applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('hr/applications')
export class HrApplicationsController {
  constructor(private readonly registrationApplications: RegistrationApplicationService) {}

  /**
   * The desk's door into the SAME gate the candidates use. Submitted immediately — the author is
   * this session, so there is no token or OTP — and approval must come from a different account.
   */
  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'File a candidate application from the HR desk (reviewed by somebody else)' })
  async createFromDesk(@Body() dto: CreateStaffApplicationDto, @Req() req: any) {
    const application = await this.registrationApplications.createStaffApplication(
      dto, req.user.id, req.user.organizationId,
    );
    return {
      success: true,
      data: application,
      message: 'Application filed. A different authorised user has to approve it before a roster record exists.',
    };
  }

  /** The staff half of the document doors — same storage, same scan, no token. */
  @Post(':id/documents/:requirement')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @UseInterceptors(FileInterceptor('file', staffUploadMulterOptions), FileScanInterceptor)
  @ApiOperation({ summary: 'Attach a document scan to an application from the HR desk' })
  async uploadFromDesk(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requirement') requirement: string,
    @UploadedFile() file: any,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    const doc = await this.registrationApplications.uploadDocumentAsStaff(
      id, requirement as OnboardingDocument, file,
    );
    return { success: true, data: doc };
  }

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
