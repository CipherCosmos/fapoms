/**
 * FAPOMS — Assayer Controller
 *
 * REST API endpoints for Assayer profile administration (Part 5 §5).
 */

import {
  ForbiddenException,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
  HttpCode,
  UseInterceptors,
  UploadedFile,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsEmail, IsArray, IsInt, IsObject, IsEnum, IsDateString, IsUUID, MinLength, MaxLength, ValidateNested, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * A block of time an assayer is unavailable. Real nested classes rather than an inline type:
 * with `whitelist: true` an inline `{ startDate, endDate }[]` is transformed into an array of
 * empty objects because the inner properties carry no validation metadata to keep — the same
 * defect that once stored query attachments as `[[]]`. `@ValidateNested` + `@Type` preserve them.
 */
class LeavePeriodDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;
}

class WorkingHoursDto {
  // 24-hour HH:MM. Validated so a malformed time cannot reach the scheduler's window check.
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'start must be HH:MM (24-hour)' })
  start: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'end must be HH:MM (24-hour)' })
  end: string;
}

import { AssayerService, CreateAssayerDto, UpdateAssayerDto } from './assayer.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public, AnyAuthenticated } from '../auth/guards';
import { SystemRole, AssayerLifecycleStatus } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { scopeAssayerForRoles, scopeAssayerListForRoles, rolesOf, assertSelfOrPrivileged } from './assayer-visibility';
import { STAFF_ROLES } from '../auth/staff-roles';

/** Roles that may edit any assayer's record; everyone else is limited to their own. */
const STAFF_ASSAYER_EDITORS: string[] = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.HR_MANAGER,
];

/**
 * What an assayer may change about themselves from the mobile app.
 *
 * The mobile profile screen offers roughly twenty editable fields; this list held ten, so
 * everything else was refused — and because the app reported success regardless of the
 * response, a worker updating their emergency contact was told it saved when it had not.
 *
 * The split is by who the data belongs to, not by convenience:
 *  - Personal facts (contact, address, next of kin, languages, skills, travel preferences)
 *    are the worker's own and are theirs to correct. Nobody in HR knows their new phone
 *    number sooner than they do.
 *  - Payment details (PAN, bank account, IFSC) stay HR-maintained. Letting a payee silently
 *    redirect their own payments is the classic payroll-diversion route, and these are audited
 *    changes on a system producing legally significant evidence.
 *  - Capacity limits (max daily/weekly workload) and licence numbers stay HR-maintained too:
 *    they drive scheduling and eligibility, so an assayer could otherwise quietly remove
 *    themselves from the planning pool by setting a limit to zero.
 */
const SELF_EDITABLE_FIELDS: string[] = [
  'phone', 'alternatePhone', 'email',
  'address', 'city', 'district', 'state', 'pincode',
  'latitude', 'longitude',
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'languages', 'skills', 'experienceYears',
  'preferredRegions',
  // Availability is the assayer's own to declare: when they are off and the hours they work.
  // The scheduler already honours both (ConstraintEvaluator.checkLeaves / working hours), so
  // letting an assayer set their own time off is what stops the desk offering them work on a
  // day they are away — without an HR round-trip.
  'leaves', 'workingHours',
];

/**
 * Fields the mobile app must render read-only. Exposed so the app can grey them out with a
 * reason rather than presenting an input that silently refuses to save.
 */
const HR_MAINTAINED_FIELDS: string[] = [
  'panNumber', 'bankAccountNumber', 'ifscCode',
  'maxDailyWorkload', 'maxWeeklyWorkload',
  'employmentType', 'performanceRating',
];

class CreateAssayerRequestDto implements CreateAssayerDto {
  @IsString() @IsNotEmpty()
  assayerCode: string;

  @IsString() @IsNotEmpty()
  firstName: string;

  @IsString() @IsNotEmpty()
  lastName: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsString() @IsNotEmpty()
  phone: string;

