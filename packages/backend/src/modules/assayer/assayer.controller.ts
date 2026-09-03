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
import { memoryStorage } from 'multer';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
// The one place the upload rules live — see modules/document/upload-validation.ts. A second copy
// here is how four upload paths came to disagree about what they accept.
import { assertUploadAllowed, SCAN_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '../document/upload-validation';

/**
 * Same shape as `documentUploadMulterOptions` in document.controller.ts. All three routes below
 * share this ceiling: the identity-document scan goes through `assertUploadAllowed`'s default
 * `MAX_UPLOAD_BYTES` too (see `attachDocumentFile`), and the two roster/spreadsheet routes have
 * no app-level size check of their own for multer's cap to agree with, but there is no reason
 * for them to tolerate a larger request body than every other upload route in the system does.
 */
const assayerUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsEmail, IsArray, IsInt, IsObject, IsEnum, IsDateString, IsUUID, IsBoolean, IsIn, MinLength, MaxLength, ArrayMinSize, ValidateNested, ArrayMaxSize, Matches, ValidateBy, ValidationOptions } from 'class-validator';
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
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public, AnyAuthenticated, PasswordChangeExempt, OnboardingAllowed, RoleOnly } from '../auth/guards';
import {
  SystemRole,
  AssayerLifecycleStatus,
  AssayerEngagementType,
  AssayerUnavailableReason,
  SELF_EDITABLE_ASSAYER_FIELDS,
  HR_MAINTAINED_ASSAYER_FIELDS,
  isValidPan,
  isValidIfsc,
  isValidAadhaar,
  isPlaceholderAadhaar,
  normalisePhone,
  AADHAAR_PATTERN,
  ASSAYER_ERROR_CODES,
  AUTH_ERROR_CODES,
} from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { scopeAssayerForRoles, scopeAssayerListForRoles, rolesOf, assertSelfOrPrivileged } from './assayer-visibility';
import type { Response } from 'express';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { RosterImportService } from './roster-import.service';
import { ImportJobService } from '../import/import-job.service';
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
/**
 * Both lists now live in `@fapoms/shared` — see SELF_EDITABLE_ASSAYER_FIELDS there for the
 * reasoning about payroll diversion and scheduling. They were declared here, which meant the
 * mobile app had to guess the same policy separately and got it wrong; the API rejected edits
 * the phone had presented as editable, and the phone locked fields the API would have accepted.
 */
const SELF_EDITABLE_FIELDS = SELF_EDITABLE_ASSAYER_FIELDS;
const HR_MAINTAINED_FIELDS = HR_MAINTAINED_ASSAYER_FIELDS;

/**
 * The three values `assayers.preferred_contact_channel` accepts. A `varchar(10)` with no check
 * constraint behind it, so this list is the only thing standing between the column and a typo
 * that the dispatcher would silently read as "not APP, therefore PHONE".
 */
const CONTACT_CHANNELS = ['AUTO', 'APP', 'PHONE'] as const;

// ---------------------------------------------------------------------------
// Identity-field format gates (PAN / Aadhaar / IFSC / mobile)
// ---------------------------------------------------------------------------

/**
 * What may be recorded against one document requirement.
 *
 * This route took `@Body() body: any`, which means class-validator had nothing to attach to and
 * every field went through unchecked — on a route that writes `assayers.pan_number` and
 * `assayers.aadhaar_number` directly, because for PAN and Aadhaar the number deliberately lives on
 * the person rather than the document row. Create and update both carry `@IsPanFormat()` and
 * `@IsAadhaarNumber()`; this was a fourth path to the same two columns that validated nothing.
 *
 * The format rule for `documentNumber` cannot live here: which rule applies depends on the
 * `:requirement` route parameter, which a DTO cannot see. It is enforced in `setDocument` on the
 * service, using the same `@fapoms/shared` validators the DTOs use, so the two cannot disagree.
 */
class SetDocumentRequestDto {
  @IsOptional() @IsString() @MaxLength(50)
  documentNumber?: string;

  @IsOptional() @IsDateString()
  expiryDate?: string;

  @IsOptional() @IsBoolean()
  softCopyReceived?: boolean;

  @IsOptional() @IsBoolean()
  hardCopyReceived?: boolean;

  @IsOptional() @IsDateString()
  receivedAt?: string;

  @IsOptional() @IsString() @MaxLength(200)
  hardCopyLocation?: string;

