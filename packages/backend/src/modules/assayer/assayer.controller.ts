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
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
// The one place the upload rules live — see modules/document/upload-validation.ts. A second copy
// here is how four upload paths came to disagree about what they accept.
import { assertUploadAllowed, SCAN_UPLOAD_TYPES } from '../document/upload-validation';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsEmail, IsArray, IsInt, IsObject, IsEnum, IsDateString, IsUUID, IsBoolean, MinLength, MaxLength, ValidateNested, ArrayMaxSize, Matches } from 'class-validator';
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
import { LocationTrailService } from './location-trail.service';
import { LocationPingSource } from './assayer-location-ping.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public, AnyAuthenticated } from '../auth/guards';
import { SystemRole, AssayerLifecycleStatus, AssayerEngagementType, AssayerUnavailableReason } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { scopeAssayerForRoles, scopeAssayerListForRoles, rolesOf, assertSelfOrPrivileged } from './assayer-visibility';
import { RosterImportService } from './roster-import.service';
import { RosterRecordsService } from './roster-records.service';
import { QualificationScoreService } from './qualification-score.service';
import { STAFF_ROLES } from '../auth/staff-roles';

/** Roles that may edit any assayer's record; everyone else is limited to their own. */
const STAFF_ASSAYER_EDITORS: string[] = [
  SystemRole.ADMIN,
  SystemRole.OPERATIONS,
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
  /**
   * Optional: leave it out and the server allocates the next free code.
   *
   * The web form used to derive one from the number of assayers it had listed, which is a count
   * of *active* people. Deleted assayers keep their codes, so the first create after any delete
   * proposed a code that was already taken and was refused — and two people creating at the same
   * moment were handed the same code. Only the server can see every code that exists.
   */
  @IsOptional() @IsString() @IsNotEmpty()
  assayerCode?: string;

  @IsString() @IsNotEmpty()
  firstName: string;

  @IsString() @IsNotEmpty()
  lastName: string;

  @IsOptional() @IsEmail()
  email?: string;

  // Optional on admission: rosters arrive without a phone column, and a missing number blocks
  // ringing this person, not recording them. See the column comment on AssayerEntity.phone.
  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  alternatePhone?: string;

  // Address, district and city complete a record; state is what makes it plannable (it drives
  // region, zone and the public-holiday calendar), so state is the one that stays mandatory.
  // This mirrors the branch importer, which refuses a row for a missing state and nothing else.
  @IsOptional() @IsString()
  address?: string;

  @IsString() @IsNotEmpty()
  state: string;

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

  /**
   * `photograph` is deliberately NOT accepted here.
   *
   * The column holds a storage key, and `RosterRecordsService` is its single writer — it keeps
   * the key in step with the PHOTOGRAPH document row, so the picture shown to a branch is one
   * that exists on file. Accepting it on the request body let any ADMIN/OPERATIONS caller write
   * an arbitrary key with no document behind it, and `GET /assayers/:id/photo` then streamed
   * whatever that key pointed at — an object-store read primitive by way of a profile field.
   * Upload the document; the key follows.
   */

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

  /**
   * Facts the appraiser roster carries.
   *
   * The service interface and this class have to be extended together: the global validation
   * pipe whitelists against *this*, so a field added only to `UpdateAssayerDto` is stripped
   * before the service ever sees it — the request succeeds, the value is silently dropped, and
   * the form reports a save that did not happen.
   */
  @IsOptional() @IsString()
  aadhaarNumber?: string;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsDateString()
  dateOfBirth?: string;

  @IsOptional() @IsString()
  qualification?: string;

  @IsOptional() @IsString()
  vstsCode?: string;

  @IsOptional() @IsString()
  hrOwnerName?: string;

  @IsOptional() @IsEnum(AssayerEngagementType)
  engagementType?: AssayerEngagementType;

  @IsOptional() @IsEnum(AssayerUnavailableReason)
  unavailableReason?: AssayerUnavailableReason;
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

  /**
   * `photograph` is deliberately NOT accepted here.
   *
   * The column holds a storage key, and `RosterRecordsService` is its single writer — it keeps
   * the key in step with the PHOTOGRAPH document row, so the picture shown to a branch is one
   * that exists on file. Accepting it on the request body let any ADMIN/OPERATIONS caller write
   * an arbitrary key with no document behind it, and `GET /assayers/:id/photo` then streamed
   * whatever that key pointed at — an object-store read primitive by way of a profile field.
   * Upload the document; the key follows.
   */

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

  /**
   * The service interface and this class must be extended together: the global validation pipe
   * whitelists against *this*, so a field added only to `UpdateAssayerDto` is stripped before the
   * service sees it. `update-dto-parity.spec.ts` fails the build when they drift.
   */
  @IsOptional() @IsString()
  aadhaarNumber?: string;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsDateString()
  dateOfBirth?: string;

  @IsOptional() @IsString()
  qualification?: string;

  @IsOptional() @IsString()
  vstsCode?: string;

  @IsOptional() @IsString()
  hrOwnerName?: string;

  @IsOptional() @IsEnum(AssayerEngagementType)
  engagementType?: AssayerEngagementType;

  @IsOptional() @IsEnum(AssayerUnavailableReason)
  unavailableReason?: AssayerUnavailableReason;
}