  @IsOptional() @IsString()
  alternatePhone?: string;

  @IsString() @IsNotEmpty()
  address: string;

  @IsString() @IsNotEmpty()
  state: string;

  @IsString() @IsNotEmpty()
  district: string;

  @IsString() @IsNotEmpty()
  city: string;

  @IsOptional() @IsString()
  pincode?: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;

  @IsOptional() @IsString()
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString()
  ifscCode?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  employmentType?: string;

  @IsOptional() @IsDateString()
  joiningDate?: string;

  @IsOptional() @IsString()
  managerId?: string;

  @IsOptional() @IsString()
  department?: string;

  @IsOptional() @IsString()
  region?: string;

  @IsOptional() @IsString()
  emergencyContactName?: string;

  @IsOptional() @IsString()
  emergencyContactPhone?: string;

  @IsOptional() @IsString()
  emergencyContactRelation?: string;

  @IsOptional() @IsString()
  employeeId?: string;

  @IsOptional() @IsString()
  employeeCode?: string;

  @IsOptional() @IsString()
  photograph?: string;

  @IsOptional() @IsArray()
  skills?: string[];

  @IsOptional() @IsArray()
  certifications?: { name: string; expiryDate: string }[];

  @IsOptional() @IsArray()
  languages?: string[];

  @IsOptional() @IsArray()
  preferredRegions?: string[];

  @IsOptional() @IsArray()
  specializations?: string[];

  @IsOptional() @IsInt()
  experienceYears?: number;

  @IsOptional() @IsNumber()
  performanceRating?: number;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LeavePeriodDto)
  leaves?: LeavePeriodDto[];

  @IsOptional() @ValidateNested() @Type(() => WorkingHoursDto)
  workingHours?: WorkingHoursDto;

  @IsOptional() @IsInt()
  maxDailyWorkload?: number;

  @IsOptional() @IsInt()
  maxWeeklyWorkload?: number;

  @IsOptional() @IsArray()
  eligibleClients?: string[];
}

class UpdateAssayerRequestDto implements UpdateAssayerDto {
  @IsOptional() @IsString()
  firstName?: string;

  @IsOptional() @IsString()
  lastName?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  alternatePhone?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  state?: string;

  @IsOptional() @IsString()
  district?: string;

  @IsOptional() @IsString()
  city?: string;

  @IsOptional() @IsString()
  pincode?: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;

  @IsOptional() @IsString()
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString()
  ifscCode?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  employmentType?: string;

  @IsOptional() @IsDateString()
  joiningDate?: string;

  @IsOptional() @IsDateString()
  exitDate?: string;

  @IsOptional() @IsDateString()
  terminationDate?: string;

  @IsOptional() @IsString()
  managerId?: string;

  @IsOptional() @IsString()
  department?: string;

  @IsOptional() @IsString()
  region?: string;

  @IsOptional() @IsString()
  emergencyContactName?: string;

  @IsOptional() @IsString()
  emergencyContactPhone?: string;

  @IsOptional() @IsString()
  emergencyContactRelation?: string;

  @IsOptional() @IsString()
  employeeId?: string;

  @IsOptional() @IsString()
  employeeCode?: string;

  @IsOptional() @IsString()
  photograph?: string;

  @IsOptional() @IsArray()
  skills?: string[];

  @IsOptional() @IsArray()
  certifications?: { name: string; expiryDate: string }[];

  @IsOptional() @IsArray()
  languages?: string[];

  @IsOptional() @IsArray()
  preferredRegions?: string[];

  @IsOptional() @IsArray()
  specializations?: string[];

  @IsOptional() @IsInt()
  experienceYears?: number;