  @IsOptional() @IsString() @MaxLength(200)
  courierReference?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  remarks?: string;
}


/**
 * These call the shared rulebook in `@fapoms/shared` (identity-validation.ts) — the same
 * functions the roster importer applies — so the form and the spreadsheet can never disagree
 * about what a valid number looks like. Until these existed, `POST/PUT /assayers` accepted any
 * string into these fields; the importer was the only gate, which is how 1,128 PANs and 578
 * Aadhaars are stored unvalidated today.
 *
 * Two behaviours are deliberate:
 *  - An EMPTY string passes. The web edit form sends `""` to clear a field (see
 *    `buildAssayerEditBody`), and erasing a junk legacy value must never be refused by the very
 *    rule that exists to keep junk out.
 *  - Absent and null fields are skipped entirely (`@IsOptional()` on every use). That is what
 *    protects records imported before validation existed: an update that corrects a phone
 *    number is not blocked by the invalid PAN already sitting on the row — only keys actually
 *    present in the request body are judged.
 *
 * A side effect worth naming: masked display values (`******234F`) fail every one of these, so
 * a client that round-trips a masked read back into an edit body is refused here instead of
 * overwriting the real number with asterisks.
 *
 * These are not the whole of that protection, though, and were never enough on their own:
 * `bankAccountNumber` has no format rule here and never could — bank account numbers have no
 * checkable shape — so the one field a payroll-diversion attempt would actually aim at fell
 * through. `assertNoMaskedPii` in AssayerService covers all three, and covers the write paths
 * that do not pass through this class at all.
 */
const identityFormatRule = (
  name: string,
  ok: (value: string) => boolean,
  message: string | ((value: unknown) => string),
) =>
  (options?: ValidationOptions): PropertyDecorator =>
    ValidateBy({
      name,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && (value.trim() === '' || ok(value)),
        defaultMessage: (args) =>
          typeof message === 'function' ? message(args?.value) : message,
      },
    }, options);

const IsPanFormat = identityFormatRule('isPanFormat', isValidPan,
  "This PAN doesn't look right — it should be 5 letters, 4 digits, 1 letter, like ABCDE1234F.");

const IsIfscFormat = identityFormatRule('isIfscFormat', isValidIfsc,
  "This IFSC code doesn't look right — it should be 4 letters, then a zero, then 6 letters or digits, like SBIN0001234.");

// Three failure modes, three messages: "wrong shape" sends the clerk to re-type, "checksum
// fails" sends them back to the card — a 12-digit slip LOOKS right on screen, so the message
// must say the number itself is off, not the format — and "all one digit" sends them to find a
// number that was never entered. That third branch is not cosmetic: `999999999999` PASSES
// Verhoeff and is refused by the all-same-digit rule ahead of the checksum, so without it the
// likeliest placeholder anyone types is reported as a mistyped digit and the clerk is sent to
// re-read a card against a number in which nothing is mistyped.
const IsAadhaarNumber = identityFormatRule('isAadhaarNumber', isValidAadhaar,
  (value) => {
    if (typeof value !== 'string' || !AADHAAR_PATTERN.test(value.trim())) {
      return 'An Aadhaar number is 12 digits — please enter all 12, without spaces.';
    }
    return isPlaceholderAadhaar(value)
      ? 'That looks like a placeholder rather than a real Aadhaar number — 12 identical digits. Please enter the number from the card, or leave the field empty until you have it.'
      : 'This doesn\'t match a real Aadhaar number — one digit looks mistyped or swapped. Please re-check it against the card.';
  });