export class UpdateLiveLocationDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  /**
   * Set by clients that record and upload their own movement trail via the batch endpoint.
   *
   * The trail append on this route (see `updateLiveLocation` below) exists so that a handset which
   * only knows how to push its live position still leaves a history behind. A client that queues
   * its own fixes does not need that, and letting it happen anyway writes a second row for every
   * position — the same place, a different timestamp, no extra evidence.
   *
   * Absent means "an older build that does not queue", which is the only safe default: mirroring a
   * fix that was already recorded costs a row, while skipping one that was not loses it for good.
   */
  @IsOptional() @IsBoolean()
  trailSelfManaged?: boolean;
}

/** One position in an uploaded batch. Coordinate sanity is enforced again in the service. */
export class LocationPingDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional() @IsNumber()
  accuracyMeters?: number;

  @IsOptional() @IsNumber()
  speedMps?: number;

  /** Device clock at the moment of the fix. */
  @IsDateString()
  recordedAt: string;

  @IsOptional() @IsUUID()
  assignmentId?: string;

  /** The OS reported this fix as coming from a mock provider — recorded, never silently dropped. */
  @IsOptional() @IsBoolean()
  isMocked?: boolean;
}

export class UploadLocationPingsDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => LocationPingDto)
  pings: LocationPingDto[];
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
  constructor(
    private readonly assayerService: AssayerService,
    private readonly rosterImport: RosterImportService,
    private readonly rosterRecords: RosterRecordsService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    private readonly regionGuard: RegionGuardService,
    private readonly locationTrail: LocationTrailService,
    private readonly qualificationScores: QualificationScoreService,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR, SystemRole.DESK, SystemRole.DESK_OPERATOR)
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

  /**
   * The pool the live map draws. Eleven fields per person plus their bank empanelments and
   * whether they are committed somewhere today — never the full record; the map renders pins,
   * not dossiers. Region-scoped exactly like the list above, and passed through the same
   * role-based redaction.
   */
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @Get('/map-roster')
  @ApiOperation({ summary: 'Every active assayer as the map needs them: pin facts, bank standings, committed-today' })
  async mapRoster(@Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    const roster = await this.assayerService.mapRoster(scope);
    return {
      success: true,
      data: scopeAssayerListForRoles(roster as any[], rolesOf(req.user), req.user?.id),
    };
  }

  /**
   * The cells the roster import could not read.
   *
   * Declared above `@Get(':id')` deliberately: Nest matches in declaration order and that route's
   * `ParseUUIDPipe` would reject "roster" with a 400 rather than falling through to here.
   */
  @Get('roster/import-issues')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'List cells the roster import could not read' })
  async listImportIssues(
    @Query('includeResolved') includeResolved?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.rosterRecords.listIssues({
      includeResolved: String(includeResolved ?? '').toLowerCase() === 'true',
      limit: limit ? Number(limit) : undefined,
    });
    return { success: true, data };
  }

  @Post('roster/import-issues/:id/resolve')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Close an import issue with an account of what was decided' })
  async resolveImportIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { resolution: string },
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.resolveIssue(id, body?.resolution, req.user.id);
    return { success: true, data };
  }

  /**
   * Whoever may see the roster may open a row on it.
   *
   * These two lists drifted apart in the role consolidation: the list above admitted the desk
   * and the auditor, this one did not. So the roster rendered for them and every row led to a
   * 403, which the web app turns into a bounce back to the dashboard. What each caller is
   * allowed to *see* of the record is decided below by `visibleFor`, not by the door.
   */
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single assayer by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // Field redaction (scopeAssayerForRoles) decides WHICH fields a role sees; this decides
    // WHETHER a region-assigned account may open the record at all. HR and the other national
    // desks hold no assignment, so this is a no-op for them.
    await this.regionGuard.assertAssayerInScope(id, scope);
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @Get(':assayerId/profile')
  @ApiOperation({ summary: 'Get detailed profile with stats for an assayer (by UUID or assayer code)' })
  async getProfile(@Param('assayerId') assayerId: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    const assayer = await this.assayerService.getProfile(assayerId);
    return {
      success: true,
      data: scopeAssayerForRoles(assayer as any, rolesOf(req.user), req.user?.id === assayerId),
    };
  }

  // Was @Public(): unauthenticated callers could rewrite any assayer's banking
  // details, contact information and workload limits.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
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
  /**
   * The assayer fixes their OWN base location on the map from the app. Distinct from
   * live-location above: this is the home/base coordinate planning uses, saved as a manual pin
   * (never re-geocoded). Self-only for an assayer; staff may set it for anyone.
   */
  @Put(':id/base-location')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Confirm the authenticated assayer\'s base location from their device GPS' })
  async confirmBaseLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLiveLocationDto,
    @Req() req: any,
  ) {
    const isStaff = rolesOf(req.user).some((r) => STAFF_ASSAYER_EDITORS.includes(r));
    if (!isStaff && req.user?.id !== id) {
      throw new ForbiddenException('You may only set your own location');
    }
    const assayer = await this.assayerService.confirmBaseLocation(
      id, dto.latitude, dto.longitude, req.user?.id ?? id,
    );
    return { success: true, data: assayer };
  }

  @Put(':id/live-location')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
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
    /**
     * The same fix is also appended to the movement trail — unless the client keeps its own.
     *
     * `assayers.live_location` is a single column overwritten by every push — it answers "where
     * are they now?" and destroys the history that a travel allowance is actually paid against.
     * Appending here means a trail accumulates from an app that only knows how to push its live
     * position, without waiting for a mobile release to adopt the batch endpoint below.
     *
     * Current builds do queue their own fixes and say so, and for those this append is pure
     * duplication: the same position under a server clock instead of the device's, adding a row to
     * a table that will hold millions of them and no evidence to the journey. So it is skipped for
     * them and kept for everyone else, because handsets in the field are updated by hand and old
     * builds will be sending live positions for a long while yet.
     */
    if (!dto.trailSelfManaged) {
      await this.locationTrail
        .record(id, dto.latitude, dto.longitude, {
          source: LocationPingSource.APP_TRACKING,
          recordedBy: req.user?.id ?? id,
        })
        // The live position has already been saved by the time this runs; failing the request now
        // would report an error for an update that succeeded, and make the app retry a push it
        // already delivered.
        .catch(() => undefined);
    }
    return { success: true, data: assayer };
  }

  /**
   * Upload a batch of positions recorded on the device.
   *
   * The batch shape is what makes tracking work where the work happens: an assayer in a rural area
   * or a bank basement has no signal for long stretches, and a one-fix-per-request design simply
   * loses that time. The app queues fixes and flushes them when it reconnects; duplicates from a
   * retried flush are ignored on a unique index rather than double-counted, because inflating a
   * distance is precisely the failure this record exists to prevent.
   */
  @Post(':id/location-pings')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Upload a batch of recorded positions for the authenticated assayer' })
  async uploadLocationPings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadLocationPingsDto,
    @Req() req: any,
  ) {
    // An assayer may only write their own trail: a movement record another field user can write
    // into is not evidence of anything. HR/admin retain access for attributed corrections, and
    // `createdBy` on each row records who actually submitted it.
    assertSelfOrPrivileged(req.user, id, 'upload positions');
    const result = await this.locationTrail.ingest(id, dto.pings, req.user?.id ?? id);
    return { success: true, data: result };
  }

  /**
   * Toggle live-location sharing for the authenticated assayer. Off by default.
   * Only assayers with this enabled are ranked by their live coordinate.
   */
  @Put(':id/live')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Soft delete assayer profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.remove(id, req.user.id);
  }

  // Commercial Profile CRUD APIs
  @Get('commercial/roster')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: "Every assayer's commercial terms in force today, in one call" })
  async getRosterCommercialProfiles() {
    return { success: true, data: await this.assayerService.getRosterCommercialProfiles() };
  }

  @Post(':assayerId/commercial')
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Distinct skills, languages and certifications already in use across the roster' })
  async getWorkforceAttributeVocabulary() {
    return { success: true, data: await this.assayerService.getWorkforceAttributeVocabulary() };
  }

  @Post(':assayerId/workforce-attribute')
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Remove a workforce attribute by ID' })
  async removeWorkforceAttribute(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.assayerService.removeWorkforceAttribute(id, req.user.id);
    return {
      success: true,
      data: { message: 'Workforce attribute removed successfully' },
    };
  }

  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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

  // ── Roster records: references, client standing, vetting, paperwork ───
  //
  // These were columns in the spreadsheet before they were tables. They are grouped here rather
  // than spread across the controller because they answer one question together — may we send
  // this person out, and to whom — and `dossier` is how the workspace asks it.

  /**
   * ADMIN and OPERATIONS only, matching `FULL_ACCESS` in assayer-visibility.ts.
   *
   * The dossier carries background-check verdicts — criminal and civil cases — and the names and
   * personal phone numbers of third parties who acted as references. `assayer-visibility.ts`
   * states the rule for the other staff roles: enough to know who did the work, nothing about who
   * they are. This is entirely the second kind, and the redaction interceptor cannot help here —
   * it identifies assayers by their `assayerCode`, which a reference row does not carry.
   */
  @Get(':assayerId/dossier')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Everything the roster holds about one person beyond their own row' })
  async getDossier(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const data = await this.rosterRecords.dossier(assayerId);
    return { success: true, data };
  }

  // ── Qualification scores ──────────────────────────────────────────────────
  //
  // Same access rule as the dossier, for the same reason: the basis lines name background-check
  // verdicts and reference standing, which the redaction interceptor cannot reach inside
  // sub-rows. Scores are computed on read from the vetting tables; only overrides are stored.

  @Get(':assayerId/qualification')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'The qualification profile: 0–100 dimensions, overall score, weights, print summary' })
  async getQualification(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const data = await this.qualificationScores.qualification(assayerId);
    return { success: true, data };
  }

  @Get(':assayerId/qualification/partners')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'How qualified this person is for each partner, with standing and gaps' })
  async getPartnerQualifications(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const data = await this.qualificationScores.partnerQualifications(assayerId);
    return { success: true, data };
  }

  @Put(':assayerId/qualification/override')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Override one computed score, with a stated reason (audited)' })
  async setScoreOverride(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const data = await this.qualificationScores.setOverride(assayerId, body ?? {}, req.user.id);
    return { success: true, data };
  }

  @Delete('qualification/override/:id')
  @HttpCode(204)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Clear an override — the computed score comes back into force' })
  async clearScoreOverride(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.qualificationScores.clearOverride(id, req.user.id);
  }

  @Post(':assayerId/reference')
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Add a reference for an assayer' })
  async addReference(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.saveReference(assayerId, body, req.user.id);
    return { success: true, data };
  }

  @Put(':assayerId/reference/:id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Update a reference' })
  async updateReference(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.saveReference(assayerId, body, req.user.id, id);
    return { success: true, data };
  }

  @Post('reference/:id/checked')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Record that a reference was actually spoken to' })
  async markReferenceChecked(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { remarks?: string },
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.markReferenceChecked(id, req.user.id, body?.remarks);
    return { success: true, data };
  }

  @Delete('reference/:id')
  @HttpCode(204)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Remove a reference' })
  async removeReference(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.rosterRecords.removeReference(id, req.user.id);
  }

  @Put(':assayerId/empanelment/:clientId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: "Set this person's standing with one client" })
  async setEmpanelment(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.setEmpanelment(assayerId, clientId, body, req.user.id);
    return { success: true, data };
  }

  @Delete('empanelment/:id')
  @HttpCode(204)
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('assayer:delete:organization')
  @ApiOperation({ summary: 'Withdraw a client standing' })
  async removeEmpanelment(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.rosterRecords.removeEmpanelment(id, req.user.id);
  }

  /**
   * A check is added, never edited: the row is the grounds on which somebody was admitted to a
   * vault on a given date, and a later, different finding is a second fact rather than a
   * correction of the first.
   */
  @Post(':assayerId/background-check')
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Record a background or credit check' })
  async recordBackgroundCheck(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.recordBackgroundCheck(assayerId, body, req.user.id);
    return { success: true, data };
  }

  /**
   * Documents — one set of routes, for one record per document.
   *
   * There used to be three: a government-document register, a versioned file store, and the
   * joining checklist. Two were never written to in any environment while the third held 11,021
   * rows, and HR had three screens to check to answer one question. See the OneDocumentRecord
   * migration and `AssayerDocumentEntity`.
   *
   * `PUT` by requirement rather than `POST` by id, because a person has exactly one row per
   * requirement — the unique constraint says so — and "record that the NDA arrived" is setting a
   * known fact rather than creating an unknown one. There is nothing to create, and nothing to
   * choose between.
   */
  @Put(':assayerId/document/:requirement')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Record progress on one document' })
  async setDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('requirement') requirement: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    assertSelfOrPrivileged(req.user, assayerId, 'update documents');
    const data = await this.rosterRecords.setDocument(assayerId, requirement as any, body, req.user.id);
    return { success: true, data };
  }

  /**
   * The document itself, not just a note that it exists.
   *
   * The record could say a soft copy had arrived and hold nothing to show for it. An audit asks
   * to see the document; "somebody ticked a box in 2024" is not an answer.
   *
   * Goes through the same door as every other upload in this system — the shared allow-list and
   * size cap in `assertUploadAllowed`, the virus scanner, and the storage engine — rather than a
   * second set of rules that would drift from those.
   */
  @Post(':assayerId/document/:requirement/file')
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a scan or photograph to a document' })
  async attachDocumentFile(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('requirement') requirement: string,
    @UploadedFile() file: any,
    @Req() req: any,
  ) {
    assertSelfOrPrivileged(req.user, assayerId, 'attach documents');
    // A submitted form with no file reaches here as `undefined`; reading `.buffer` off it is a
    // TypeError the caller sees as "Internal server error" instead of "choose a file".
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    // Narrower than the general allow-list: an identity document is a picture or a PDF, never a
    // spreadsheet and never an unknown blob. `fileName` is passed so an octet-stream upload is
    // judged on its extension rather than waved through.
    assertUploadAllowed({
      contentType: file.mimetype,
      fileName: file.originalname,
      size: file.size,
      allowed: SCAN_UPLOAD_TYPES,
      hint: 'Photograph the document in better light rather than at higher resolution.',
    });
    const key = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype, file.size);
    const data = await this.rosterRecords.attachFile(assayerId, requirement as any, key, req.user.id);
    return { success: true, data };
  }

  /**
   * Streamed through the API rather than handed out as a signed URL.
   *
   * These are identity documents — an Aadhaar card, a PAN card, a passport page. A signed URL is
   * a bearer credential for that image that survives being pasted anywhere, and there is no
   * reason to create one when the only viewer is a logged-in workspace tab.
   */
  @Get('document/:id/file/:index')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Fetch one attached scan' })
  async getDocumentFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index') index: string,
    @Res() res: any,
  ): Promise<void> {
    const found = await this.rosterRecords.fileKey(id, Number(index));
    if (!found) throw new NotFoundException('No such file on this document.');
    const stream = await this.storage.getFileStream(found.key);
    // Served as an opaque download with nosniff: nothing uploaded to a personnel file should be
    // able to execute in this application's own origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${found.requirement}"`);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /**
   * The person's photograph, for a header or a list that has only their id.
   *
   * A convenience over the document route above rather than a second store: the key comes from
   * `assayers.photograph`, which the PHOTOGRAPH document keeps in step. Without it every caller
   * that wants a face has to fetch the whole dossier first, work out which row is the
   * photograph, and index into its files.
   *
   * Open to the roles that plan and dispatch: knowing who is turning up at a branch is the whole
   * point of a photograph on a personnel record.
   */
  @Get(':assayerId/photo')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: "Fetch the person's photograph" })
  async getPhoto(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Res() res: any): Promise<void> {
    const assayer = await this.assayerService.findOne(assayerId);
    if (!assayer?.photograph) throw new NotFoundException('No photograph on this record.');
    const stream = await this.storage.getFileStream(assayer.photograph);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  @Delete('document/:id/file/:index')
  @HttpCode(204)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Remove an attached scan' })
  async removeDocumentFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index') index: string,
    @Req() req: any,
  ): Promise<void> {
    const key = await this.rosterRecords.detachFile(id, Number(index), req.user.id);
    // The reference is gone whether or not the object was; a storage failure must not leave the
    // record pointing at something nobody can fetch.
    if (key) await this.storage.deleteFile(key).catch(() => undefined);
  }

  /**
   * Verifying is a separate action from recording, and a narrower one.
   *
   * Saying a document arrived is clerical. Saying its number matches the original is what a
   * client's branch relies on to admit somebody to a vault, so an assayer cannot do it to their
   * own record — which is why this route, unlike the one above, does not take `ASSAYER`.
   */
  @Post('document/:id/verify')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Record that an identity document was checked against the original' })
  async verifyDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { verdict: string; remarks?: string },
    @Req() req: any,
  ) {
    const data = await this.rosterRecords.verifyDocument(id, body?.verdict as any, req.user.id, body?.remarks);
    return { success: true, data };
  }

  // Staff remarks about an assayer live under /assayer-remarks (modules/assayer-remarks).

  // Activity Timeline
  @Get(':assayerId/activity')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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

  /**
   * Bring in the full appraiser roster spreadsheet.
   *
   * Separate from `/upload`, which takes the template this system publishes. This one reads the
   * roster as it is actually kept — 71 columns of HR, KYC, banking and compliance detail, one
   * of which holds three facts in a single cell — and spreads it across the tables that now
   * hold those things. See `RosterImportService` for the rules it follows.
   *
   * `dryRun` is the point of the endpoint as much as the import is: it does the entire read and
   * reports exactly what would happen without writing a row, because nobody should discover
   * what an import of 1,155 people does by running it.
   */
  @Post('/roster/import')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
  @ApiOperation({ summary: 'Import the appraiser roster workbook, or rehearse it with dryRun' })
  async importRoster(
    @UploadedFile() file: any,
    @Body() body: any,
    @Req() req: any,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose the roster workbook and try again.');
    }
    // Multipart carries everything as text, so "false" arrives as a non-empty string and would
    // be truthy — the one mistake here would silently turn a rehearsal into a real import.
    const dryRun = String(body?.dryRun ?? '').toLowerCase() === 'true';
    const summary = await this.rosterImport.importAssayerSheet(file.buffer, req.user.id, {
      dryRun,
      sheetName: body?.sheetName || undefined,
    });
    return { success: true, data: summary };
  }

  @Post('/upload')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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