  @IsOptional() @IsNumber()
  performanceRating?: number;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LeavePeriodDto)
  leaves?: LeavePeriodDto[];

  @IsOptional() @ValidateNested() @Type(() => WorkingHoursDto)
  workingHours?: WorkingHoursDto;

  @IsOptional() @IsInt()
  maxDailyWorkload?: number;

  @IsOptional() @IsInt()
  maxWeeklyWorkload?: number;

  @IsOptional() @IsArray()
  eligibleClients?: string[];
}

export class UpdateLiveLocationDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;
}

export class UpdateLiveTrackingDto {
  @IsNotEmpty()
  enabled: boolean;
}

export class CreateWorkforceAttributeRequestDto {
  @IsString() @IsNotEmpty()
  type: string;

  @IsString() @IsNotEmpty()
  name: string;

  @IsOptional() @IsString()
  level?: string;

  @IsOptional() @IsString()
  expiryDate?: string;

  @IsOptional() @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateWorkforceAttributeRequestDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  level?: string;

  @IsOptional() @IsString()
  expiryDate?: string | null;

  @IsOptional() @IsObject()
  metadata?: Record<string, any>;
}

export class CreateCommercialProfileRequestDto {
  @IsNumber() @IsNotEmpty()
  baseFee: number;

  @IsNumber() @IsNotEmpty()
  hourlyRate: number;

  @IsNumber() @IsNotEmpty()
  dailyRate: number;

  @IsNumber() @IsNotEmpty()
  travelReimbursement: number;

  @IsNumber() @IsNotEmpty()
  accommodationAllowance: number;

  @IsNumber() @IsNotEmpty()
  mealAllowance: number;

  @IsOptional() @IsString()
  currency?: string;

  @IsString() @IsNotEmpty()
  effectiveStartDate: string;

  @IsOptional() @IsString()
  effectiveEndDate?: string | null;
}

export class UpdateCommercialProfileRequestDto {
  @IsOptional() @IsNumber()
  baseFee?: number;

  @IsOptional() @IsNumber()
  hourlyRate?: number;

  @IsOptional() @IsNumber()
  dailyRate?: number;

  @IsOptional() @IsNumber()
  travelReimbursement?: number;

  @IsOptional() @IsNumber()
  accommodationAllowance?: number;

  @IsOptional() @IsNumber()
  mealAllowance?: number;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsString()
  effectiveStartDate?: string;

  @IsOptional() @IsString()
  effectiveEndDate?: string | null;
}

export class TransitionLifecycleDto {
  @IsString() @IsNotEmpty()
  targetStatus: string;

  @IsOptional() @IsString()
  reason?: string;
}

export class BulkTransitionLifecycleDto {
  @IsArray() @IsNotEmpty()
  @IsUUID('4', { each: true })
  ids: string[];

  @IsString() @IsNotEmpty()
  targetStatus: string;

  @IsOptional() @IsString()
  reason?: string;
}

export class CreateGovernmentDocumentRequestDto {
  @IsString() @IsNotEmpty()
  documentType: string;

  @IsString() @IsNotEmpty()
  documentNumber: string;

  @IsOptional() @IsDateString()
  expiryDate?: string;

  @IsOptional() @IsArray()
  filePaths?: string[];

  @IsOptional() @IsString()
  remarks?: string;
}

export class UpdateGovernmentDocumentRequestDto {
  @IsOptional() @IsString()
  documentNumber?: string;

  @IsOptional() @IsDateString()
  expiryDate?: string | null;

  @IsOptional() @IsString()
  verificationStatus?: string;

  @IsOptional() @IsString()
  verifiedBy?: string;

  @IsOptional() @IsArray()
  filePaths?: string[];

  @IsOptional() @IsString()
  remarks?: string;
}

export class CreateAssayerDocumentRequestDto {
  @IsString() @IsNotEmpty()
  documentType: string;

  @IsString() @IsNotEmpty()
  fileName: string;

  @IsString() @IsNotEmpty()
  filePath: string;

  @IsNumber() @IsNotEmpty()
  fileSize: number;

  @IsOptional() @IsString()
  mimeType?: string;