const IsIndianMobile = identityFormatRule('isIndianMobile', (value) => normalisePhone(value) !== null,
  "This phone number doesn't look right — please enter a 10-digit Indian mobile number, like 98765 43210 (with or without +91).");

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
  @IsOptional() @IsString() @IsIndianMobile()
  phone?: string;

  // Same rule as `phone`. It carried a bare @IsString(), so the second number on a record — the
  // one used when the first does not answer — could be saved in any shape at all.
  @IsOptional() @IsString() @IsIndianMobile()
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

  @IsOptional() @IsString() @IsPanFormat()
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString() @IsIfscFormat()
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

  // Validated like the others, and this is the one it matters most for: the record marks it
  // `critical` because it is what duty-of-care for a field worker rests on, and an unusable
  // number there is discovered at the exact moment nobody can afford to discover it.
  @IsOptional() @IsString() @IsIndianMobile()
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
   * How offers reach this person. The column has existed since the channel work and was in
   * neither request DTO, so every one of the 1,163 roster rows still sits on the `AUTO` default
   * and HR had no way to say otherwise — see `CreateAssayerDto.preferredContactChannel`.
   */
  @IsOptional() @IsIn(CONTACT_CHANNELS)
  preferredContactChannel?: 'AUTO' | 'APP' | 'PHONE';

  /**
   * Facts the appraiser roster carries.
   *
   * The service interface and this class have to be extended together: the global validation
   * pipe whitelists against *this*, so a field added only to `UpdateAssayerDto` is stripped
   * before the service ever sees it — the request succeeds, the value is silently dropped, and
   * the form reports a save that did not happen.
   */
  @IsOptional() @IsString() @IsAadhaarNumber()
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

  @IsOptional() @IsString() @IsIndianMobile()
  phone?: string;

  // Same rule as `phone`. It carried a bare @IsString(), so the second number on a record — the
  // one used when the first does not answer — could be saved in any shape at all.
  @IsOptional() @IsString() @IsIndianMobile()
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

  @IsOptional() @IsString() @IsPanFormat()
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString() @IsIfscFormat()
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

  // Validated like the others, and this is the one it matters most for: the record marks it
  // `critical` because it is what duty-of-care for a field worker rests on, and an unusable
  // number there is discovered at the exact moment nobody can afford to discover it.
  @IsOptional() @IsString() @IsIndianMobile()
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

  /** See the same field on the create DTO — the column had no way in through either of them. */
  @IsOptional() @IsIn(CONTACT_CHANNELS)
  preferredContactChannel?: 'AUTO' | 'APP' | 'PHONE';

  /**
   * The service interface and this class must be extended together: the global validation pipe
   * whitelists against *this*, so a field added only to `UpdateAssayerDto` is stripped before the
   * service sees it. `update-dto-parity.spec.ts` fails the build when they drift.
   */
  @IsOptional() @IsString() @IsAadhaarNumber()
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

/**
 * A group of import issues closed under one account of what was decided.
 *
 * The 500 ceiling is the same one `RosterRecordsService.listIssues` serves at, so a batch can
 * close exactly what one screenful of the queue shows and no more. `@ArrayMinSize(1)` because an
 * empty batch is a request nobody meant to send — a "select all" over a filtered-to-nothing
 * queue — and answering it with a cheerful "0 resolved" reads as success.
 */
class BatchResolveImportIssuesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Choose at least one issue to close.' })
  @ArrayMaxSize(500, { message: 'Close at most 500 issues at a time.' })
  @IsUUID('4', { each: true, message: 'One of the issue ids is not a valid identifier.' })
  ids: string[];

  // One resolution for the whole group, and required for the same reason the single route
  // requires one: the queue exists because nothing was guessed, and closing a row with no account
  // of what was decided puts the guess back without a record of it.
  @IsString() @IsNotEmpty({ message: 'Say what was decided about these cells before closing them.' })
  resolution: string;
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
    private readonly importJobService: ImportJobService,
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
  // The roster list. Declared so a role built in Admin -> Roles can open the workforce console:
  // /hr admitted such a role while this refused it, so the console loaded and its list did not.
  @RequirePermissions('assayer:view:organization')
  @Get()
  @ApiOperation({ summary: 'List all registered assayers' })
  async findAll(
    @Req() req: any,
    @Query('page') page = 1,
    /**
     * Bounded, but generously — this is the route a screen uses to hold the whole roster.
     *
     * It was unclamped: `?limit=999999` returned every appraiser in one response, the same defect
     * just closed on `/assignments` and the audit routes. The ceiling here is 1,000 rather than
     * their 200 for the same reason the audit routes got 500: those routes page a long list, this
     * one exists to be exhausted. `/assayers` has no search parameter, so a picker that must let
     * any of 1,155 people be *found* has no option but to fetch them all — see
     * `frontend/src/services/assayer-roster.ts`, which pages against this and reports any shortfall
     * rather than silently listing fewer people than exist. A 200 ceiling would turn its two
     * requests into six for no gain. The default stays 20, so no existing caller changes.
     */
    @Query('limit', new ParseLimitPipe({ default: 20, max: 1000 })) limit: number,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const { assayers, total } = await this.assayerService.findAll(page, limit, scope);
    return {
      success: true,
      // Stripping for the roles that may not see identity or banking at all. The MASKING that
      // now applies to the roles that may — ADMIN, OPERATIONS — is not called here on purpose:
      // it lives in the same policy (`assayer-visibility.ts`) and is applied once for every
      // route by `AssayerRedactionInterceptor`. A mask call per service is the arrangement that
      // produced the original leak, and adding one back would recreate it.
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
  @RequirePermissions('assayer:view:organization')
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
  @RequirePermissions('assayer:view:organization')
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
   * Close a group of import issues in one request.
   *
   * The per-row route above is what the panel had, so closing the 68 rows one import problem
   * produced meant 68 requests — and a failure at row 40 left the group half closed, with no way
   * to tell from the queue which half. One decision was being recorded as sixty-eight, and
   * partially.
   *
   * The outcome is per id and the request never fails as a whole: an id that is already resolved
   * or does not exist is reported against that id and the rest still close. A group where one row
   * has been touched by somebody else must not be a reason to reopen the other sixty-seven.
   */
  @Post('roster/import-issues/resolve')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Close several import issues at once, with a per-id outcome for each' })
  async resolveImportIssues(@Body() dto: BatchResolveImportIssuesDto, @Req() req: any) {
    const data = await this.rosterRecords.resolveIssues(dto.ids, dto.resolution, req.user.id);
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
  @RequirePermissions('assayer:view:organization')
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
   * One sensitive identifier, in clear, with a row in the audit trail saying who looked.
   *
   * The reads above are masked, so this is the only way a PAN, an Aadhaar number or a bank
   * account leaves whole — which is what makes "who has seen this person's bank details" a
   * question with an answer. See `AssayerService.revealSensitiveField` for why the audit write
   * is awaited before the value is returned, and why the lookup ignores `isActive`.
   *
   * ADMIN and OPERATIONS only, matching `FULL_ACCESS` in assayer-visibility.ts: a role that
   * cannot see the masked field on the record has no business asking for the whole of it. Note
   * that this excludes the assayer themselves — an assayer cannot reveal their own PAN through
   * the API. They are holding the card.
   *
   * Declared next to `@Get(':id')` for readability, not for routing: three path segments cannot
   * be matched by the one-segment route above it.
   */
  @Get(':id/sensitive/:field')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  // No permission fall-through: this route shares `assayer:view:organization` with the masked
  // record read, deliberately, so a custom role holding the ordinary roster read must not also be
  // handed the full number. The narrow @Roles list is the gate, and @RoleOnly() is what keeps it
  // one now that permissions are otherwise authoritative.
  @RoleOnly()
  // The vocabulary has one read action per resource, so the unmasked value asks for the same
  // permission as the masked record. What actually holds the line here is the narrow @Roles list
  // above and the audit row the service writes — not a permission of its own.
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Reveal one masked identifier (pan | aadhaar | bank), recording who asked' })
  async revealSensitiveField(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('field') field: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The same door check the record itself gets. Without it a region-scoped operator who may
    // not open an assayer's page could still read that assayer's bank account one field at a
    // time, which is the whole of what the page was hiding.
    await this.regionGuard.assertAssayerInScope(id, scope);
    const data = await this.assayerService.revealSensitiveField(id, field, {
      id: req.user?.id,
      displayName: req.user?.displayName ?? req.user?.username ?? null,
      ipAddress: req.ip ?? null,
    });
    return { success: true, data };
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
  @OnboardingAllowed()
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
  @OnboardingAllowed()
  /**
   * Reachable while a forced password change is pending — the assayer-principal counterpart of
   * `GET /users/me`. Two reasons, both from the mobile app's real behaviour (AuthContext /
   * MobileApiService.validateSession): this is where a restored session LEARNS it owes a
   * password change (the flag rides the profile response), and validateSession treats a 401/403
   * from this exact route as "credentials finished" and destroys the stored session — so
   * blocking it would sign the user out instead of walking them to the change screen. Access is
   * still authenticated and self-scoped (`assertSelfOrPrivileged` below); the exemption only
   * bypasses the rotation gate, no role or ownership check.
   */
  @PasswordChangeExempt()
  @ApiOperation({ summary: 'Get detailed profile with stats for an assayer (by UUID or assayer code)' })
  async getProfile(@Param('assayerId') assayerId: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // `isSelf` below only controlled REDACTION, never access — so an assayer could pull any
    // colleague's profile by id (name, code, phone, email, address, employment status) and get a
    // redacted-but-real record back. This refuses that outright: an assayer may read only their
    // own profile; staff are unaffected, and the mobile app only ever fetches its own id.
    assertSelfOrPrivileged(req.user, assayerId, 'view this profile');
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
  @OnboardingAllowed()
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
        throw withCode(
          new ForbiddenException('You may only update your own profile'),
          ASSAYER_ERROR_CODES.NOT_YOUR_RECORD,
        );
      }
      // The DTO class declares every optional field, so they all exist as own
      // properties set to undefined — only the ones actually sent count.
      const attempted = Object.entries(dto ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      const forbidden = attempted.filter((f) => !SELF_EDITABLE_FIELDS.includes(f));
      if (forbidden.length) {
        // Not a permissions failure, and the difference is the whole point of coding it: the
        // answer is "ask your HR contact", not "you should not be here". The field list is
        // interpolated, so the sentence is unmatchable by a translating client.
        throw withCode(
          new ForbiddenException(
            `These fields are maintained by HR and cannot be self-edited: ${forbidden.join(', ')}`,
          ),
          ASSAYER_ERROR_CODES.HR_MAINTAINED_FIELD,
        );
      }
    }

    const updatedBy = req.user?.id && /^[0-9a-fA-F-]{36}$/.test(req.user.id) ? req.user.id : id;
    const assayer = await this.assayerService.update(id, dto, updatedBy);
    return {
      success: true,
      // Unscoped by role, which is a pre-existing gap this change does not widen: the redaction
      // interceptor walks this response like any other, so the save echo is masked for staff and
      // stripped for anyone who may not read the fields at all. Without that it would be the
      // easiest unaudited way to obtain a PAN — PUT the record back unchanged and read the reply.
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
  @OnboardingAllowed()
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Confirm the authenticated assayer\'s base location from their device GPS' })
  async confirmBaseLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLiveLocationDto,
    @Req() req: any,
  ) {
    const isStaff = rolesOf(req.user).some((r) => STAFF_ASSAYER_EDITORS.includes(r));
    if (!isStaff && req.user?.id !== id) {
      throw withCode(
        new ForbiddenException('You may only set your own location'),
        ASSAYER_ERROR_CODES.NOT_YOUR_RECORD,
      );
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
      throw withCode(
        new ForbiddenException('You may only update your own live location'),
        ASSAYER_ERROR_CODES.NOT_YOUR_RECORD,
      );
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
      throw withCode(
        new ForbiddenException('You may only change your own live-location sharing'),
        ASSAYER_ERROR_CODES.NOT_YOUR_RECORD,
      );
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
  @RequirePermissions('assayer:view:organization')
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
  @RequirePermissions('assayer:view:organization')
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
  @RequirePermissions('assayer:view:organization')
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
  // Reads the values off the roster rather than a reference table, so it moves with the roster:
  // `assayer:view`, not `reference_data:view`.
  @RequirePermissions('assayer:view:organization')
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
  @RequirePermissions('assayer:view:organization')
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
  @RequirePermissions('assayer:view:organization')
  @Get(':assayerId/dossier')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
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

  @RequirePermissions('assayer:view:organization')
  @Get(':assayerId/qualification')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'The qualification profile: 0–100 dimensions, overall score, weights, print summary' })
  async getQualification(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const data = await this.qualificationScores.qualification(assayerId);
    return { success: true, data };
  }

  @Get(':assayerId/qualification/partners')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
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
  @OnboardingAllowed()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Record progress on one document' })
  async setDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('requirement') requirement: string,
    @Body() body: SetDocumentRequestDto,
    @Req() req: any,
  ) {
    assertSelfOrPrivileged(req.user, assayerId, 'update documents');

    /**
     * An assayer may not set their own PAN or Aadhaar here.
     *
     * For PAN_CARD and the two AADHAAR requirements the number is deliberately stored on the
     * PERSON, not the document row — so this route writes `assayers.pan_number` and
     * `assayers.aadhaar_number` directly. Both fields are in `HR_MAINTAINED_ASSAYER_FIELDS`, and
     * `PUT /assayers/:id` refuses a non-staff caller who touches them; `assertSelfOrPrivileged`
     * above only stops an assayer editing SOMEBODY ELSE, so without this a person could set their
     * own PAN through the paperwork screen — the field this codebase elsewhere calls the classic
     * payroll-diversion route — while the front door refuses exactly that write.
     *
     * They may still upload the scan and record that it arrived. It is the number a human has to
     * check against the document that stays HR's to enter.
     */
    const numberIsOnThePerson = ['PAN_CARD', 'AADHAAR_FRONT', 'AADHAAR_BACK'].includes(requirement);
    if (body?.documentNumber !== undefined && numberIsOnThePerson) {
      const roles = rolesOf(req.user);
      if (!roles.some((r) => STAFF_ASSAYER_EDITORS.includes(r))) {
        throw withCode(
          new ForbiddenException(
            'Your PAN and Aadhaar numbers are recorded by HR from the document itself. '
            + 'Upload the scan here and your HR contact will enter the number.',
          ),
          ASSAYER_ERROR_CODES.HR_MAINTAINED_FIELD,
        );
      }
    }

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
  @OnboardingAllowed()
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @UseInterceptors(FileInterceptor('file', assayerUploadMulterOptions), FileScanInterceptor)
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
      throw withCode(
        new BadRequestException('No file was uploaded. Choose a file and try again.'),
        ASSAYER_ERROR_CODES.UPLOAD_NO_FILE,
      );
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
  // A file download, but not `document:download`: that resource is the audit packet pipeline, and
  // a role granted it would then also read staff Aadhaar and PAN scans. This is one page of a
  // personnel record, so it follows the record.
  @RequirePermissions('assayer:view:organization')
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
  @RequirePermissions('assayer:view:organization')
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
  // One person's timeline, assembled from their own record — not the platform audit trail, which
  // `audit_log:view` gates and OPERATIONS does not hold.
  @RequirePermissions('assayer:view:organization')
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
  // The workbook is blank — column headings only — so this is a read of the roster's shape, not
  // of anyone in it, and `assayer:create` would refuse the template to whoever is preparing an
  // import for someone else to run.
  @RequirePermissions('assayer:view:organization')
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
  @UseInterceptors(FileInterceptor('file', assayerUploadMulterOptions), FileScanInterceptor)
  @ApiOperation({ summary: 'Import the appraiser roster workbook, or rehearse it with dryRun' })
  async importRoster(
    @UploadedFile() file: any,
    @Body() body: any,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose the roster workbook and try again.');
    }
    // Multipart carries everything as text, so "false" arrives as a non-empty string and would
    // be truthy — the one mistake here would silently turn a rehearsal into a real import.
    const dryRun = String(body?.dryRun ?? '').toLowerCase() === 'true';
    const sheetName = body?.sheetName || undefined;

    /**
     * The rehearsal stays in the request; the real import is queued.
     *
     * They are different acts. A rehearsal writes nothing and exists to answer a question the
     * operator is sitting there waiting for — "what would this do?" — so its answer has to come
     * back on the same request. The real run writes a person plus their references, background
     * checks, documents and empanelments, and geocodes each address; the web client was holding
     * the upload open for **fifteen minutes** to accommodate it, which is a page that cannot be
     * told apart from a hung one.
     *
     * The rehearsal also does all the parsing, so a wrong or unreadable file is still refused
     * immediately with a specific 400 — before anything is queued.
     */
    if (dryRun) {
      const summary = await this.rosterImport.importAssayerSheet(file.buffer, req.user.id, {
        dryRun: true,
        sheetName,
      });
      return { success: true, data: summary };
    }

    /**
     * Inspected, not rehearsed.
     *
     * This called `importAssayerSheet({ dryRun: true })` — written on the assumption that a dry run
     * is a cheap parse. It is not: a dry run performs the *entire* import inside a transaction and
     * rolls it back, roughly ten writes per row. For the real 1,155-person roster that is ~11,000
     * sequential statements holding one of twenty pool connections and taking row locks on
     * `assayers`, on the request thread — and then the queued job did all of it again for real.
     *
     * `inspectSheet` resolves the sheet, applies the same wrong-file guard and counts the rows,
     * opening no transaction and issuing no query. So an unreadable workbook — or the branch list
     * uploaded to the wrong screen — is still an immediate 400 with the same message, rather than a
     * cheerful 202 and a failure the operator has to go looking for.
     */
    const inspection = this.rosterImport.inspectSheet(file.buffer, sheetName);

    const job = await this.importJobService.enqueueRosterImport({
      actorId: req.user.id,
      fileBuffer: file.buffer,
      fileName: file.originalname ?? null,
      totalRows: inspection.rowsRead,
      sheetName: sheetName ?? null,
    });

    // 202: accepted, not done. The body says where to watch.
    res.status(202);
    return {
      success: true,
      data: {
        ...job,
        queued: true,
        statusUrl: `/assayers/roster/import-jobs/${job.jobId}`,
        message:
          `This roster has ${inspection.rowsRead} row(s). Each one writes a person along with their ` +
          `references, checks, documents and empanelments, and their address is looked up — so the ` +
          `import is running in the background. It does not need this page kept open.`,
      },
    };
  }

  /**
   * State and result of a queued roster import.
   *
   * Scoped to the person who started it: the roster is one national list, so there is no project
   * or client to check a job id against, and Bull's ids are a per-queue counter that would
   * otherwise be trivially enumerable — over results that name real people, their PANs and their
   * home addresses.
   */
  @Get('/roster/import-jobs/:jobId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'State and result of a queued roster import' })
  async getRosterImportJob(@Param('jobId') jobId: string, @Req() req: any) {
    return { success: true, data: await this.importJobService.getRosterImportStatus(req.user.id, jobId) };
  }

  /**
   * `POST /assayers/upload` was removed — see `AssayerService` for why. Assayer imports go through
   * `POST /assayers/roster/import`, which every caller already used.
   */

  /**
   * The assayer's own password change. `@AnyAuthenticated()` rather than `@Roles(ASSAYER)`
   * so that the route is reachable by the principal it is about, whose token carries the
   * synthetic ASSAYER role; the service verifies the current password before changing it.
   */
  @Post('me/change-password')
  @OnboardingAllowed()
  @AnyAuthenticated()
  // The one action a principal with a pending forced change MUST be able to take (the assayer
  // counterpart of POST /users/me/change-password). Without this, enforcing mustChangePassword
  // on assayer principals would lock the account into a loop: every route 403s, including the
  // only route that clears the 403.
  @PasswordChangeExempt()
  @ApiOperation({ summary: 'Change your own password (assayer)' })
  async changeMyPassword(@Body() dto: ChangeOwnPasswordRequestDto, @Req() req: any) {
    if (!dto?.currentPassword || !dto?.newPassword) {
      throw withCode(
        new BadRequestException('Please enter your current password and your new password.'),
        AUTH_ERROR_CODES.PASSWORD_FIELDS_MISSING,
      );
    }
    await this.assayerService.changeOwnPassword(req.user.id, dto.currentPassword, dto.newPassword);
    return { success: true, message: 'Your password has been changed.' };
  }

  /**
   * Issue app access to an assayer — a one-time invitation, not a recovery.
   *
   * The only route to a credential before this was `reset-password`, which is the path for
   * somebody locked out and says so on screen; first-time access was being handed out as a reset
   * of a password that had never existed. The response is a shown-once card: the temporary
   * password is returned here and nowhere else, ever, and only its hash is stored.
   *
   * `canSignInNow` says whether the password works at all and `accessScope` how far it reaches,
   * because those are two questions. The four onboarding stages do sign in (`ONBOARDING_SIGN_IN`
   * in auth.service.ts), into a session confined to finishing their own registration, so
   * mid-onboarding the card reports true and REGISTRATION_ONLY rather than "not yet". False is
   * left for the statuses no session is issued to at all — suspended, inactive, departed — where
   * the card has to say the credential will not work instead of letting HR find out from the
   * assayer's phone call. Issuing access mid-onboarding is deliberately allowed, because the
   * handover happens when the person is in front of you. What must never happen is the reverse:
   * nothing in activation may require app access to have been issued — see the note on
   * `AssayerService.issueAppAccess`.
   */
  @Post(':assayerId/app-access')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  // `assayer:edit`, not `user:create`: an assayer signs in from the `assayers` table and has no
  // row in `users`, so this writes a credential onto the personnel record. Same for the reset
  // below.
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Issue app access: a shown-once username and temporary password' })
  async issueAppAccess(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Req() req: any,
  ) {
    const data = await this.assayerService.issueAppAccess(assayerId, req.user.id);
    return {
      success: true,
      data,
      message: data.canSignInNow
        ? 'App access issued. Read the password to them now — it will not be shown again, and they will be asked to choose their own at first sign-in.'
        : 'App access issued. Read the password to them now — it will not be shown again. They will not be able to sign in until their record is activated.',
    };
  }

  /** HR/admin recovery path for an assayer who cannot sign in. */
  @Post(':assayerId/reset-password')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
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