  @IsOptional() @IsString()
  parentDocumentId?: string;

  @IsOptional() @IsString()
  remarks?: string;
}

export class CreateRemarkRequestDto {
  @IsString() @IsNotEmpty()
  content: string;

  @IsString() @IsNotEmpty()
  category: string;

  @IsString() @IsNotEmpty()
  visibility: string;

  @IsOptional() @IsArray()
  attachmentPaths?: string[];

  @IsOptional() @IsNumber()
  rating?: number;
}

export class UpdateRemarkRequestDto {
  @IsOptional() @IsString()
  content?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  visibility?: string;

  @IsOptional() @IsArray()
  attachmentPaths?: string[];

  @IsOptional() @IsNumber()
  rating?: number;
}

export class UpdateAssayerDocumentRequestDto {
  @IsOptional() @IsString()
  documentType?: string;

  @IsOptional() @IsString()
  fileName?: string;

  @IsOptional() @IsString()
  filePath?: string;

  @IsOptional() @IsNumber()
  fileSize?: number;

  @IsOptional() @IsString()
  mimeType?: string;

  @IsOptional() @IsString()
  remarks?: string;
}


/**
 * Password bodies.
 *
 * Both routes typed `@Body()` as an inline object literal, which TypeScript erases — so the
 * only checks were the hand-written `if (!dto?.newPassword)` guards below. Presence was
 * enforced; length and composition were not, so a one-character password would have been
 * accepted and hashed. That matters here more than most places: this deployment's assayer
 * accounts currently share a single weak password, and these are the two routes that exist to
 * move off it.
 */
class ChangeOwnPasswordRequestDto {
  @IsString() @IsNotEmpty()
  currentPassword: string;

  @IsString() @MinLength(8, { message: 'Your new password must be at least 8 characters.' })
  @MaxLength(128)
  newPassword: string;
}

class ResetAssayerPasswordRequestDto {
  // Optional: when omitted, the server generates a temporary password and returns it once, so
  // HR can read it to a locked-out field worker over the phone without inventing one.
  @IsOptional() @IsString() @MinLength(8, { message: 'The new password must be at least 8 characters.' })
  @MaxLength(128)
  newPassword?: string;
}

@ApiTags('Assayers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayers')
export class AssayerController {
  constructor(private readonly assayerService: AssayerService) {}

  @Post()
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Register a new field assayer' })
  async create(@Body() dto: CreateAssayerRequestDto, @Req() req: any) {
    const assayer = await this.assayerService.create(dto, req.user.id, req.user.organizationId);
    return {
      success: true,
      data: assayer,
    };
  }

  // Was @Public(): returns the full roster and, until the entity was changed, each
  // assayer's bcrypt hash — readable by anyone who could reach the API. The pre-login
  // identity check that needed it now uses POST /auth/verify-assayer.
  /**
   * Read access matches who actually needs to identify a field worker, not who owns the record.
   *
   * READ_ONLY_AUDITOR was excluded, yet route-permissions grants it the Billing and Clients
   * screens — both of which call this endpoint. A live probe of every role against every page
   * they can open found exactly this: the auditor could open two pages that then 403'd,
   * leaving an empty screen with nothing to do. An audit role that cannot see the workforce it
   * is auditing is not a coherent position.
   *
   * The validation and data-entry roles are included for the same reason: they review an
   * assayer's submitted work and raise clarifications addressed to that person, so they need
   * to resolve who performed an audit.
   *
   * Widening this is safe because visibility is enforced at FIELD level, not endpoint level —
   * `scopeAssayerForRoles` strips PAN, Aadhaar, date of birth, emergency contacts and banking
   * details for everyone outside HR/administrators (Finance keeps banking, since they pay).
   * Everyone added here receives the operational subset only.
   */
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.HR_MANAGER,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.FINANCE_MANAGER,
    SystemRole.READ_ONLY_AUDITOR,
    SystemRole.VALIDATION_MANAGER,
    SystemRole.VALIDATOR,
    SystemRole.DATA_ENTRY_HEAD,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @Get()
  @ApiOperation({ summary: 'List all registered assayers' })
  async findAll(
    @Req() req: any,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const { assayers, total } = await this.assayerService.findAll(page, limit, scope);
    return {
      success: true,
      data: scopeAssayerListForRoles(assayers as any[], rolesOf(req.user), req.user?.id),
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.FINANCE_MANAGER)
  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single assayer by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const assayer = await this.assayerService.findOne(id);
    return {
      success: true,
      data: scopeAssayerForRoles(assayer as any, rolesOf(req.user), req.user?.id === id),
    };
  }

  /**
   * Which profile fields the caller may edit.
   *
   * The mobile app previously had no way to know, so it rendered every field as editable and
   * reported success on a refusal. Serving the policy rather than duplicating the list in the
   * client keeps the two from drifting apart.
   */
  @Roles(SystemRole.ASSAYER, ...STAFF_ROLES)
  @Get('profile/editable-fields')
  @ApiOperation({ summary: 'Fields the current caller may self-edit, and those HR maintains' })
  async getEditableFields(@Req() req: any) {
    const isStaff = rolesOf(req.user).some((r) => STAFF_ASSAYER_EDITORS.includes(r));
    return {
      success: true,
      data: {
        selfEditable: isStaff ? null : SELF_EDITABLE_FIELDS,
        hrMaintained: isStaff ? [] : HR_MAINTAINED_FIELDS,
        // null selfEditable means "no restriction" — staff edit the whole record.
        unrestricted: isStaff,
      },
    };
  }

  // The assayer app reads this for the signed-in user; it authenticates already.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.ASSAYER)
  @Get(':assayerId/profile')
  @ApiOperation({ summary: 'Get detailed profile with stats for an assayer (by UUID or assayer code)' })
  async getProfile(@Param('assayerId') assayerId: string, @Req() req: any) {
    const assayer = await this.assayerService.getProfile(assayerId);
    return {
      success: true,
      data: scopeAssayerForRoles(assayer as any, rolesOf(req.user), req.user?.id === assayerId),
    };
  }

  // Was @Public(): unauthenticated callers could rewrite any assayer's banking
  // details, contact information and workload limits.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.ASSAYER)
  @Put(':id')
  @ApiOperation({ summary: 'Update assayer contact, banking, or operational details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssayerRequestDto,
    @Req() req: any,
  ) {
    // ASSAYER is on this route so the mobile app can maintain its own profile.
    // Without these two checks that also let any assayer rewrite any *other*
    // assayer's record — including their bank account — which is what the role
    // list alone permitted.
    const roles = rolesOf(req.user);
    const isStaff = roles.some((r) => STAFF_ASSAYER_EDITORS.includes(r));
    if (!isStaff) {
      if (req.user?.id !== id) {
        throw new ForbiddenException('You may only update your own profile');
      }
      // The DTO class declares every optional field, so they all exist as own
      // properties set to undefined — only the ones actually sent count.
      const attempted = Object.entries(dto ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      const forbidden = attempted.filter((f) => !SELF_EDITABLE_FIELDS.includes(f));
      if (forbidden.length) {
        throw new ForbiddenException(
          `These fields are maintained by HR and cannot be self-edited: ${forbidden.join(', ')}`,
        );
      }
    }

    const updatedBy = req.user?.id && /^[0-9a-fA-F-]{36}$/.test(req.user.id) ? req.user.id : id;
    const assayer = await this.assayerService.update(id, dto, updatedBy);
    return {
      success: true,
      data: assayer,
    };
  }

  /**
   * Live-location sharing (mobile). Updates the assayer's live position without
   * touching their home address. Live coordinates only feed the recommendation
   * engine when live sharing is also enabled. Self-only — an assayer can only
   * update their own live position, never another assayer's.
   */
  @Put(':id/live-location')
  @Roles(SystemRole.ASSAYER, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Update the authenticated assayer\'s live location (opt-in)' })
  async updateLiveLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLiveLocationDto,
    @Req() req: any,
  ) {
    if (req.user?.id !== id) {
      throw new ForbiddenException('You may only update your own live location');
    }
    const assayer = await this.assayerService.updateLiveLocation(
      id, dto.latitude, dto.longitude, req.user?.id ?? id,
    );
    return { success: true, data: assayer };
  }

  /**
   * Toggle live-location sharing for the authenticated assayer. Off by default.
   * Only assayers with this enabled are ranked by their live coordinate.
   */
  @Put(':id/live')
  @Roles(SystemRole.ASSAYER, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Enable or disable the authenticated assayer\'s live-location sharing' })
  async setLiveTracking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLiveTrackingDto,
    @Req() req: any,
  ) {
    if (req.user?.id !== id) {
      throw new ForbiddenException('You may only change your own live-location sharing');
    }
    const assayer = await this.assayerService.setLiveTracking(
      id, dto.enabled, req.user?.id ?? id,
    );
    return { success: true, data: assayer };
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Soft delete assayer profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.remove(id, req.user.id);
  }

  // Commercial Profile CRUD APIs
  @Get('commercial/roster')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.FINANCE_MANAGER)
  @ApiOperation({ summary: "Every assayer's commercial terms in force today, in one call" })
  async getRosterCommercialProfiles() {
    return { success: true, data: await this.assayerService.getRosterCommercialProfiles() };
  }

  @Post(':assayerId/commercial')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Create a commercial profile for an assayer' })
  async createCommercial(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateCommercialProfileRequestDto,
    @Req() req: any,
  ) {
    const profile = await this.assayerService.createCommercialProfile(assayerId, dto, req.user.id);
    return {
      success: true,
      data: profile,
    };
  }

  @Put('commercial/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Update a commercial profile by ID' })
  async updateCommercial(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommercialProfileRequestDto,
    @Req() req: any,
  ) {
    const profile = await this.assayerService.updateCommercialProfile(id, dto, req.user.id);
    return {
      success: true,
      data: profile,
    };
  }

  // Fee rates are commercially sensitive — staff only.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.FINANCE_MANAGER)
  @Get(':assayerId/commercial')
  @ApiOperation({ summary: 'Get all commercial profiles for an assayer' })
  async getCommercials(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const profiles = await this.assayerService.getCommercialProfiles(assayerId);
    return {
      success: true,
      data: profiles,
    };
  }

  @Get(':assayerId/commercial/active')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.FINANCE_MANAGER)
  @ApiOperation({ summary: 'Get currently active commercial profile for an assayer' })
  async getActiveCommercial(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('date') dateStr?: string,
  ) {
    const date = dateStr ? new Date(dateStr) : new Date();
    const profile = await this.assayerService.getActiveCommercialProfile(assayerId, date);
    return {
      success: true,
      data: profile,
    };
  }

  // Workforce Attribute CRUD APIs
  @Get('workforce-attribute/vocabulary')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Distinct skills, languages and certifications already in use across the roster' })
  async getWorkforceAttributeVocabulary() {
    return { success: true, data: await this.assayerService.getWorkforceAttributeVocabulary() };
  }

  @Post(':assayerId/workforce-attribute')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Add a skill, certification, or language to an assayer profile' })
  async addWorkforceAttribute(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateWorkforceAttributeRequestDto,
    @Req() req: any,
  ) {
    const attr = await this.assayerService.addWorkforceAttribute(assayerId, dto, req.user.id);
    return {
      success: true,
      data: attr,
    };
  }

  @Put('workforce-attribute/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Update a workforce attribute by ID' })
  async updateWorkforceAttribute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkforceAttributeRequestDto,
    @Req() req: any,
  ) {
    const attr = await this.assayerService.updateWorkforceAttribute(id, dto, req.user.id);
    return {
      success: true,
      data: attr,
    };
  }

  @Delete('workforce-attribute/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Remove a workforce attribute by ID' })
  async removeWorkforceAttribute(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.assayerService.removeWorkforceAttribute(id, req.user.id);
    return {
      success: true,
      data: { message: 'Workforce attribute removed successfully' },
    };
  }

  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @Get(':assayerId/workforce-attribute')
  @ApiOperation({ summary: 'Get workforce attributes for an assayer' })
  async getWorkforceAttributes(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('type') type?: string,
  ) {
    const attrs = await this.assayerService.getWorkforceAttributes(assayerId, type);
    return {
      success: true,
      data: attrs,
    };
  }

  // Lifecycle management
  @Post('bulk/lifecycle')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Transition a batch of assayers forward to a target lifecycle stage' })
  async bulkTransitionLifecycle(
    @Body() dto: BulkTransitionLifecycleDto,
    @Req() req: any,
  ) {
    const result = await this.assayerService.bulkTransitionLifecycle(dto.ids, dto.targetStatus, req.user.id, dto.reason);
    return { success: true, data: result };
  }

  @Post(':id/lifecycle')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Transition assayer lifecycle status' })
  async transitionLifecycle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionLifecycleDto,
    @Req() req: any,
  ) {
    const assayer = await this.assayerService.transitionLifecycle(id, dto.targetStatus, req.user.id, dto.reason);
    return { success: true, data: assayer };
  }

  // Government Documents
  @Post(':assayerId/government-document')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Add a government document to an assayer' })
  async addGovernmentDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateGovernmentDocumentRequestDto,
    @Req() req: any,
  ) {
    assertSelfOrPrivileged(req.user, assayerId, 'upload documents');
    const doc = await this.assayerService.addGovernmentDocument(assayerId, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Put('government-document/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Update a government document verification status' })
  async updateGovernmentDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGovernmentDocumentRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.assayerService.updateGovernmentDocument(id, dto, req.user.id);
    return { success: true, data: doc };
  }

  // Government identity documents — staff only.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @Get(':assayerId/government-document')
  @ApiOperation({ summary: 'List government documents for an assayer' })
  async getGovernmentDocuments(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const docs = await this.assayerService.getGovernmentDocuments(assayerId);
    return { success: true, data: docs };
  }

  @Delete('government-document/:id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Soft delete a government document' })
  async removeGovernmentDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.removeGovernmentDocument(id, req.user.id);
  }

  // Assayer Documents
  @Post(':assayerId/document')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Upload a new versioned document for an assayer' })
  async addAssayerDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateAssayerDocumentRequestDto,
    @Req() req: any,
  ) {
    assertSelfOrPrivileged(req.user, assayerId, 'upload documents');
    const doc = await this.assayerService.addAssayerDocument(assayerId, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Put(':assayerId/document/:docId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Update document metadata' })
  async updateAssayerDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() dto: UpdateAssayerDocumentRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.assayerService.updateAssayerDocument(docId, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Get(':assayerId/document')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'List documents for an assayer' })
  async getAssayerDocuments(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const docs = await this.assayerService.getAssayerDocuments(assayerId);
    return { success: true, data: docs };
  }

  @Delete('document/:id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Soft delete an assayer document' })
  async removeAssayerDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.removeAssayerDocument(id, req.user.id);
  }

  // Remarks
  // Remarks form part of the performance record; only staff may write them.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @Post(':assayerId/remark')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a remark to an assayer profile' })
  async addRemark(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateRemarkRequestDto,
    @Req() req: any,
  ) {
    const authorId = req.user?.id && /^[0-9a-fA-F-]{36}$/.test(req.user.id) ? req.user.id : assayerId;
    const authorName = req.user?.name || req.user?.email || 'Operations Manager';
    const remark = await this.assayerService.addRemark(assayerId, dto, authorId, authorName);
    return { success: true, data: remark };
  }

  @Put(':assayerId/remark/:remarkId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Update a remark' })
  async updateRemark(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('remarkId', ParseUUIDPipe) remarkId: string,
    @Body() dto: UpdateRemarkRequestDto,
    @Req() req: any,
  ) {
    const remark = await this.assayerService.updateRemark(remarkId, dto, req.user.id);
    return { success: true, data: remark };
  }

  @Delete(':assayerId/remark/:remarkId')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Delete a remark' })
  async removeRemark(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('remarkId', ParseUUIDPipe) remarkId: string,
    @Req() req: any,
  ): Promise<void> {
    await this.assayerService.removeRemark(remarkId, req.user.id);
  }

  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @Get(':assayerId/remark')
  @ApiOperation({ summary: 'List remarks for an assayer' })
  async getRemarks(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('visibility') visibility?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { remarks, total } = await this.assayerService.getRemarks(assayerId, visibility, page, limit);
    return {
      success: true,
      data: remarks,
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  // Activity Timeline
  @Get(':assayerId/activity')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Get activity timeline for an assayer' })
  async getActivityTimeline(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { activities, total } = await this.assayerService.getActivityTimeline(assayerId, page, limit);
    return {
      success: true,
      data: activities,
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  // HR run workforce imports now, so they need the template they are importing against.
  @Get('/template/download')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Download Excel template for assayer data entry' })
  async downloadTemplate(@Res() res: any) {
    const buffer = await this.assayerService.generateTemplate();
    const filename = encodeURIComponent('assayer_upload_template.xlsx');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
    });
    res.send(buffer);
  }

  @Post('/upload')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @RequirePermissions('assayer:create:organization')
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
  @ApiOperation({ summary: 'Upload assayers from Excel spreadsheet' })
  async uploadAssayers(@UploadedFile() file: any, @Req() req: any) {
    // A submitted form with no file attached reaches here as `undefined`, and reading
    // `.buffer` off it threw a TypeError the caller saw as "Internal server error". Ops
    // needs to be told to pick a file, not shown a crash.
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    const result = await this.assayerService.uploadFromExcel(file.buffer, req.user.id);
    return {
      success: true,
      data: result,
    };
  }

  /**
   * The assayer's own password change. `@AnyAuthenticated()` rather than `@Roles(ASSAYER)`
   * so that the route is reachable by the principal it is about, whose token carries the
   * synthetic ASSAYER role; the service verifies the current password before changing it.
   */
  @Post('me/change-password')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Change your own password (assayer)' })
  async changeMyPassword(@Body() dto: ChangeOwnPasswordRequestDto, @Req() req: any) {
    if (!dto?.currentPassword || !dto?.newPassword) {
      throw new BadRequestException('Please enter your current password and your new password.');
    }
    await this.assayerService.changeOwnPassword(req.user.id, dto.currentPassword, dto.newPassword);
    return { success: true, message: 'Your password has been changed.' };
  }

  /** HR/admin recovery path for an assayer who cannot sign in. */
  @Post(':assayerId/reset-password')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: "Reset an assayer's password (HR/admin)" })
  async resetAssayerPassword(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: ResetAssayerPasswordRequestDto,
    @Req() req: any,
  ) {
    const result = await this.assayerService.resetPasswordByStaff(assayerId, dto?.newPassword, req.user.id);
    return {
      success: true,
      // Present only when the server generated the password; shown to HR once and never stored
      // in readable form. When HR set the password themselves it is echoed back to no one.
      temporaryPassword: result.generatedPassword,
      message: result.generatedPassword
        ? 'Temporary password generated. Read it to the assayer now — it will not be shown again.'
        : 'Password reset. Ask the assayer to sign in with it and change it.',
    };
  }

}

