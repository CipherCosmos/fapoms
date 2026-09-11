import {
  Injectable, NotFoundException, ConflictException, BadRequestException, UnauthorizedException, ForbiddenException, OnModuleInit, Logger, Optional } from '@nestjs/common'; import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'; import { Repository, LessThanOrEqual, In, DataSource, ILike } from 'typeorm'; import * as xlsx from 'xlsx'; import * as bcrypt from 'bcrypt'; import { randomInt, randomUUID, createHash } from 'crypto'; import { AssayerEntity } from './assayer.entity';
import { RosterRecordsService } from './roster-records.service';
import { LIFECYCLE_REASON_MAX_LENGTH } from './lifecycle-reason-limit';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service'; import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity'; import { WorkforceAttributeEntity } from './workforce-attribute.entity'; import { AssayerRemarkEntity } from './assayer-remark.entity'; import { AssayerActivityEntity } from './assayer-activity.entity'; import { TEMP_PASSWORD_WORDS } from './temp-password-words'; import { AuditService } from '../../core/audit/audit.service'; import { AssayerStateMachine } from './assayer.state-machine'; import { DomainEventPublisher } from '../../core/events/domain-event.publisher'; import { WorkflowEngine } from '../platform/workflow/workflow.engine'; import { NotificationDispatchService } from '../notifications/notification-dispatch.service'; import { EmailProvider } from '../../infrastructure/notifications/email-provider'; import { SmsProvider } from '../../infrastructure/notifications/sms-provider'; import { CacheService } from '../../infrastructure/cache/cache.service'; import { rbacPrincipalCacheKey, isOnboardingStage, maySignIn } from '../auth/auth.service'; import { ASSAYER_ERROR_CODES, AUTH_ERROR_CODES, EventCategory, AssayerLifecycleStatus, AssayerStatus, AssignmentStatus, SystemRole, resolveRegion, canonicalStateName, canonicalState, ASSAYER_LIFECYCLE_TRANSITIONS, ONBOARDING_STAGES, canTransitionAssayerLifecycle, toWorkflowTransitions, AssayerEngagementType, AssayerUnavailableReason, EmpanelmentStatus, OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, businessDateKey, looksMasked, DocumentVerification, PLANNABLE_EMPANELMENT_STANDINGS,
  calculateHaversineDistance,
  normalisePhone, formatDateOnly, parseCalendarDate, assayerLifecycleBlockedBy,
} from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import type { EntityManager } from 'typeorm';
import { diffFields } from '../../core/audit/diff-fields';
import {
  COMMITTED_ASSIGNMENT_STATUSES,
  DEFAULT_WEEKLY_CAPACITY,
  IN_FLIGHT_ASSIGNMENT_STATUSES,
} from '../assignment/assignment-workload';
import { DATA_INTEGRITY_SHEET } from './data-integrity.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import {
  assertTenantOwns,
  tenantFilterId,
  tenantStampId,
  tenantWhere,
} from '../../infrastructure/tenancy/ambient-tenant-context';
import { pincodeAuthority } from '../geo/india-geocoder';
import { resolveCoordinates, needsBetterFix, isPlausibleIndianCoord, GeoFields } from '../geo/coordinate-resolution';
import { reverseFreely } from '../geo/osm-geocoder';

/**
 * Returns the authoritative state and district a 6-digit Indian pincode belongs
 * to, asking the same Google geocoder the coordinates come from (so the
 * validation and the pin always agree). Used to stop the classic silent
 * mistake: an address that says one place while state/district/city/pincode say
 * another.
 *
 * Returns null when the pincode can't be verified — the caller must then skip
 * the check rather than invent one.
 */
async function fetchPincodeAuthority(
  pincode: string,
): Promise<{ state: string; district: string } | null> {
  return pincodeAuthority(pincode);
}

/** Loose comparer for place names: case/space/punctuation-insensitive and blind
 * to the common "Urban"/"Rural"/"District"/"City" suffixes so "Bengaluru Urban"
 * and "Bengaluru" compare equal. */
function normalizePlace(s?: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\b(urban|rural|district|city|metro)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * What a district-vs-pincode disagreement resolves to when it is not a refusal: the facts a
 * review-queue row needs, for the caller to file once the record they belong to actually has an
 * id. See the district block inside `assertAddressConsistent` for why this stopped being a 400.
 */
export interface DistrictPincodeMismatch {
  enteredDistrict: string;
  authorityDistrict: string;
  authorityState: string;
  pincode: string;
}

/**
 * Enforces that an assayer's state, district and pincode all describe the same
 * place, using the pincode as the anchor of truth. A mixed entry — a Bengaluru
 * pincode with "Karnataka" in the state field but a Delhi district, or a Delhi
 * address tagged as Karnataka — produces a clear, actionable error instead of a
 * silently wrong map pin.
 *
 * The state check still refuses outright: an unreal or contradicted STATE derives a wrong
 * region/zone/holiday-calendar for the whole record (see the block below). A district-vs-pincode
 * disagreement is different in kind — it never miscategorises the record the way a bad state
 * does — and is reported rather than refused; see the district block for why.
 */
async function assertAddressConsistent(dto: {
  address?: string;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string | null;
}): Promise<{ districtMismatch: DistrictPincodeMismatch | null }> {
  /**
   * The state has to be a real one, with or without a pincode to cross-check it against.
   *
   * Nothing checked this on any path — the form, the API and the Excel import all accepted
   * "Freedonia" — and the consequences are quiet rather than loud: `region` is derived from the
   * state, so an unreal one leaves it null, and a null region drops the assayer out of every
   * region-scoped view and out of the territory rules that match on state. They stay on the
   * roster looking ordinary while being unplannable.
   *
   * Checked before the pincode anchor below, which returns early when no pincode was supplied —
   * which is exactly how an imported row with a bogus state got through.
   */
  if (dto.state?.trim()) {
    // Both spellings are accepted, because both turn up in real rosters: `canonicalStateName`
    // reads full names and run-together variants ("ANDRAPRADESH"), while `canonicalState` also
    // resolves the two-letter codes ("MH", "TN"). Chained rather than reimplemented — a third
    // list of state names is exactly how the first two drifted apart.
    const known = canonicalStateName(dto.state) ?? canonicalStateName(canonicalState(dto.state));
    if (!known) {
      // The rejected name is interpolated, so this message can never be matched as a literal by
      // a translating client — it is the composed-message case the code contract exists for.
      throw withCode(
        new BadRequestException(
          `"${dto.state}" is not a state we recognise. It sets this assayer's region, zone and ` +
          'holiday calendar, so it has to match a real state or union territory.',
        ),
        ASSAYER_ERROR_CODES.UNKNOWN_STATE,
      );
    }
  }

  const pin = dto.pincode || (dto.address || '').match(/\b\d{6}\b/)?.[0] || '';
  if (!/^\d{6}$/.test(pin)) return { districtMismatch: null }; // no pincode to anchor on — nothing further to verify
  const authority = await fetchPincodeAuthority(pin);
  if (!authority) return { districtMismatch: null }; // couldn't verify — skip rather than block on a guess

  const where = `${dto.state ?? 'unknown state'}, ${dto.district ?? 'unknown district'}`;
  if (
    dto.state &&
    authority.state &&
    normalizePlace(dto.state) !== normalizePlace(authority.state)
  ) {
    throw new BadRequestException(
      `Pincode ${pin} is in ${authority.state}, but the entered state is "${dto.state}". ` +
        `State, district, city, address and pincode must all describe the same place (got ${where}).`,
    );
  }

  /**
   * WHY this is reported, not refused (2026-09-07): the registration wizard tells the clerk this
   * record "will be saved as entered" when district and pincode disagree — this 400 fired right
   * after that promise, discarding the whole request the UI had just said it would keep. The
   * review queue's own operating rule is already "nothing guessed or changed automatically; each
   * waits for a decision" (see `roster-records.service.ts`'s import-issues queue) — which is
   * exactly what a district/pincode disagreement is: not a shape a computer can refuse, a fact
   * for a person with local knowledge to reconcile. So the record is saved with whatever the
   * clerk actually typed, and the disagreement is filed for review instead of blocking the save.
   */
  if (
    dto.district &&
    authority.district &&
    normalizePlace(dto.district) !== normalizePlace(authority.district)
  ) {
    return {
      districtMismatch: {
        enteredDistrict: dto.district,
        authorityDistrict: authority.district,
        authorityState: authority.state,
        pincode: pin,
      },
    };
  }

  return { districtMismatch: null };
}

/**
 * PAN and IFSC are stored uppercase, and phones are stored in the roster's own
 * `+91XXXXXXXXXX` shape — the wizard already does both client-side, but a direct API write
 * bypasses the browser entirely. A live probe of `POST /assayers` found exactly that: a
 * lowercase PAN went straight into encryption, and `+91 98765-00011` was stored raw, spaces,
 * dashes and all. Two callers writing the same PAN in different case is exactly what defeats an
 * exact-match duplicate scan (see `identity-validation.ts`'s own note on this).
 *
 * Mutates `dto` in place: `persistNewAssayer`'s spread and `update`'s copy-loop both read off
 * `dto` afterwards, so they pick up the normalised values for free instead of a second write path
 * re-deciding the same shape.
 *
 * A value that does not normalise is left exactly as it arrived. The DTO's own format
 * validators (`IsPanFormat`, `IsIfscFormat`, `IsIndianMobile`) have already refused anything that
 * would reach here ill-shaped — this function does not invent a second opinion about what
 * "ill-shaped" means, it only decides the STORED form of what already passed.
 */
/**
 * India-first naming (2026-09-07). The authored truth is `fullName` — the name exactly as
 * printed on the Aadhaar/PAN, which is what banks, TDS filings and background checks verify
 * against. Indian names refuse the first/last split this table was born with: Tamil
 * initial-style names ("A K Venkatesan"), father's-name middles ("Aditya Pramod Dhotre"),
 * legitimate single-token names. So when `fullName` arrives it is stored VERBATIM (whitespace
 * squeezed, nothing else policed) as `displayName`, and the legacy first/last columns become
 * derived tokens — split the same way the roster importer has always split a sheet's name
 * column (everything-but-last / last), so both entry paths derive identically. Nothing
 * user-facing should ever be rebuilt from the tokens again.
 */
function applyAuthoredName(
  dto: { fullName?: string; firstName?: string; lastName?: string },
  current?: { displayName?: string },
): { displayName?: string; firstName?: string; lastName?: string } {
  const full = dto.fullName?.replace(/\s+/g, ' ').trim();
  if (full) {
    const parts = full.split(' ');
    return {
      displayName: full,
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
      lastName: parts.length > 1 ? parts[parts.length - 1] : '',
    };
  }
  if (dto.firstName || dto.lastName) {
    const first = dto.firstName?.trim();
    const last = dto.lastName?.trim();
    return {
      ...(first !== undefined ? { firstName: first } : {}),
      ...(last !== undefined ? { lastName: last } : {}),
      displayName: [first, last].filter(Boolean).join(' ') || current?.displayName,
    };
  }
  return {};
}

function normaliseIdentityFields(dto: {
  panNumber?: string | null;
  ifscCode?: string | null;
  phone?: string | null;
  alternatePhone?: string | null;
  emergencyContactPhone?: string | null;
}): void {
  if (typeof dto.panNumber === 'string' && dto.panNumber.trim()) {
    dto.panNumber = dto.panNumber.trim().toUpperCase();
  }
  if (typeof dto.ifscCode === 'string' && dto.ifscCode.trim()) {
    dto.ifscCode = dto.ifscCode.trim().toUpperCase();
  }
  for (const field of ['phone', 'alternatePhone', 'emergencyContactPhone'] as const) {
    const value = dto[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalised = normalisePhone(value);
    // `normalisePhone` returns the bare 10 digits and leaves the prefix to the caller; `+91…` is
    // the roster importer's own convention (`readPhoneNumbers`) for every row already on file.
    if (normalised) dto[field] = `+91${normalised}`;
  }
}

/**
 * Refuses only the dates that cannot be real, naming the value so the clerk sees what was typed
 * rather than has to guess. A district-vs-pincode disagreement gets a review row because it takes
 * local knowledge to settle; a joining date in 2062 needs no local knowledge, only a second look
 * at the keyboard — so this one still refuses outright, at both create and update.
 *
 * Deliberately loose at both ends: an elderly hire and someone starting next quarter are both
 * ordinary working lives. Only what cannot be true is refused.
 */
function assertDatesAreSane(record: { dateOfBirth?: string | null; joiningDate?: string | null }): void {
  const human = (value: string) => formatDateOnly(value, { day: '2-digit', month: '2-digit', year: 'numeric' });

  if (record.dateOfBirth) {
    const dob = parseCalendarDate(record.dateOfBirth);
    if (dob) {
      if (dob.getTime() > Date.now()) {
        throw new BadRequestException(
          `The date of birth reads ${human(record.dateOfBirth)} — that is in the future; check the year.`,
        );
      }
      if (dob.getFullYear() < 1930) {
        throw new BadRequestException(
          `The date of birth reads ${human(record.dateOfBirth)} — that is before 1930; check the year.`,
        );
      }
    }
  }

  if (record.joiningDate) {
    const joining = parseCalendarDate(record.joiningDate);
    if (joining) {
      const now = new Date();
      // End-of-day, so a joining date exactly one year out today is not refused for being a few
      // hours "too far" depending on time zone — only a date genuinely MORE than a year away is
      // impossible enough to name.
      const oneYearOut = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate(), 23, 59, 59, 999);
      if (joining.getTime() > oneYearOut.getTime()) {
        const years = joining.getFullYear() - now.getFullYear();
        throw new BadRequestException(
          `The joining date reads ${human(record.joiningDate)} — that is ${years} years away; check the year.`,
        );
      }
      if (joining.getFullYear() < 2000) {
        throw new BadRequestException(
          `The joining date reads ${human(record.joiningDate)} — that is before 2000; check the year.`,
        );
      }
    }
  }
}

/**
 * One calendar day as `YYYY-MM-DD`, whatever shape it arrived in.
 *
 * `joining_date`, `exit_date` and `termination_date` are `date` columns, and the two sides of a
 * comparison between them are rarely the same runtime type: the driver hands back the string
 * `'2024-01-18'`, `update()` has just assigned `new Date(dto.exitDate)`, and the state machine
 * stamps a bare `new Date()`. `a > b` across those shapes is the kind of check that passes its
 * unit test and does nothing to a real row. Normalised to `YYYY-MM-DD`, which orders
 * lexicographically exactly as it orders chronologically.
 *
 * A string that is already a calendar day is taken as written, with no zone conversion:
 * `'2024-01-18'` names a day in the office, not an instant. A `Date` is read in the business zone
 * for the same reason — a resignation processed at 01:00 in India belongs to that day, which is
 * not the day UTC would file it under.
 */
function calendarDay(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const written = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (written) return written[1];
  }
  return businessDateKey(value) || null;
}

/**
 * Nobody leaves before they arrive.
 *
 * The roster import brought in 36 of these — one person joined in January 2024 and left in
 * December 2023 — because no write path has ever compared the pair. Most were a corrupt imported
 * date rather than a mistyped one, and `scripts/repair-corrupt-dates.js` has since blanked those.
 * The 7 that remain on the live roster are genuine ordering errors with both years plausible, and
 * they are exactly the ones only a check at write time can stop: no repair script can tell which
 * of the two plausible dates is the wrong one. The pair is read as a length of service — HR's
 * attrition figures, the tenure
 * input to the qualification score — and as a window of employment, and an inverted pair makes
 * both nonsense: negative service, or somebody who was never employed at all.
 *
 * Equal dates pass. Joining and leaving on the same day is unusual and does happen.
 *
 * One function, called from every path that writes any of the three columns, so the pair cannot
 * end up checked on admission and unchecked on edit — the shape of the defect already fixed in
 * `BranchService.update`, where `create` refused a blank SOL ID and the edit form accepted one.
 */
function assertEmploymentDatesArePossible(record: {
  joiningDate?: Date | string | null;
  exitDate?: Date | string | null;
  terminationDate?: Date | string | null;
}): void {
  const joined = calendarDay(record.joiningDate);
  if (!joined) return;

  const departures: Array<[string, Date | string | null | undefined]> = [
    ['exit date', record.exitDate],
    ['termination date', record.terminationDate],
  ];
  for (const [label, raw] of departures) {
    const left = calendarDay(raw);
    if (left && joined > left) {
      throw new BadRequestException(
        `The joining date (${joined}) is after the ${label} (${left}), which would mean this ` +
        'person left before they joined. Check which of the two dates is wrong and correct it.',
      );
    }
  }
}



/**
 * The three identifiers a caller may ask to see whole, keyed by the URL segment that names them.
 *
 * The masking itself is not here — it belongs to the field policy in `assayer-visibility.ts`
 * (`MASKED_IN_TRANSIT_FIELDS`), applied once for every route by `AssayerRedactionInterceptor`.
 * This map is the reveal route's vocabulary: segment in, entity property out, and the same
 * property name in the audit metadata. `sensitive-field-reveal.spec.ts` pins its values against
 * the policy's list so a field can never become revealable without being masked, or masked with
 * no way to read it.
 */
export const SENSITIVE_ASSAYER_FIELDS = {
  pan: 'panNumber',
  aadhaar: 'aadhaarNumber',
  bank: 'bankAccountNumber',
} as const;

export type SensitiveAssayerField = keyof typeof SENSITIVE_ASSAYER_FIELDS;

/** What a caller may ask to reveal, in the order the record shows them. */
export const SENSITIVE_FIELD_NAMES = Object.keys(SENSITIVE_ASSAYER_FIELDS) as SensitiveAssayerField[];

/** Human labels for the audit remark and the refusal messages — one place, one spelling. */
/**
 * How far a confirmed device fix may sit from where the written address geocoded before the
 * address itself is treated as wrong. See `confirmBaseLocation` for why it is this large.
 */
const ADDRESS_CONTRADICTION_KM = 25;

/** Case- and punctuation-insensitive, so "Tamil Nadu" and "TAMILNADU" are the same state. */
const normaliseForCompare = (value: string | null | undefined): string =>
  String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

const SENSITIVE_FIELD_LABELS: Record<SensitiveAssayerField, string> = {
  pan: 'PAN number',
  aadhaar: 'Aadhaar number',
  bank: 'bank account number',
};

/**
 * Refuse a write that is carrying a masked display value back to the database.
 *
 * The web edit form posts only the keys that changed (`buildAssayerEditBody`), but "changed" is
 * decided against what the form was rendered with — and since the read is now masked, any
 * client that touches a neighbouring field and re-serialises the form can send `******234F` as
 * the PAN. That save would replace a real, encrypted number with six asterisks and four digits,
 * and there is no copy of the original anywhere to restore from.
 *
 * The message names the way out rather than just refusing: the value came from a masked read, so
 * the fix is to fetch the real one from the reveal route (which records who looked) and edit
 * that. `panNumber` and `aadhaarNumber` also have format validators on the request DTOs, but
 * `bankAccountNumber` has none and never could — bank account numbers have no checkable shape —
 * so the DTO layer alone left exactly the field a payroll-diversion attempt would aim at
 * unguarded. This guard sits in the service so every write path is covered, including the
 * importer and any internal caller passing the interface a wider object.
 */
export function assertNoMaskedPii(dto: Record<string, any> | null | undefined): void {
  if (!dto) return;
  for (const [name, property] of Object.entries(SENSITIVE_ASSAYER_FIELDS) as [SensitiveAssayerField, string][]) {
    const incoming = dto[property];
    if (typeof incoming === 'string' && looksMasked(incoming)) {
      throw withCode(
        new BadRequestException(
          `The ${SENSITIVE_FIELD_LABELS[name]} you sent is the masked version shown on screen, not the `
          + 'real number, and saving it would overwrite the real one. Reveal the field first, then edit it.',
        ),
        ASSAYER_ERROR_CODES.MASKED_VALUE_REJECTED,
      );
    }
  }
}

export interface CreateAssayerDto {
  /** Omit to have the server allocate the next free code. */
  assayerCode?: string;
  employeeId?: string;
  employeeCode?: string;
  /** The name as printed on Aadhaar/PAN — authored whole; wins over the legacy pair. */
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  clientRequestId?: string;
  allowSharedContact?: boolean;
  sharedContactReason?: string;
  /**
   * Optional on admission. Rosters arrive without a phone column; a missing number blocks ringing
   * this assayer (Call & Assign, phone-channel dispatch), not recording them. See the column
   * comment on AssayerEntity.phone for why this is not the login identifier it was taken to be.
   */
  phone?: string;
  alternatePhone?: string;
  address?: string;
  /** The one geography field that stays mandatory: it drives region, zone and holidays. */
  state: string;
  district?: string;
  city?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  organizationId?: string;
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
  joiningDate?: string;
  managerId?: string;
  department?: string;
  region?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  // `photograph` is not accepted here. RosterRecordsService is the column's single writer — it
  // keeps the storage key in step with the PHOTOGRAPH document row, so the picture a branch is
  // shown is one that exists on file. See the note on the request DTOs in assayer.controller.ts.
  skills?: string[];
  certifications?: { name: string; expiryDate: string }[];
  languages?: string[];
  preferredRegions?: string[];
  specializations?: string[];
  experienceYears?: number;
  performanceRating?: number;
  leaves?: { startDate: string; endDate: string }[];
  workingHours?: { start: string; end: string };
  maxDailyWorkload?: number;
  maxWeeklyWorkload?: number;
  eligibleClients?: string[];
  /**
   * How offers reach this person — see the column comment on `AssayerEntity`.
   *
   * The column has existed since the channel work and was in neither DTO, so it could be neither
   * set nor corrected through the API: every one of the 1,163 roster rows sits on the `AUTO`
   * default. AUTO derives the channel from whether a device token exists, which for somebody with
   * no smartphone AND no phone number resolves to PHONE and produces a call task with nothing to
   * call. Making it settable is what lets HR state "this person is reached by phone" as a fact
   * about them rather than leaving it to be inferred from an absent device.
   */
  preferredContactChannel?: 'AUTO' | 'APP' | 'PHONE';

  /**
   * Facts the appraiser roster carries. They arrived through the importer, which writes the
   * entity directly, so the record could be read but not corrected: an operator opening somebody
   * imported from the spreadsheet saw a date of birth and a qualification with no field to
   * change either.
   *
   * `engagementType` and `unavailableReason` are the two halves of the roster's
   * "Active / Inactive" column, which held an availability, a reason and an engagement type in
   * one cell.
   */
  aadhaarNumber?: string;
  bankName?: string;
  dateOfBirth?: string;
  qualification?: string;
  vstsCode?: string;
  hrOwnerName?: string;
  engagementType?: AssayerEngagementType;
  unavailableReason?: AssayerUnavailableReason;
}

export function hashAssayerCreationRequest(dto: CreateAssayerDto): string {
  const canonical = {
    fullName: (dto.fullName || `${dto.firstName || ''} ${dto.lastName || ''}`).trim().toLowerCase(),
    phone: dto.phone ? dto.phone.replace(/\D/g, '').slice(-10) : '',
    alternatePhone: dto.alternatePhone ? dto.alternatePhone.replace(/\D/g, '').slice(-10) : '',
    email: (dto.email || '').trim().toLowerCase(),
    panNumber: (dto.panNumber || '').trim().toUpperCase(),
    aadhaarNumber: (dto.aadhaarNumber || '').replace(/\s+/g, ''),
    address: (dto.address || '').trim().toLowerCase(),
    state: (dto.state || '').trim().toLowerCase(),
    district: (dto.district || '').trim().toLowerCase(),
    city: (dto.city || '').trim().toLowerCase(),
    pincode: (dto.pincode || '').trim(),
    bankAccountNumber: (dto.bankAccountNumber || '').trim(),
    ifscCode: (dto.ifscCode || '').trim().toUpperCase(),
    bankName: (dto.bankName || '').trim().toLowerCase(),
    employeeId: (dto.employeeId || '').trim(),
    employeeCode: (dto.employeeCode || '').trim(),
    employmentType: (dto.employmentType || '').trim().toUpperCase(),
    joiningDate: dto.joiningDate ? String(dto.joiningDate).slice(0, 10) : '',
    preferredContactChannel: dto.preferredContactChannel || 'AUTO',
    organizationId: (dto.organizationId || '').trim(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface UpdateAssayerDto {
  /**
   * `organizationId` is deliberately absent.
   *
   * Which organisation an assayer belongs to is tenancy, taken from the authenticated principal
   * at create time — see `create()`, which receives it as an argument rather than from the body.
   * Accepting it on update would let a caller move somebody else's assayer into their own
   * organisation. The request DTO has always omitted it; the parity spec would have had somebody
   * "fix" that by adding it, so it says so here.
   */
  employeeId?: string;
  employeeCode?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  alternatePhone?: string;
  address?: string;
  state?: string;
  district?: string;
  city?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
  joiningDate?: string;
  exitDate?: string;
  terminationDate?: string;
  managerId?: string;
  department?: string;
  region?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  // `photograph` is not accepted here. RosterRecordsService is the column's single writer — it
  // keeps the storage key in step with the PHOTOGRAPH document row, so the picture a branch is
  // shown is one that exists on file. See the note on the request DTOs in assayer.controller.ts.
  skills?: string[];
  certifications?: { name: string; expiryDate: string }[];
  languages?: string[];
  preferredRegions?: string[];
  specializations?: string[];
  experienceYears?: number;
  performanceRating?: number;
  leaves?: { startDate: string; endDate: string }[];
  workingHours?: { start: string; end: string };
  maxDailyWorkload?: number;
  maxWeeklyWorkload?: number;
  eligibleClients?: string[];
  /** See `CreateAssayerDto.preferredContactChannel` — why the column needed a way in. */
  preferredContactChannel?: 'AUTO' | 'APP' | 'PHONE';
  /**
   * Facts the appraiser roster carries. They arrived through the importer, which writes the
   * entity directly, so an operator opening somebody imported from the spreadsheet saw a date of
   * birth and a qualification with no field to change either.
   */
  aadhaarNumber?: string;
  bankName?: string;
  dateOfBirth?: string;
  qualification?: string;
  vstsCode?: string;
  hrOwnerName?: string;
  engagementType?: AssayerEngagementType;
  unavailableReason?: AssayerUnavailableReason;
}

/**
 * What a bulk lifecycle walk did, per row. Four outcomes, and the boundary between them is a
 * claim about the DATABASE rather than about how far the loop got:
 *
 *   succeeded  the person is at `to`. `via` is the route walked to get there — `[]` when they
 *              were already there, which is a truthful no-op rather than a move.
 *   partial    some hops committed and the target was not reached. `reached` is the state they
 *              are actually in, re-read from the row. This bucket exists because the response
 *              used to say `failed` for exactly this case, and an operator who is told "failed"
 *              stops looking.
 *   skipped    nothing happened, and it was known before the first hop that nothing could —
 *              no path, or a hop the supplied reason does not cover, or an activation the
 *              identity gate would refuse.
 *   failed     nothing happened, and the attempt threw. The record is where it started.
 *
 * `partial` is deliberately a fourth array rather than a flag on `failed`: a caller that has not
 * been taught about it must not be able to read a part-moved person as a clean failure, and an
 * array it does not know about is at least visibly missing rather than quietly misread.
 */
export interface BulkLifecycleResult {
  succeeded: { id: string; from: string; to: string; via: string[] }[];
  partial: { id: string; from: string; reached: string; target: string; via: string[]; reason: string }[];
  skipped: { id: string; current: string; reason: string }[];
  failed: { id: string; reason: string }[];
}

/**
 * One assignment the departure cascade cancelled, as its `UPDATE … RETURNING` reports it.
 *
 * `previous_status` is the value the same statement overwrote — read from the locked row inside
 * the UPDATE rather than by a separate SELECT, so a concurrent accept cannot make the audit row
 * describe a state the assignment was no longer in.
 */
interface CancelledAssignmentRow {
  id: string;
  assignment_number: string | null;
  previous_status: string;
  previous_version: number | null;
  new_version: number | null;
  scheduled_date: string | null;
  project_branch_id: string | null;
}

@Injectable()
export class AssayerService implements OnModuleInit {
  private readonly logger = new Logger(AssayerService.name);
  constructor(
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
    @InjectRepository(WorkforceAttributeEntity)
    private readonly workforceAttributeRepository: Repository<WorkforceAttributeEntity>,
    @InjectRepository(AssayerRemarkEntity)
    private readonly remarkRepository: Repository<AssayerRemarkEntity>,
    @InjectRepository(AssayerActivityEntity)
    private readonly activityRepository: Repository<AssayerActivityEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly workflowEngine: WorkflowEngine,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly emailProvider: EmailProvider,
    private readonly smsProvider: SmsProvider,
    private readonly uow: UnitOfWork,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // CacheModule is @Global(), so this needs no module wiring. Used only to invalidate the RBAC
    // principal cache synchronously on a password change — see changeOwnPassword/resetPasswordByStaff.
    private readonly cache: CacheService,
    /**
     * The documents side of a person's record.
     *
     * Injected for one job: a verified identity document is checked against this person's NAME, so
     * renaming them has to withdraw that verification. `RosterRecordsService` owns
     * `assayer_documents` and takes only repositories itself, so this direction introduces no cycle.
     *
     * Last in the list, and `@Optional()`, on purpose: a dozen specs build this service by passing
     * positional arguments, so a dependency inserted anywhere else silently shifts every one of
     * them onto the wrong parameter.
     */
    @Optional() private readonly rosterRecords?: RosterRecordsService,
    /**
     * Runtime settings, for the identity gate's three-position rollout mode.
     *
     * Optional and last for the same reason as `rosterRecords` above: a dozen specs construct this
     * service positionally, and the gate must degrade to its default rather than throw when a
     * spec builds the service without one.
     */
    @Optional() private readonly platformSettings?: PlatformSettingsService
  ) {}

  onModuleInit() {
    // Derived from the one table, not typed out again. The engine gates
    // `executeCommand` before the state machine runs, so a hand-written copy here
    // silently outranks the real rules wherever the two drift apart.
    this.workflowEngine.registerWorkflow('assayer', toWorkflowTransitions(ASSAYER_LIFECYCLE_TRANSITIONS));
  }

  async hydrateWorkforceAttributes(assayer: AssayerEntity): Promise<AssayerEntity> {
    const attrs = await this.workforceAttributeRepository.find({
      where: { assayerId: assayer.id, isActive: true },
    });
    (assayer as any).skills = attrs.filter(a => a.type === 'SKILL').map(a => a.name);
    (assayer as any).certifications = attrs.filter(a => a.type === 'CERTIFICATION').map(a => ({
      name: a.name,
      expiryDate: a.expiryDate ? a.expiryDate.toISOString().split('T')[0] : null,
    }));
    (assayer as any).languages = attrs.filter(a => a.type === 'LANGUAGE').map(a => a.name);
    (assayer as any).specializations = attrs.filter(a => a.type === 'SPECIALIZATION').map(a => a.name);
    return assayer;
  }

  async hydrateAllWorkforceAttributes(assayers: AssayerEntity[]): Promise<void> {
    if (assayers.length === 0) return;
    const allAttrs = await this.workforceAttributeRepository.find({
      where: { assayerId: In(assayers.map(a => a.id)), isActive: true },
    });
    const attrsMap = new Map<string, WorkforceAttributeEntity[]>();
    for (const attr of allAttrs) {
      if (!attrsMap.has(attr.assayerId)) attrsMap.set(attr.assayerId, []);
      attrsMap.get(attr.assayerId)!.push(attr);
    }
    for (const assayer of assayers) {
      const attrs = attrsMap.get(assayer.id) || [];
      (assayer as any).skills = attrs.filter(a => a.type === 'SKILL').map(a => a.name);
      (assayer as any).certifications = attrs.filter(a => a.type === 'CERTIFICATION').map(a => ({
        name: a.name,
        expiryDate: a.expiryDate ? a.expiryDate.toISOString().split('T')[0] : null,
      }));
      (assayer as any).languages = attrs.filter(a => a.type === 'LANGUAGE').map(a => a.name);
      (assayer as any).specializations = attrs.filter(a => a.type === 'SPECIALIZATION').map(a => a.name);
    }
  }

  /**
   * Every distinct capability name already recorded across the roster, by kind.
   *
   * The picker on the capability screen is built from this rather than a hardcoded list, so it
   * offers the vocabulary this workforce actually uses — and a name typed once is offered to
   * everyone afterwards, which is what stops "Gold Assaying" and "Gold assaying" becoming two
   * different skills that the eligibility filter treats as unrelated.
   *
   * ## The `COUNT(DISTINCT)` stays, and is index-backed
   *
   * This is the least-protected of the endpoints that aggregate `workforce_attributes`: the HR
   * capability page fetches it from a bare `useEffect([])` with no react-query wrapper, so there
   * is no client cache, no dedupe and no server-side `CacheService.wrap` — every visit to
   * /hr/capability runs it, and the page unmounts on tab change. It is also unbounded: no LIMIT,
   * a full aggregate over every active attribute row.
   *
   * Measured on a copy of the 200k fixture with the HR tables filled to match its 5,038-assayer
   * roster (40,405 attribute rows), warm, five runs: 75.6 ms, of which ~70 ms was a sort of all
   * 40k rows by `(type, name, assayer_id)` — a `DISTINCT` aggregate cannot be hash-aggregated, so
   * the planner must sort, and these are collated `varchar`s. `1791000000000-WorkforceVocabularyIndex`
   * supplies that exact order as a partial index, and the same unchanged SQL now runs in 5.3 ms.
   *
   * Two things were tried and rejected. Pre-aggregating into a `SELECT DISTINCT` subquery so the
   * planner can hash reaches only 26.4 ms, and once the index exists it is worse than doing
   * nothing (21.1 ms vs 5.3 ms) because it reverts to a sequential scan. And `COUNT(*)` is not a
   * legal substitute for `COUNT(DISTINCT …)` here: nothing in the schema or the write path stops
   * one assayer holding the same `(type, name)` twice — there is no unique constraint, and
   * `syncWorkforceAttributes` inserts whatever array the client sends — so the DISTINCT is
   * load-bearing, and dropping it would inflate the counts the picker ranks its suggestions by.
   */
  async getWorkforceAttributeVocabulary(): Promise<Record<string, Array<{ name: string; assayerCount: number }>>> {
    const rows = await this.workforceAttributeRepository
      .createQueryBuilder('a')
      .select('a.type', 'type')
      .addSelect('a.name', 'name')
      .addSelect('COUNT(DISTINCT a.assayerId)', 'assayerCount')
      .where('a.isActive = true')
      .groupBy('a.type')
      .addGroupBy('a.name')
      .orderBy('a.type')
      .addOrderBy('COUNT(DISTINCT a.assayerId)', 'DESC')
      .getRawMany();

    return rows.reduce<Record<string, Array<{ name: string; assayerCount: number }>>>((acc, r) => {
      (acc[r.type] ??= []).push({ name: r.name, assayerCount: Number(r.assayerCount) });
      return acc;
    }, {});
  }

  private async syncWorkforceAttributes(
    assayerId: string,
    dto: CreateAssayerDto | UpdateAssayerDto,
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const FIELD_TO_TYPE = {
      skills: 'SKILL',
      certifications: 'CERTIFICATION',
      languages: 'LANGUAGE',
      specializations: 'SPECIALIZATION',
    } as const;

    /**
     * Replace only the kinds of attribute the caller actually sent.
     *
     * This used to delete all four types whenever any one of them was present, then re-insert
     * just the ones supplied. Saving an assayer's skills therefore erased their certifications,
     * languages and specializations — including certification expiry dates, which the
     * eligibility gate reads. A partial update is the normal shape for an edit form, so this
     * was data loss waiting for the first screen that offered one field without the others.
     */
    const providedTypes = (Object.keys(FIELD_TO_TYPE) as Array<keyof typeof FIELD_TO_TYPE>)
      .filter((f) => (dto as any)[f] !== undefined)
      .map((f) => FIELD_TO_TYPE[f]);

    if (providedTypes.length === 0) return;

    const repo = manager ? manager.getRepository(WorkforceAttributeEntity) : this.workforceAttributeRepository;

    await repo.delete({
      assayerId,
      type: In(providedTypes),
    });

    const newAttrs: Partial<WorkforceAttributeEntity>[] = [];
    if (dto.skills) {
      for (const skill of dto.skills) {
        newAttrs.push({ assayerId, type: 'SKILL', name: skill, createdBy: userId, updatedBy: userId });
      }
    }
    if (dto.certifications) {
      for (const cert of dto.certifications) {
        newAttrs.push({
          assayerId, type: 'CERTIFICATION', name: cert.name,
          expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null,
          createdBy: userId, updatedBy: userId,
        });
      }
    }
    if (dto.languages) {
      for (const lang of dto.languages) {
        newAttrs.push({ assayerId, type: 'LANGUAGE', name: lang, createdBy: userId, updatedBy: userId });
      }
    }
    if (dto.specializations) {
      for (const spec of dto.specializations) {
        newAttrs.push({ assayerId, type: 'SPECIALIZATION', name: spec, createdBy: userId, updatedBy: userId });
      }
    }
    if (newAttrs.length > 0) {
      await repo.save(newAttrs as any[]);
    }
  }

  async findAll(
    page = 1,
    limit = 50,
    scope?: Partial<GlobalScope>,
  ): Promise<{ assayers: AssayerEntity[]; total: number }> {
    // Only region applies. An assayer has a home region but no client, zone or state of their
    // own in the sense the scope means, and inferring one from their assignment history would
    // hide anyone who has not yet worked for the client the operator happens to be scoped to.
    const where: Record<string, unknown> = { isActive: true };
    if (scope?.regions?.length) where.region = In(scope.regions);
    // Region narrows what an operator chose to look at; the organisation decides what they are
    // entitled to see at all, and the two are independent. Before this line an operator with no
    // region assignment — the default — got every organisation's roster on page one.
    const organizationId = tenantFilterId();
    if (organizationId) where.organizationId = organizationId;

    const [assayers, total] = await this.assayerRepository.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      // id tiebreak matches RosterQueryService.findKeyset's ordering exactly. Bulk-imported
      // rows share one createdAt by the hundred; without the tiebreak, the offset first page
      // and the keyset pages that continue from its cursor could order those ties differently
      // and rows at the boundary would be skipped or duplicated mid-walk.
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    await this.hydrateAllWorkforceAttributes(assayers);
    await this.hydrateDocumentSummaries(assayers);
    return { assayers, total };
  }

  /**
   * The size of the paperwork checklist, and therefore the denominator on every roster row.
   *
   * Read from `ONBOARDING_DOCUMENT_COLUMNS` rather than written down, because that is the same
   * list `RosterRecordsService.paperworkChecklist` renders on the record itself. A row saying
   * "4 of 12" that opens onto a checklist of a different length is a bug nobody reports and
   * everybody distrusts.
   */
  private static readonly DOCUMENT_REQUIREMENT_COUNT = Object.keys(ONBOARDING_DOCUMENT_COLUMNS).length;

  /**
   * Attach a per-person paperwork tally to a page of roster rows, in one query.
   *
   * The roster queue wants to offer "Documents to check" as a real queue, and until now the list
   * endpoint returned no document rows at all — so the only thing that phrase could mean was
   * "is at the DOCUMENT_VERIFICATION lifecycle stage", which says nothing about whether there is
   * anything to look at.
   *
   * `withScan` counts requirements with a file attached, NOT `soft_copy_received`. That column was
   * seeded from the spreadsheet's tick boxes and is currently true on 10,977 of the 11,160 active
   * document rows while exactly 0 of them have a file behind them — a queue built on it would put
   * essentially the whole roster in front of a reviewer with nothing to review. `awaitingVerdict`
   * is the queue proper: a scan is on file and nobody has yet said verified or rejected.
   *
   * One grouped query over the page's ids, not one per row: the list serves up to 1,000 people.
   */
  private async hydrateDocumentSummaries(assayers: AssayerEntity[]): Promise<void> {
    if (assayers.length === 0) return;
    const ids = assayers.map((a) => a.id);

    const rows: Array<{ assayer_id: string; with_scan: number; verified: number; awaiting_verdict: number }> =
      await this.assayerRepository.manager.query(
        `SELECT assayer_id,
                COUNT(*) FILTER (WHERE jsonb_array_length(file_paths) > 0)::int AS with_scan,
                COUNT(*) FILTER (WHERE verification_status = $2)::int AS verified,
                COUNT(*) FILTER (WHERE jsonb_array_length(file_paths) > 0
                                   AND (verification_status IS NULL OR verification_status = $3))::int
                  AS awaiting_verdict
           FROM assayer_documents
          WHERE is_active = true AND assayer_id = ANY($1)
          GROUP BY assayer_id`,
        [ids, DocumentVerification.VERIFIED, DocumentVerification.PENDING],
      );
    const byAssayer = new Map(rows.map((r) => [r.assayer_id, r]));

    for (const assayer of assayers) {
      const tally = byAssayer.get(assayer.id);
      // Someone with no document rows at all is not missing from the queue — they are the
      // emptiest case of it, so they get zeros rather than an absent key the client must handle.
      (assayer as any).documents = {
        required: AssayerService.DOCUMENT_REQUIREMENT_COUNT,
        withScan: tally?.with_scan ?? 0,
        verified: tally?.verified ?? 0,
        awaitingVerdict: tally?.awaiting_verdict ?? 0,
      };
    }

    await this.hydrateEmpanelmentSummary(assayers, ids);
  }

  /**
   * How many clients this person may actually be sent to, per roster row.
   *
   * The roster carried no empanelment data at all, and that is the one fact which decides whether
   * somebody can be given work: `ClientEligibilityFilter` admits only ACTIVE and RECOMMENDED
   * standings, and treats a candidate with no row for the client as blocked. So a screen could
   * show a complete, ACTIVE assayer with every document verified and no way to say that the
   * planner will never offer them anything — which is true of 245 of the 548 active people on this
   * roster.
   *
   * `plannableClients` rather than a raw count of rows, because a row saying REJECTED is not a
   * qualification; counting rows would have made a refused person look empanelled. `clientCount`
   * is kept beside it so "vetted by four banks, cleared by none" stays visible — the two numbers
   * differing is exactly the case a vetting desk needs to see.
   *
   * One grouped query for the page, mirroring the document tally above rather than inventing a
   * second shape. `mapRoster` runs its own richer version because it needs client NAMES for the
   * map popover; this one deliberately returns counts, since a roster row has nowhere to put 24
   * client names.
   */
  private async hydrateEmpanelmentSummary(assayers: AssayerEntity[], ids: string[]): Promise<void> {
    if (!ids.length) return;

    const rows: Array<{ assayer_id: string; clients: number; plannable: number }> =
      await this.assayerRepository.manager.query(
        `SELECT e.assayer_id,
                COUNT(DISTINCT e.client_id)::int AS clients,
                COUNT(DISTINCT e.client_id) FILTER (WHERE e.status = ANY($2))::int AS plannable
           FROM assayer_client_empanelments e
           JOIN clients c ON c.id = e.client_id AND c.is_active = true
          WHERE e.is_active = true AND e.assayer_id = ANY($1)
          GROUP BY e.assayer_id`,
        [ids, [...PLANNABLE_EMPANELMENT_STANDINGS]],
      );
    const byAssayer = new Map(rows.map((r) => [r.assayer_id, r]));

    for (const assayer of assayers) {
      const tally = byAssayer.get(assayer.id);
      // Zeros rather than an absent key, for the same reason as the document tally: somebody with
      // no standings anywhere is the most important case of this, not an exception to it.
      (assayer as any).empanelment = {
        clientCount: tally?.clients ?? 0,
        plannableClients: tally?.plannable ?? 0,
      };
    }
  }

  /**
   * Run the same three hydrations `findAll` runs, for a page of rows that came from somewhere
   * else.
   *
   * `RosterQueryService.findFiltered`/`findKeyset` are a second read path over the same table —
   * built so a filtered or keyset page could land independently of this service (see that file's
   * own header) — and until this method existed, that independence meant they never called
   * `hydrateAllWorkforceAttributes`, `hydrateDocumentSummaries` or `hydrateEmpanelmentSummary` at
   * all. `findAll` ran all three inline, so any `GET /assayers` carrying `?after=` or a filter came
   * back with `skills`/`certifications`/`languages`/`documents`/`empanelment` all `undefined`:
   * the roster screen's page-2+ rows silently lost those fields, the Documents filter had nothing
   * to filter on, and every skill/certification count read as zero for people who hold both.
   *
   * One entry point rather than three separate calls at each call site, because that is exactly
   * how the gap opened: `findAll` remembering all three is not a guarantee the NEXT caller will.
   * Mutates `assayers` in place and returns it, matching the private hydrators it wraps — the
   * caller keeps its own array reference; nothing is copied or re-fetched.
   *
   * Still one grouped query per hydration step, whatever the page size: `hydrateDocumentSummaries`
   * and `hydrateAllWorkforceAttributes` already batch over `ANY($1)`/`In(...)` of the page's ids,
   * so calling them here on up to 1,000 rows costs exactly what `findAll` already pays for the
   * same page size — no per-row loop is introduced.
   */
  async hydrateRosterRows(assayers: AssayerEntity[]): Promise<AssayerEntity[]> {
    await this.hydrateAllWorkforceAttributes(assayers);
    // Cascades into hydrateEmpanelmentSummary itself — see that method's tail call — so this one
    // await covers all three documented hydration steps.
    await this.hydrateDocumentSummaries(assayers);
    return assayers;
  }

  /**
   * The pool the live map draws — every active assayer with exactly the facts a pin needs and
   * nothing else. The map used to fetch the full entity list (78 columns of HR, banking and
   * KYC detail for a layer that renders a dot), and it fetched it unscoped. This read selects
   * eleven fields, honours the region scope the way findAll does, and answers the two
   * questions the roster row cannot: which banks the person is empanelled with (one grouped
   * query, client names joined) and whether they are already committed somewhere today.
   *
   * `limit` defaults to a generous ceiling rather than none at all: this used to fetch every
   * active assayer unconditionally, which was fine at 1,155 rows and is not a promise worth
   * keeping as the roster grows — this is a layer that renders map dots, not a data export.
   * The controller clamps the caller-supplied value; the default here covers direct/internal
   * callers that pass none.
   */
  async mapRoster(scope?: Partial<GlobalScope>, limit = 2000): Promise<Array<Record<string, unknown>>> {
    const where: Record<string, unknown> = { isActive: true };
    if (scope?.regions?.length) where.region = In(scope.regions);
    // The two grouped queries further down key off `ids`, which comes out of this find — so
    // narrowing here narrows the empanelment and workload joins with it, and no other predicate
    // is needed for them. It also means forgetting this one line would have plotted another
    // organisation's workforce on the map, with their names and phone numbers in the popups.
    const organizationId = tenantFilterId();
    if (organizationId) where.organizationId = organizationId;

    const assayers = await this.assayerRepository.find({
      select: [
        'id', 'assayerCode', 'displayName', 'phone', 'status', 'lifecycleStatus',
        'latitude', 'longitude', 'state', 'district', 'geoSource', 'geoAccuracyMeters',
      ],
      where,
      order: { displayName: 'ASC' },
      take: limit,
    });
    if (!assayers.length) return [];
    const ids = assayers.map((a) => a.id);

    const empanelmentRows: Array<{ assayer_id: string; client_id: string; status: string; client_name: string }> =
      await this.assayerRepository.manager.query(
        `SELECT e.assayer_id, e.client_id, e.status, c.name AS client_name
           FROM assayer_client_empanelments e
           JOIN clients c ON c.id = e.client_id AND c.is_active = true
          WHERE e.is_active = true AND e.assayer_id = ANY($1)
          ORDER BY c.name`,
        [ids],
      );
    const empanelmentsByAssayer = new Map<string, Array<{ clientId: string; clientName: string; status: string }>>();
    for (const r of empanelmentRows) {
      const list = empanelmentsByAssayer.get(r.assayer_id) ?? [];
      list.push({ clientId: r.client_id, clientName: r.client_name, status: r.status });
      empanelmentsByAssayer.set(r.assayer_id, list);
    }

    // Committed work only (accepted / checked in / in progress) — a PENDING offer is not
    // "working today", it is a question they have not answered.
    const workRows: Array<{ assayer_id: string; open: number; today: number }> =
      await this.assayerRepository.manager.query(
        `SELECT assayer_id,
                COUNT(*)::int AS open,
                COUNT(*) FILTER (WHERE scheduled_date = $2)::int AS today
           FROM assignments
          WHERE is_active = true AND status = ANY($3) AND assayer_id = ANY($1)
          GROUP BY assayer_id`,
        [ids, businessDateKey(new Date()), COMMITTED_ASSIGNMENT_STATUSES],
      );
    const workByAssayer = new Map(workRows.map((r) => [r.assayer_id, r]));

    return assayers.map((a) => ({
      id: a.id,
      assayerCode: a.assayerCode,
      displayName: a.displayName,
      phone: a.phone,
      status: a.status,
      lifecycleStatus: a.lifecycleStatus,
      latitude: a.latitude,
      longitude: a.longitude,
      // Approximate when there is no fix yet, OR the fix is coarser than a pincode (a district
      // or state centroid — the record's own address didn't resolve, usually because its state
      // and pincode disagree). Either way the pin is an area, not an address, and the popup
      // says so rather than letting a 100 km-wide guess read as someone's doorstep.
      approxLocation: a.latitude != null && (!a.geoSource || Number(a.geoAccuracyMeters ?? 0) > 3000),
      state: a.state,
      district: a.district,
      empanelments: empanelmentsByAssayer.get(a.id) ?? [],
      assignedToday: (workByAssayer.get(a.id)?.today ?? 0) > 0,
      openAssignments: workByAssayer.get(a.id)?.open ?? 0,
    }));
  }

  /**
   * One assayer by id, within the caller's organisation — the tenant boundary for most of this
   * service, because most of this service loads through here.
   *
   * ## What was wrong
   *
   * This read `where: { id, isActive: true }` and nothing else. `organization_id` has been on the
   * table since the beginning, is carried in every JWT and is stamped on create, and was never
   * once used as a filter. The only ownership check anywhere on these routes was
   * `regionGuard.assertAssayerInScope`, which compares the record's `region` column — a different
   * question entirely — and early-returns for any account with no region assignment, which is
   * every account by default. Finding F-03 reproduced the consequence end to end against the live
   * system: an OPERATIONS user in organisation A read organisation B's assayer (200), suspended
   * them (201), read their bank account number in cleartext (200) and soft-deleted them (204).
   *
   * ## Why the fix belongs here rather than at the routes
   *
   * `remove`, `update`, `doTransitionLifecycle` (and therefore every named lifecycle helper and
   * the bulk walk), `updateLiveLocation`, `confirmBaseLocation`, `setLiveTracking`,
   * `createCommercialProfile`, `operatorRevokeInvitation` and
   * `operatorReconcileDepartedEmpanelments` all pre-read through this method. Adding the predicate
   * at each of those instead would be nine chances to forget it, silently, in the permissive
   * direction — the shape of mistake `TenantScopedRepository`'s comment was written about.
   *
   * ## Why the caller gets a 404
   *
   * The predicate is in the WHERE clause, so a foreign id simply matches nothing and the
   * `NotFoundException` below — the one this method already threw for an unknown id — fires
   * unchanged. That is the intended answer and not an accident of implementation: 404 for "not
   * yours" is indistinguishable from 404 for "does not exist", whereas a 403 would confirm the id
   * names a real assayer in some other organisation. See `assertTenantOwns` for the argument in
   * full.
   */
  /**
   * The record, for anything that intends to CHANGE it.
   *
   * `isActive: true` is what makes an archived assayer unreachable, and that is deliberate here:
   * archival is the end of the line, so every mutation should refuse it, and refusing it at the
   * load is stronger than refusing it at each rule. It is also, incidentally, the reason the
   * transition endpoint answers 404 rather than 400 for a move out of ARCHIVED — the row is never
   * loaded, so the map is never consulted.
   *
   * Reads go through `findOneForReading` instead. See its comment for why the two were separated.
   */
  async findOne(id: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({
      where: tenantWhere<AssayerEntity>({ id, isActive: true }),
    });
    if (!assayer) throw new NotFoundException(`Assayer ${id} not found.`);
    await this.hydrateWorkforceAttributes(assayer);
    return assayer;
  }

  /**
   * The record, for anything that only intends to LOOK at it — archived people included.
   *
   * ## Why this exists
   *
   * Archival used to be a soft delete by accident. `findOne` filters `isActive: true`, ARCHIVED
   * is the one state that sets it false, and every read went through `findOne` — so a leaver's
   * file 404'd by id, was absent from search and typeahead, and, most tellingly, the roster's own
   * `lifecycleStatus=ARCHIVED` filter returned nothing at all. The screen offered a filter for a
   * population it could never show. Nobody decided that; it fell out of one flag doing two jobs.
   *
   * The decision, taken deliberately: an archived record is READABLE and never MUTABLE. That is
   * what archival means everywhere else — closed, not erased — and the data was always still
   * there; only the way in was missing. HR can open a leaver's file to answer a reference check
   * or a dispute, which is exactly when somebody needs it and exactly when the record is closed.
   *
   * ## The line between the two methods
   *
   * Every mutation keeps `findOne` and therefore keeps refusing archived rows. Reads use this.
   * Splitting them rather than adding a boolean parameter is the point: a flag would let a caller
   * opt into loading an archived record and then write to it, and the whole guarantee here is
   * that no such caller can exist. `hasLeftWorkforce`, `stillWorkable` and the deployability
   * verdict all continue to treat ARCHIVED as departed, so reading one cannot make it workable.
   *
   * Tenancy still applies. Being archived does not put somebody in a different organisation.
   */
  async findOneForReading(id: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({
      where: tenantWhere<AssayerEntity>({ id }),
    });
    if (!assayer) throw new NotFoundException(`Assayer ${id} not found.`);
    await this.hydrateWorkforceAttributes(assayer);
    return assayer;
  }

  /**
   * Assert that an assayer id belongs to the caller's organisation, without loading the record.
   *
   * The counterpart to `findOne` for the paths that do NOT want the record: reads of a child
   * table keyed on `assayer_id` (`assayer_payables`, `assayer_activities`, `workforce_attributes`,
   * `assayer_commercial_profiles`), and mutations reached by a CHILD row's id, where the owner has
   * to be resolved before ownership can be judged. None of those tables carries `organization_id`
   * of its own — `assayers` is the only one in this module that does — so tenancy for every one of
   * them is a question about the parent, which is what this asks.
   *
   * `withDeleted` is on, and that is the point of asking here rather than through `findOne`:
   * `findOne` filters `isActive: true`, so a soft-deleted assayer would answer "not in your
   * organisation" and turn a legitimate 400/409 about a departed person into a 404 about a
   * stranger. Ownership does not lapse when a record is archived.
   *
   * Selects the one column it needs. This runs ahead of reads that are otherwise a single query,
   * and the point is a cheap gate, not a second full load of a 90-column row.
   */
  private async assertAssayerInTenant(assayerId: string, notFoundMessage: string): Promise<void> {
    if (!tenantFilterId()) return;
    const row = await this.assayerRepository.findOne({
      where: { id: assayerId },
      select: { id: true, organizationId: true },
      withDeleted: true,
    });
    // A row that does not exist at all gets the same answer as one belonging to somebody else —
    // see `assertTenantOwns` for why the two must not be distinguishable.
    assertTenantOwns(row?.organizationId ?? undefined, notFoundMessage);
  }

  /**
   * The next free `AS-nn` code, considering every assayer that has ever existed.
   *
   * Codes are permanent identifiers: a deleted assayer keeps hers, and her payables, assignments
   * and audit trail still refer to it, so the number must never be handed out again. The scan
   * therefore ignores `isActive` — the one place in this service that deliberately does.
   *
   * Codes that do not follow this shape are skipped rather than parsed: the seeded roster uses
   * `AS0688`, and reading that as 688 would jump the sequence into the hundreds on first use.
   */
  private async allocateAssayerCode(): Promise<string> {
    /**
     * The company's own pattern, continued — not a parallel one.
     *
     * Appraiser codes are issued by the company as `AS0844`-style: a series prefix and four
     * digits, no dash. The roster carries three series (AS for assayers, AD and FO for other
     * intake channels); someone created through this system joins the AS series at the next
     * free number. This used to emit `AS-01`, `AS-02`… — a dash pattern the real roster has
     * never used — so website-created people looked foreign next to everyone else and their
     * numbering could never merge with the company's.
     *
     * Both shapes are read when finding the highest (the dash-era rows this bug already
     * created must not be collided with), and the company shape is what gets issued.
     */
    const rows = await this.assayerRepository.find({ select: ['assayerCode'], withDeleted: true } as any);
    const highest = rows.reduce((max, r) => {
      const m = /^AS-?(\d+)$/.exec(r.assayerCode ?? '');
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    return `AS${String(highest + 1).padStart(4, '0')}`;
  }

  /**
   * A code the caller chose is honoured; one the system allocates is retried on collision.
   *
   * This read the highest code, checked it was free, then inserted — three statements with no
   * lock between them, so two people adding an assayer at the same moment both saw the same
   * gap and both aimed at it. The unique constraint on `assayer_code` meant the database
   * refused the loser rather than storing two, which is the important half; but the loser was
   * shown "Assayer code AS-09 already exists" about a code they never typed and could not
   * change, having filled in the whole form.
   *
   * Now it simply takes the next one, the same way `ProjectService.create` does. A code the
   * user typed themselves is never retried — saving somebody under a different code than the
   * one on screen would be worse than the error.
   */
  async create(
    dto: CreateAssayerDto,
    userId: string,
    organizationId?: string | null,
    actorRoles?: string[],
  ): Promise<AssayerEntity> {
    // A create carrying a masked value is rarer than an edit — it happens when a form is cloned
    // from a record that was read masked — but it stores the same asterisks, so it is refused the
    // same way rather than left as the one door the guard does not cover.
    assertNoMaskedPii(dto as Record<string, any>);
    const createRequestHash = dto.clientRequestId ? hashAssayerCreationRequest(dto) : null;

    /**
     * The owning organisation, decided here and taken from the authenticated principal FIRST.
     *
     * `dto.organizationId` is a field on the request body. It was the last term of this
     * expression, so it only ever applied when the controller passed nothing — but it was still a
     * caller-chosen tenant, and once reads filter on this column a caller-chosen tenant is a
     * caller-chosen audience: create a record stamped with somebody else's organisation and it
     * appears on their roster. `tenantStampId()` reads `req.user.organizationId`, which the JWT
     * guard resolved, so in a request it always wins.
     *
     * The two fallbacks are kept, in order, for the callers that have no request: the explicit
     * argument (`AssayerController.create` passes `req.user.organizationId`) and then the DTO
     * field, which several specs and the idempotency suite set directly.
     *
     * A null outcome is not refused here. It cannot happen through the API — every principal
     * carries an organisation since the backfill — and refusing would break the direct callers
     * above for no security gain: a null-owned row is invisible to every scoped read, so the
     * failure direction is already closed.
     */
    const orgId = tenantStampId() ?? organizationId ?? dto.organizationId ?? null;
    if (dto.clientRequestId && createRequestHash) {
      const queryRunner = typeof this.assayerRepository?.manager?.query === 'function' ? this.assayerRepository.manager : this.dataSource;
      const existingIdemp = await queryRunner.query(
        `SELECT * FROM assayer_idempotency_records
         WHERE client_request_id = $1
           AND COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [dto.clientRequestId, orgId],
      );
      if (existingIdemp && existingIdemp.length > 0) {
        const rec = existingIdemp[0];
        if (rec.command !== 'CREATE' || rec.request_hash !== createRequestHash) {
          throw new ConflictException(
            'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: clientRequestId has already been used for a different assayer registration payload.',
          );
        }
        return rec.response_payload as AssayerEntity;
      }
    }

    const supplied = dto.assayerCode?.trim();
    if (supplied) {
      /**
       * Deliberately NOT tenant-scoped, and this is the one read in the module that should stay
       * that way. `assayer_code` carries a database-wide UNIQUE constraint
       * (`UQ_ac38fe8dfe44eb1ad3310e29fb0`), so the code namespace is the platform's, not the
       * organisation's. Scoping this check would let a second organisation pass it and then be
       * refused by Postgres on INSERT — turning a clean 409 naming the code into a constraint
       * violation surfacing as a 500, for a code the operator typed and can change.
       *
       * What it discloses is that a code is taken, not by whom: the response says only
       * "already exists", and the row is not loaded into anything the caller can see.
       */
      const existing = await this.assayerRepository.findOne({ where: { assayerCode: supplied } });
      if (existing) throw new ConflictException(`Assayer code ${supplied} already exists.`);
      try {
        return await this.persistNewAssayer(dto, supplied, userId, orgId, actorRoles, createRequestHash);
      } catch (err: any) {
        return await this.handleCreateIdempotencyConflict(err, dto.clientRequestId, createRequestHash, orgId);
      }
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.allocateAssayerCode();
      try {
        return await this.persistNewAssayer(dto, candidate, userId, orgId, actorRoles, createRequestHash);
      } catch (err: any) {
        const isIdemp =
          (err?.code === '23505' || err?.driverError?.code === '23505') &&
          (String(err?.detail || err?.message).includes('assayer_idempotency_records') ||
           String(err?.detail || err?.message).includes('client_request_id') ||
           String(err?.constraint).includes('idempotency'));
        if (isIdemp && dto.clientRequestId && createRequestHash) {
          return await this.handleCreateIdempotencyConflict(err, dto.clientRequestId, createRequestHash, orgId);
        }
        // 23505 = unique_violation on assayerCode. Anything else is a real failure and must surface.
        if (err?.code !== '23505' && err?.driverError?.code !== '23505') throw err;
      }
    }
    throw new ConflictException('Could not allocate an assayer code just now. Please try again.');
  }

  private async handleCreateIdempotencyConflict(
    err: any,
    clientRequestId?: string,
    createRequestHash?: string | null,
    organizationId?: string | null,
  ): Promise<AssayerEntity> {
    const isIdempConflict =
      (err?.code === '23505' || err?.driverError?.code === '23505') &&
      (String(err?.detail || err?.message).includes('assayer_idempotency_records') ||
       String(err?.detail || err?.message).includes('client_request_id') ||
       String(err?.constraint).includes('idempotency'));
    if (isIdempConflict && clientRequestId && createRequestHash) {
      const queryRunner = typeof this.assayerRepository?.manager?.query === 'function' ? this.assayerRepository.manager : this.dataSource;
      const committed = await queryRunner.query(
        `SELECT * FROM assayer_idempotency_records
         WHERE client_request_id = $1
           AND COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [clientRequestId, organizationId ?? null],
      );
      if (committed?.[0]?.response_payload) {
        if (committed[0].request_hash !== createRequestHash) {
          throw new ConflictException(
            'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: clientRequestId has already been used for a different assayer registration payload.',
          );
        }
        return committed[0].response_payload as AssayerEntity;
      }
    }
    throw err;
  }

  private async persistNewAssayer(
    dto: CreateAssayerDto,
    assayerCode: string,
    userId: string,
    organizationId?: string | null,
    actorRoles?: string[],
    createRequestHash?: string | null,
  ): Promise<AssayerEntity> {
    dto = { ...dto, assayerCode };

    // The shared rulebook, applied before anything else touches `dto`: PAN/IFSC uppercased and
    // phones normalised to `+91XXXXXXXXXX` ahead of validation-dependent logic and persistence,
    // so a direct API write can never store a shape the wizard's own client-side pass would have
    // caught. See `normaliseIdentityFields`'s own comment for the live probe that found this gap.
    normaliseIdentityFields(dto);

    const authoredName = applyAuthoredName(dto);
    if (!authoredName.displayName) {
      throw new BadRequestException(
        'Before this can be saved, it needs their full name — exactly as printed on their Aadhaar or PAN.',
      );
    }
    // `fullName` is not a column; keep it out of the entity spread below.
    dto = { ...dto, ...authoredName };
    delete (dto as { fullName?: string }).fullName;

    // Duplicate classification & idempotency check
    const normalizedPhone = dto.phone ? dto.phone.trim() : null;
    const normalizedEmail = dto.email ? dto.email.trim().toLowerCase() : null;
    const normalizedPan = dto.panNumber ? dto.panNumber.trim().toUpperCase() : null;

    if (normalizedPan || normalizedPhone || normalizedEmail) {
      const matchPredicates: any[] = [];
      if (normalizedPan) matchPredicates.push({ panNumber: normalizedPan });
      if (normalizedPhone) matchPredicates.push({ phone: normalizedPhone });
      if (normalizedEmail) matchPredicates.push({ email: normalizedEmail });

      const matchCandidates: AssayerEntity[] = await this.assayerRepository.find({
        where: matchPredicates,
      });

      for (const m of matchCandidates) {
        // Definite Duplicate Check
        if (normalizedPan && m.panNumber && m.panNumber.toUpperCase() === normalizedPan) {
          throw new ConflictException(
            `DEFINITE_DUPLICATE: An assayer with PAN ${normalizedPan} already exists (${m.displayName || m.assayerCode}).`,
          );
        }

        const sameName =
          authoredName.displayName &&
          m.displayName &&
          m.displayName.trim().toLowerCase() === authoredName.displayName.trim().toLowerCase();

        if (normalizedPhone && m.phone === normalizedPhone && sameName) {
          throw new ConflictException(
            `DEFINITE_DUPLICATE: Assayer ${authoredName.displayName} is already registered with phone ${normalizedPhone} (${m.assayerCode}).`,
          );
        }

        if (normalizedEmail && m.email && m.email.toLowerCase() === normalizedEmail && sameName) {
          throw new ConflictException(
            `DEFINITE_DUPLICATE: Assayer ${authoredName.displayName} is already registered with email ${normalizedEmail} (${m.assayerCode}).`,
          );
        }

        // Probable Duplicate / Shared Contact Check
        if (normalizedPhone && m.phone === normalizedPhone && !sameName) {
          if (!dto.allowSharedContact) {
            throw new ConflictException(
              `PROBABLE_DUPLICATE: Phone number ${normalizedPhone} is already registered to ${m.displayName || m.assayerCode}. If this is an authorized shared household contact, specify allowSharedContact=true with an authorized role and reason.`,
            );
          }
          const authorizedRoles = [SystemRole.ADMIN, SystemRole.OPERATIONS, 'HR_MANAGER'];
          const hasPrivilegedRole = actorRoles?.some((r) => authorizedRoles.includes(r as any));
          if (actorRoles && !hasPrivilegedRole) {
            throw new ForbiddenException(
              'Only ADMIN, OPERATIONS, or HR_MANAGER can authorize shared contact duplicate override.',
            );
          }
          if (!dto.sharedContactReason?.trim()) {
            throw new BadRequestException(
              'A sharedContactReason is required when authorizing a shared contact duplicate override.',
            );
          }
          await this.auditService.recordEventSafe({
            category: EventCategory.SYSTEM,
            eventType: 'ASSAYER_SHARED_CONTACT_OVERRIDDEN',
            entityType: 'ASSAYER',
            entityId: m.id,
            userId,
            remarks: `Shared contact duplicate override authorized by ${userId}: ${dto.sharedContactReason.trim()}`,
            metadata: {
              phone: normalizedPhone,
              conflictingAssayerCode: m.assayerCode,
              reason: dto.sharedContactReason.trim(),
            },
          });
        }
      }
    }

    const addressCheck = await assertAddressConsistent(dto);

    /**
     * Checked on admission too, even though `CreateAssayerDto` carries no exit date today.
     *
     * The rule has one home and both writers call it, so on the day somebody adds `exitDate` to
     * admission — back-loading a leaver from the roster is the obvious reason, and this is where
     * it would land — the check is already standing rather than something to remember. Skipping
     * it here because the field does not exist yet is how `create` and `update` drift apart.
     */
    assertEmploymentDatesArePossible(dto);
    assertDatesAreSane(dto);

    /**
     * Resolved through the shared chain, so an assayer's home is placed by the same rules — and
     * carries the same precision record — as a branch. That symmetry is the point: the
     * conflict-of-interest floor and the serviceability radius are distances *between* the two,
     * and a comparison between a 10 m pin and a 100 km centroid is not a distance.
     *
     * Never falls back to a hardcoded coordinate. That is worse than no location: the assayer
     * appears on the map somewhere they have never been, and every distance filter silently
     * uses the fiction. An unknown location is visible and fixable; a plausible wrong one is
     * neither — which is exactly what `geoAccuracyMeters` now makes legible.
     */
    const geo = await resolveCoordinates({
      address: dto.address,
      city: dto.city,
      district: dto.district,
      state: dto.state,
      pincode: dto.pincode,
      suppliedLat: dto.latitude,
      suppliedLng: dto.longitude,
      suppliedIsManual: dto.latitude != null && dto.longitude != null,
    });
    if (geo && needsBetterFix(geo.geoSource, geo.geoAccuracyMeters)) {
      this.logger.warn(
        `Assayer ${dto.assayerCode}: could only place them to ±${geo.geoAccuracyMeters}m ` +
        `(${geo.geoSource}) from "${dto.address}" (${dto.city}, ${dto.district}, ${dto.state}). ` +
        `Distance-based matching will be unreliable until someone pins them precisely.`,
      );
    }

    const clientReqId = dto.clientRequestId;
    delete (dto as any).clientRequestId;
    delete (dto as any).allowSharedContact;

    const geoFields: Partial<GeoFields> = geo ?? {};
    const assayer = this.assayerRepository.create({
      ...dto,
      ...geoFields,
      // Address, city and district became optional on admission but remain NOT NULL columns, and
      // spreading an absent one would insert NULL and fail. Empty is the same thing the branch
      // importer stores for an unknown field, and `missingCriticalFields` reads blank as missing —
      // so the gap still surfaces on the record instead of being hidden behind a constraint error.
      address: dto.address ?? '',
      city: dto.city ?? '',
      district: dto.district ?? '',
      phone: dto.phone || null,
      notes: dto.notes ?? null,
      // Canonicalised from the state, exactly as branches are. Left to the caller this column
      // arrives null (the seed never sets it) or as a free-text zone name from an Excel import,
      // and either way `region IN ('WEST')` matches nobody — a region-scoped operator would
      // open the map, the roster and the capacity tile and find their workforce empty.
      region: resolveRegion(dto.region) ?? resolveRegion(dto.state) ?? null,
      joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
      displayName: authoredName.displayName,
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: AssayerStatus.INACTIVE,
      organizationId: organizationId ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    return this.uow.run(async (manager, emit) => {
      // In-transaction idempotency check under transaction isolation (tenant-scoped)
      if (clientReqId && createRequestHash) {
        const inTxCheck = await manager.query(
          `SELECT * FROM assayer_idempotency_records
           WHERE client_request_id = $1
             AND COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
          [clientReqId, organizationId ?? null],
        );
        if (inTxCheck && inTxCheck.length > 0) {
          const rec = inTxCheck[0];
          if (rec.command !== 'CREATE' || rec.request_hash !== createRequestHash) {
            throw new ConflictException(
              'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: clientRequestId has already been used for a different assayer registration payload.',
            );
          }
          return rec.response_payload as AssayerEntity;
        }
      }

      const assayerRepo = manager.getRepository(AssayerEntity);
      const saved = await assayerRepo.save(assayer);

      // Filed once the record has an id to hang off. See `assertAddressConsistent`'s district
      // block for why this is a review-queue row rather than the 400 that used to sit here.
      if (addressCheck.districtMismatch) {
        await this.rosterRecords?.recordDistrictPincodeMismatch(saved.id, addressCheck.districtMismatch, userId);
      }

      await this.syncWorkforceAttributes(saved.id, dto, userId, manager);
      await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created', manager);
      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'ASSAYER_CREATED',
        entityType: 'ASSAYER',
        entityId: saved.id,
        userId,
        remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
      }, { manager });

      // Atomic write into assayer_idempotency_records in the same transaction
      if (clientReqId && createRequestHash) {
        await manager.query(
          `INSERT INTO assayer_idempotency_records
           (client_request_id, organization_id, assayer_id, command, actor_id, request_hash, response_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            clientReqId,
            organizationId ?? null,
            saved.id,
            'CREATE',
            userId,
            createRequestHash,
            JSON.stringify(saved),
          ],
        );
      }

      if (typeof emit === 'function') {
        emit('assayer:created', {
          eventType: 'assayer:created',
          aggregateId: saved.id,
          userId,
          organizationId: saved.organizationId,
          payload: { id: saved.id, displayName: saved.displayName, assayerCode: saved.assayerCode },
        });
      }

      await this.hydrateWorkforceAttributes(saved);
      return saved;
    });
  }

  async update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity> {
    // Before anything is merged onto the entity: see `assertNoMaskedPii`. This has to run ahead
    // of the copy loop below, which writes any key of the payload that matches a column.
    assertNoMaskedPii(dto as Record<string, any>);

    // Same rulebook as `create` — PAN/IFSC uppercased, phones normalised to `+91XXXXXXXXXX` —
    // applied here, before the copy loop below, so that loop (which writes every key of the
    // payload onto the entity) picks up the normalised values for free. Also ahead of the
    // impossible-date and district checks further down, which is fail-fast ordering only: none
    // of these three read anything the copy loop would have merged.
    normaliseIdentityFields(dto);
    assertDatesAreSane(dto);

    const assayer = await this.findOne(id);
    const orig = {
      address: assayer.address,
      city: assayer.city,
      district: assayer.district,
      state: assayer.state,
      pincode: assayer.pincode,
      // Captured before the copy loop below overwrites the entity, so the field diff at the
      // bottom of this method can compare what was stored against what the request sent.
      phone: assayer.phone,
      email: assayer.email,
      alternatePhone: (assayer as any).alternatePhone,
      panNumber: assayer.panNumber,
      aadhaarNumber: assayer.aadhaarNumber,
      bankAccountNumber: assayer.bankAccountNumber,
      ifscCode: assayer.ifscCode,
    };

    /**
     * Where somebody stands in the workforce is not editable from the profile form.
     *
     * The copy loop below writes any key of the payload that matches a column, so a body carrying
     * `lifecycleStatus: 'RESIGNED'` would move a person out of the workforce through the edit
     * screen: no state-machine check on whether that transition is even legal, no reason on their
     * employment record, no activity entry, and none of the departure bookkeeping in
     * `doTransitionLifecycle` — so their client empanelments would stay ACTIVE and that bank would
     * carry on being offered them. `status` is a projection of `lifecycleStatus` and has no
     * independent value to set at all; see `AssayerEntity.deriveOperationalStatus`.
     *
     * Neither request DTO declares these, so the validation pipe strips both today. This is the
     * rule outliving that: an internal caller passing the interface a wider object, or a field
     * added to the DTO by somebody who did not read this far, would otherwise reopen the hole.
     */
    for (const decided of ['status', 'lifecycleStatus', 'isActive'] as const) {
      if ((dto as Record<string, unknown>)[decided] !== undefined) {
        throw new BadRequestException(
          "An assayer's status, lifecycle, and active state are changed with the lifecycle actions on their record " +
          '— activate, put on leave, suspend, resign, terminate, archive — which record who decided and why. ' +
          'They cannot be directly modified from the profile form or update body.',
        );
      }
    }

    /**
     * What an emptied box means, decided here rather than in every client.
     *
     * A form sends `''` for a field the operator cleared. Whether that is storable depends on
     * the column, and only this side knows: `manager_id` is a uuid and `''` is not a uuid;
     * `employee_id` is unique, so two records cleared to `''` collide on the second one; while
     * `address`, `city`, `district` and `employment_type` are NOT NULL and `''` is exactly
     * right for them. Every one of those was a raw 500 with a Postgres message in it.
     *
     * So the schema answers the question: a cleared value becomes null where the column allows
     * null, and stays an empty string where it does not. The client sends `''` and stops
     * needing to carry a copy of the table definition.
     */
    // Resolve the authored name first and fold its derived tokens into the ordinary column
    // copy below; `fullName` itself is not a column and must not ride the generic loop.
    const authoredName = applyAuthoredName(dto, assayer);
    dto = { ...dto, ...authoredName };
    delete (dto as { fullName?: string }).fullName;

    const columns = this.assayerRepository.metadata;
    Object.keys(dto).forEach((key) => {
      const incoming = (dto as any)[key];
      if (incoming === undefined) return;
      const column = columns.findColumnWithPropertyName(key);

      if (incoming === null && column && !column.isNullable) {
        throw new BadRequestException(
          `${key} cannot be emptied — every assayer must have one.`,
        );
      }
      (assayer as any)[key] = incoming === '' && column?.isNullable ? null : incoming;
    });
    const nameBefore = assayer.displayName;
    if (authoredName.displayName) {
      assayer.displayName = authoredName.displayName;
    }
    // Region follows the state unless named explicitly, and is canonicalised either way —
    // the same rule create() applies, so an edit cannot un-canonicalise the column.
    if (dto.region !== undefined) {
      assayer.region = resolveRegion(dto.region) ?? resolveRegion(assayer.state) ?? null;
    } else if (dto.state !== undefined) {
      assayer.region = resolveRegion(dto.state) ?? assayer.region;
    }
    if (dto.joiningDate) assayer.joiningDate = new Date(dto.joiningDate);
    if (dto.exitDate) assayer.exitDate = new Date(dto.exitDate);
    if (dto.terminationDate) assayer.terminationDate = new Date(dto.terminationDate);

    /**
     * The merged pair, not the fields that happened to arrive: sending a 2024 joining date against
     * a 2023 exit date already on the row produces exactly the same impossible record as sending
     * both together, and only the merged view can see it.
     *
     * Only when the edit touches one of the three dates, though. 36 people already carry an
     * inverted pair, and validating unconditionally would refuse a clerk correcting one of those
     * records' phone number — a guard that blocks ordinary work on the very rows it exists to
     * protect, and that offers no way to save the correction it is demanding. Touch a date and you
     * own the pair; leave the dates alone and an existing contradiction stays the data fix's
     * problem rather than the editor's.
     */
    if (dto.joiningDate !== undefined || dto.exitDate !== undefined || dto.terminationDate !== undefined) {
      assertEmploymentDatesArePossible(assayer);
    }

    const addressChanged = dto.address !== undefined && dto.address !== orig.address;
    const cityChanged = dto.city !== undefined && dto.city !== orig.city;
    const districtChanged = dto.district !== undefined && dto.district !== orig.district;
    const stateChanged = dto.state !== undefined && dto.state !== orig.state;

    let districtMismatch: DistrictPincodeMismatch | null = null;
    if (addressChanged || cityChanged || districtChanged || stateChanged) {
      const addressCheck = await assertAddressConsistent({
        address: dto.address ?? orig.address,
        city: dto.city ?? orig.city,
        district: dto.district ?? orig.district,
        state: dto.state ?? orig.state,
        pincode: dto.pincode ?? orig.pincode,
      });
      districtMismatch = addressCheck.districtMismatch;
    }

    const coordsSupplied = dto.latitude !== undefined && dto.longitude !== undefined;
    if (addressChanged || cityChanged || districtChanged || stateChanged || coordsSupplied) {
      // Returns null when this assayer's home was pinned by hand — see resolveCoordinates.
      const geo = await resolveCoordinates(
        {
          address: dto.address ?? orig.address,
          city: dto.city ?? orig.city,
          district: dto.district ?? orig.district,
          state: dto.state ?? orig.state,
          pincode: dto.pincode ?? orig.pincode,
          suppliedLat: dto.latitude,
          suppliedLng: dto.longitude,
          suppliedIsManual: coordsSupplied,
        },
        assayer,
      );
      if (geo) {
        Object.assign(assayer, geo);
        this.logger.log(
          `Assayer ${assayer.assayerCode}: re-pinned at ±${geo.geoAccuracyMeters}m (${geo.geoSource})`,
        );
      }
    }

    assayer.updatedBy = userId;
    const saved = await this.assayerRepository.save(assayer);

    // Filed once the save has gone through. See `assertAddressConsistent`'s district block for
    // why this is a review-queue row rather than the 400 that used to sit here.
    if (districtMismatch) {
      await this.rosterRecords?.recordDistrictPincodeMismatch(saved.id, districtMismatch, userId);
    }

    /**
     * A verified identity document was checked against the name this record used to carry.
     *
     * Without this the name check is defeated in two ordinary steps: verify a genuine document
     * under the name it matches, then edit the record to any other name. The attestation would
     * survive, still reading VERIFIED, having compared a name that is no longer here.
     */
    if (saved.displayName !== nameBefore) {
      const withdrawn = await this.rosterRecords?.revalidateAfterNameChange(saved.id, userId) ?? 0;
      if (withdrawn > 0) {
        await this.recordActivity(
          saved.id, 'ASSAYER_UPDATED', null, null, userId,
          `${withdrawn} identity document(s) need checking again — they were verified against the `
          + `previous name ("${nameBefore}").`,
        ).catch(() => undefined);
      }
    }

    // Field-Specific Document Evidence Invalidation:
    // 1. Bank Account / IFSC change: invalidate only BANK_PASSBOOK evidence and clear identityVerifiedAt
    const bankDetailsChanged =
      (dto.bankAccountNumber !== undefined && dto.bankAccountNumber !== orig.bankAccountNumber) ||
      (dto.ifscCode !== undefined && dto.ifscCode !== orig.ifscCode);
    if (bankDetailsChanged && this.rosterRecords) {
      await this.rosterRecords.invalidateDocumentForFieldChange(
        saved.id,
        OnboardingDocument.BANK_PASSBOOK,
        'Bank account or IFSC details were updated',
        userId,
      );
      if (saved.identityVerifiedAt) {
        await this.assayerRepository.update(saved.id, { identityVerifiedAt: null });
      }
    }

    // 2. PAN Number change: invalidate only PAN_CARD evidence
    const panChanged = dto.panNumber !== undefined && dto.panNumber !== orig.panNumber;
    if (panChanged && typeof this.rosterRecords?.invalidateDocumentForFieldChange === 'function') {
      await this.rosterRecords.invalidateDocumentForFieldChange(
        saved.id,
        OnboardingDocument.PAN_CARD,
        'PAN number was updated',
        userId,
      );
    }

    // 3. Aadhaar Number change: invalidate only AADHAAR_FRONT and AADHAAR_BACK evidence
    const aadhaarChanged = dto.aadhaarNumber !== undefined && dto.aadhaarNumber !== orig.aadhaarNumber;
    if (aadhaarChanged && typeof this.rosterRecords?.invalidateDocumentForFieldChange === 'function') {
      await this.rosterRecords.invalidateDocumentForFieldChange(
        saved.id,
        OnboardingDocument.AADHAAR_FRONT,
        'Aadhaar number was updated',
        userId,
      );
      await this.rosterRecords.invalidateDocumentForFieldChange(
        saved.id,
        OnboardingDocument.AADHAAR_BACK,
        'Aadhaar number was updated',
        userId,
      );
    }

    await this.syncWorkforceAttributes(saved.id, dto, userId);
    await this.recordActivity(saved.id, 'ASSAYER_UPDATED', null, null, userId, 'Profile updated');
    // Bank/identity/contact keys diffed field-by-field rather than folded into one sentence, so
    // "who changed the account number and when" is answerable from the trail instead of a
    // generic "profile updated". PAN/Aadhaar/account are masked to their last 4 characters —
    // the metadata proves a change happened without ever storing the clear value.
    const fieldChanges = diffFields(orig, dto as Record<string, any>, [
      { key: 'phone', label: 'Phone' },
      { key: 'alternatePhone', label: 'Alternate Phone' },
      { key: 'email', label: 'Email' },
      { key: 'panNumber', label: 'PAN', sensitive: true },
      { key: 'aadhaarNumber', label: 'Aadhaar', sensitive: true },
      { key: 'bankAccountNumber', label: 'Bank Account', sensitive: true },
      { key: 'ifscCode', label: 'IFSC Code' },
    ]);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_UPDATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: fieldChanges.length
        ? `Updated assayer profile: ${saved.displayName} (${fieldChanges.map((c) => c.label).join(', ')})`
        : `Updated assayer profile: ${saved.displayName}`,
      metadata: fieldChanges.length ? { changes: fieldChanges } : undefined,
    });
    this.eventPublisher.publish('assayer:updated', {
      eventType: 'assayer:updated',
      aggregateId: saved.id,
      userId,
      organizationId: saved.organizationId,
      payload: { id: saved.id, displayName: saved.displayName },
    });
    await this.hydrateWorkforceAttributes(saved);
    return saved;
  }

  /**
   * Records the assayer's live position WITHOUT touching their home address
   * (`latitude`/`longitude`). Live coordinates only feed the recommendation
   * engine when the assayer has also opted in (`isLiveEnabled === true`).
   */
  async updateLiveLocation(id: string, latitude: number, longitude: number, userId?: string): Promise<AssayerEntity> {
    // Existence check only — the row itself is updated by column below, never written back
    // wholesale.
    await this.findOne(id);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new BadRequestException('Invalid live coordinates');
    }
    /**
     * A targeted column update, not a whole-entity save.
     *
     * This previously loaded the full assayer and called `save()`, which writes back every
     * column from the in-memory copy. Live position is reported continuously while an
     * assayer is in the field (one row here reached version 53), so any column changed by
     * something else between the read and the write was silently reverted to its stale
     * value. That included security state: a forced-password-change flag, a lockout, or a
     * failed-attempt counter set while the worker's phone was reporting its position would
     * simply disappear. Observed in practice — a `must_change_password` flag set by the
     * rotation script was cleared moments later by a location ping.
     */
    await this.assayerRepository.update(id, {
      liveLatitude: latitude,
      liveLongitude: longitude,
      liveLocation: { type: 'Point', coordinates: [longitude, latitude] } as any,
      updatedBy: userId ?? id,
    });

    return this.findOne(id);
  }

  /**
   * The assayer fixes their OWN base location from the app — the home/base coordinate the map
   * and planning use, not the transient live position above.
   *
   * The roster placed people by geocoding a hand-typed address, which for ~75 of them lands a
   * town or a whole state away (a pincode that disagrees with the recorded state, or no address
   * at all). The person standing at the spot is the one authority that beats every geocoder, so
   * their own GPS fix is stored as a MANUAL pin — 5–10 m, and never overwritten by a later
   * geocoding sweep, exactly like an ops-placed pin.
   *
   * Because the device fix is ground truth, it is trusted over the record's stale text: if a
   * reverse lookup confidently reports a different state, the state, district and region are
   * corrected to match where the person actually is — which is precisely the data error that
   * put them on the wrong part of the map to begin with. `pinManually`'s reject-on-mismatch is
   * deliberately NOT used here: that guard protects a typed coordinate from being transposed,
   * but it would block the very people this flow exists to help.
   */
  async confirmBaseLocation(id: string, latitude: number, longitude: number, userId?: string): Promise<AssayerEntity> {
    const before = await this.findOne(id);
    if (!isPlausibleIndianCoord(latitude, longitude)) {
      throw withCode(
        new BadRequestException(
          `${latitude}, ${longitude} is not a location in India. Check that location access is on and try again.`,
        ),
        ASSAYER_ERROR_CODES.INVALID_COORDINATES,
      );
    }

    const update: Record<string, unknown> = {
      latitude,
      longitude,
      location: { type: 'Point', coordinates: [longitude, latitude] } as any,
      geoSource: 'manual',
      geoAccuracyMeters: 10,
      geoMatchedName: 'Confirmed by the assayer in the app',
      geoResolvedAt: new Date(),
      updatedBy: userId ?? id,
    };

    // Ground truth from the device fixes the address text too, when a reverse lookup is
    // confident and disagrees — best-effort, so a lookup outage never blocks the pin.
    const actual = await reverseFreely({ lat: latitude, lng: longitude }).catch(() => null);
    if (actual?.state) {
      const region = resolveRegion(actual.state);
      if (region) update.region = region;
      if (actual.district) update.district = actual.district;
    }

    /**
     * The pin is now right. That does not make the ADDRESS right, and the address is what lasts.
     *
     * A device fix settles where the person is; it says nothing about the text on their record —
     * and that text is what appears on documents, what a clerk reads, and what gets geocoded again
     * if the pin is ever cleared. So the two are compared here, while a reverse lookup for this
     * exact point is already in hand, and the disagreement is handed back to the caller so the app
     * can ask the person to correct their address rather than thanking them and moving on.
     *
     * Two independent signals, because either alone is weak: a different STATE is close to proof
     * that the written address belongs somewhere else, and a large DISTANCE from where the address
     * geocoded catches the case within one state. The distance is only meaningful against a pin
     * that came from the address in the first place, so a previous manual pin is not compared.
     */
    const recordedState = normaliseForCompare(before?.state);
    const foundState = normaliseForCompare(actual?.state);
    const stateDisagrees = Boolean(recordedState && foundState && recordedState !== foundState);

    const cameFromAddress = before?.geoSource != null && before.geoSource !== 'manual';
    const previouslyAt = cameFromAddress && before?.latitude != null && before?.longitude != null
      ? calculateHaversineDistance(latitude, longitude, Number(before.latitude), Number(before.longitude))
      : null;
    /**
     * Twenty-five kilometres, and not less.
     *
     * Most of this roster is placed from a pincode centroid, whose own error bar is 3 km, and a
     * district centroid's is far larger. A threshold near those would fire on every correctly
     * recorded address and train people to ignore it. Twenty-five is past any honest geocoding
     * error and into "this address is not where this person lives".
     */
    const distanceDisagrees = previouslyAt !== null && previouslyAt > ADDRESS_CONTRADICTION_KM;
    const addressLooksWrong = stateDisagrees || distanceDisagrees;

    await this.assayerRepository.update(id, update as any);
    await this.recordActivity(id, 'ASSAYER_CONFIRMED_LOCATION', null, null, userId ?? id,
      `Base location set by the assayer to ${latitude.toFixed(5)}, ${longitude.toFixed(5)} from the app.`
      + (addressLooksWrong
        ? ` Their written address does not agree with this: ${stateDisagrees
            ? `it says ${before?.state}, the pin is in ${actual?.state}`
            : `the address places them about ${Math.round(previouslyAt!)} km away`}. `
          + 'The pin is correct; the address on the record still needs fixing.'
        : ''))
      .catch(() => undefined);

    /**
     * Announce it, like every other write to this record does.
     *
     * This path published nothing, so confirming a map pin on the phone reached neither the
     * cached HR overview nor the websocket the open roster listens on. `latitude` is one of the
     * seven critical record fields, which made this the one gap an assayer could close where the
     * web was guaranteed not to notice until someone reloaded the page.
     */
    const saved = await this.findOne(id);
    /**
     * Carried on the returned record rather than persisted: it is a fact about this confirmation,
     * for the screen that just performed it. What has to outlive the request — the corrected pin,
     * and the note explaining the disagreement — is already written above.
     */
    (saved as any).addressCheck = {
      looksWrong: addressLooksWrong,
      recordedState: before?.state ?? null,
      actualState: actual?.state ?? null,
      actualDistrict: actual?.district ?? null,
      kmFromWrittenAddress: previouslyAt === null ? null : Math.round(previouslyAt),
    };

    this.eventPublisher.publish('assayer:updated', {
      eventType: 'assayer:updated',
      aggregateId: id,
      userId: userId ?? id,
      // Carried so the gateway can scope the broadcast to this organisation's rooms — without it
      // `emitOperational` falls back to the whole `staff` room.
      organizationId: (saved as any)?.organizationId,
      payload: { id, displayName: (saved as any)?.displayName },
    });

    return saved;
  }

  /**
   * Turns live sharing on/off for an assayer. Off by default; turning it off
   * keeps any last live coordinate but the engine no longer uses it.
   */
  /**
   * Assignment states in which an assayer is actively holding work: they have committed to a job
   * and have not finished it. COMPLETED is excluded on purpose — the obligation ends with the job.
   *
   * That is `COMMITTED_ASSIGNMENT_STATUSES` verbatim. It was a private copy under a different
   * name, which is how a shared set stops being shared.
   */
  private static readonly HOLDS_ACTIVE_WORK: AssignmentStatus[] = [...COMMITTED_ASSIGNMENT_STATUSES];

  /** Does this assayer currently hold work they have accepted and not yet completed? */
  async hasActiveAssignment(assayerId: string): Promise<boolean> {
    const [row] = await this.dataSource.query(
      `SELECT 1 FROM assignments
        WHERE assayer_id = $1 AND is_active = true AND status::text = ANY($2)
        LIMIT 1`,
      [assayerId, AssayerService.HOLDS_ACTIVE_WORK.map(String)],
    );
    return Boolean(row);
  }

  /**
   * Turn live sharing on or off.
   *
   * **Sharing cannot be switched off while the assayer holds accepted work.** The movement trail is
   * what a travel allowance is checked against, and a control someone can simply disable for the
   * journey they are about to claim for is not a control at all.
   *
   * The obligation is deliberately scoped to the job and no further. Between assignments — evenings,
   * days off, leave — an assayer turns it off like any other setting, and nothing here follows them
   * around. That boundary is the difference between verifying work and surveilling a person, and it
   * is why this checks for active work rather than simply pinning the flag on.
   *
   * `actorIsStaff` bypasses the restriction and exists for system-initiated changes — today only
   * `enableLiveTrackingForActiveWork`, which turns sharing *on*. The HTTP route is self-only (it
   * refuses when the caller is not the assayer), so there is currently no way for anyone else to
   * switch someone's sharing off; if that is ever wanted for a lost handset, this is the seam.
   * Every change is audited either way.
   */
  async setLiveTracking(
    id: string,
    enabled: boolean,
    userId?: string,
    opts: { actorIsStaff?: boolean } = {},
  ): Promise<AssayerEntity> {
    const before = await this.findOne(id); // existence check

    if (!enabled && !opts.actorIsStaff && (await this.hasActiveAssignment(id))) {
      throw new BadRequestException(
        'Location sharing has to stay on while you are on an assignment — it is what confirms your ' +
          'travel when you claim for it. You can switch it off once the job is completed.',
      );
    }

    // Same reasoning as updateLiveLocation: touch only the column being changed.
    await this.assayerRepository.update(id, {
      isLiveEnabled: !!enabled,
      updatedBy: userId ?? id,
    });

    if (before.isLiveEnabled !== !!enabled) {
      // Recorded because it changes what the movement trail can later establish: a window with
      // sharing off is a gap somebody chose, and a dispute about a travel claim needs to be able
      // to tell that apart from a handset that simply lost signal.
      await this.recordActivity(
        id,
        enabled ? 'LOCATION_SHARING_ENABLED' : 'LOCATION_SHARING_DISABLED',
        String(before.isLiveEnabled),
        String(!!enabled),
        userId ?? id,
        enabled ? 'Live location sharing turned on' : 'Live location sharing turned off',
      );
    }

    return this.findOne(id);
  }

  /**
   * Turn sharing on because the assayer has just taken on work.
   *
   * Called when an offer is accepted. Best-effort and never throws: failing to enable tracking must
   * not be able to fail an acceptance — losing the assignment would be a far worse outcome than a
   * trail that starts late, and the gap is visible in the assessment either way.
   */
  async enableLiveTrackingForActiveWork(assayerId: string, userId?: string): Promise<void> {
    try {
      const assayer = await this.assayerRepository.findOne({ where: { id: assayerId } });
      if (!assayer || assayer.isLiveEnabled) return;
      await this.setLiveTracking(assayerId, true, userId, { actorIsStaff: true });
    } catch (err) {
      this.logger.warn(
        `Could not enable location sharing for assayer ${assayerId} on acceptance: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Turn sharing back off because the assayer's last open job has ended.
   *
   * The promise made at acceptance — "both ends stop at completion, so nothing follows anyone
   * into their own time" — was only half-implemented: acceptance enabled sharing and nothing
   * ever disabled it, so the flag (and the last GPS fix) survived indefinitely. That is both a
   * privacy failure and a ranking one: `effectiveLatitude` honours the live fix while the flag
   * is on, so someone whose last ping was a completed job 1,000 km away kept being scored from
   * there for weeks. Best-effort like its enable twin; skipped while any other committed
   * assignment keeps the obligation alive.
   */
  async disableLiveTrackingWhenWorkEnds(assayerId: string, userId?: string): Promise<void> {
    try {
      const assayer = await this.assayerRepository.findOne({ where: { id: assayerId } });
      if (!assayer || !assayer.isLiveEnabled) return;
      if (await this.hasActiveAssignment(assayerId)) return;
      await this.setLiveTracking(assayerId, false, userId, { actorIsStaff: true });
    } catch (err) {
      this.logger.warn(
        `Could not disable location sharing for assayer ${assayerId} after work ended: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * ADMINISTRATIVE DELETION. Explicitly not a lifecycle transition, and now explicitly bounded.
   *
   * ## What it is
   *
   * A soft delete: the profile is taken out of the operational picture (`is_active = false`), its
   * lifecycle is set to ARCHIVED, and the cascade below closes everything hanging off it. Every
   * row survives; nothing is erased. It exists for the case the lifecycle has no answer for — a
   * record created in error, a duplicate, a person who should never have been on the roster.
   *
   * ## Why it is not folded into the transition map
   *
   * Because it is not a thing that happened to a person. Every edge in the map records a decision
   * about somebody's employment; this records a decision about a ROW. Making it an ordinary
   * archival transition would mean deleting an ACTIVE assayer required resigning or terminating
   * them first, which would put a fictitious departure on the record of somebody who was never
   * employed. Keeping it separate is right; keeping it SILENT was not.
   *
   * ## What changed, and why
   *
   * The lifecycle certification found this reaching ARCHIVED from any state at all, with no
   * state-machine validation, no reason, and nothing in the trail to distinguish it from an
   * ordinary archival. It was a hidden lifecycle transition — the third of three routes that
   * moved the column without the map being consulted. It is now:
   *
   *   - **ADMIN only.** OPERATIONS runs the workforce and has every lifecycle move it needs;
   *     destroying a record is a different kind of act. Narrowed on the controller.
   *   - **Reasoned.** The same standard as a suspension or a dismissal, and for the same reason:
   *     somebody will ask later why this record is gone, and "it was deleted" is not an answer.
   *   - **Distinctly audited.** `ASSAYER_DELETED` already existed; it now carries the reason and
   *     the state the record was deleted FROM, so the trail can tell an administrative deletion
   *     apart from an archival that went through the lifecycle.
   *
   * It deliberately does NOT gain a source-state restriction. Deleting a record created in error
   * has to work whatever state that error left it in, and narrowing the callers plus demanding a
   * reason is the control that fits — not a rule that would force somebody to walk a fictitious
   * employment history before they can remove a duplicate.
   */
  async remove(id: string, userId: string, reason?: string): Promise<void> {
    if (!reason?.trim()) {
      throw new BadRequestException(
        'Say why this assayer record is being deleted. It closes their assignments and client '
        + 'standings, and the reason is the only thing that will explain it afterwards.',
      );
    }
    if (reason.length > LIFECYCLE_REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `That reason is ${reason.length} characters. Keep it under ${LIFECYCLE_REASON_MAX_LENGTH}.`,
      );
    }

    const assayer = await this.findOne(id);
    const deletedFrom = assayer.lifecycleStatus;
    assayer.isActive = false;
    assayer.lifecycleStatus = AssayerLifecycleStatus.ARCHIVED;
    assayer.status = AssayerStatus.INACTIVE;
    assayer.updatedBy = userId;

    /**
     * Everything below used to be 11 autocommit statements on the pooled connection: the
     * comment this replaced records the outcome of that design directly — a table rename
     * (`assayer_government_documents` -> gone with 1792500000000) made one UPDATE raise 42P01
     * on every delete, and because it sat before the assignments/schedules statements the
     * cascade died halfway, leaving a "deleted" person still holding live assignments and dated
     * slots. One transaction makes that class of failure impossible: either the whole cascade
     * lands, or none of it does and the profile is still fully active for the retry to find.
     *
     * Chained with `.then()` rather than a nested `await`-using callback on purpose:
     * `soft-delete-cascade.spec.ts` slices this method's source between its own signature and
     * the next method's, and a second inner function keyword in between would move that
     * boundary and hide every statement after it from the check. A plain chain keeps the whole
     * cascade — every UPDATE, by name — inside the text the structural test actually reads.
     */
    await this.uow.run((manager) => manager.getRepository(AssayerEntity).save(assayer)
      // Deactivate assayer commercial profiles
      .then(() => manager.query(
        `UPDATE assayer_commercial_profiles SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      // Deactivate assayer documents
      .then(() => manager.query(
        `UPDATE assayer_documents SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      // Skills, languages and certifications. Missing from this cascade, these outlived the
      // person: the HR compliance queries join `assayers` and read `w.is_active`, so a deleted
      // assayer's certifications kept appearing under "falling due" and their skills kept
      // counting toward capability coverage — HR chasing renewals for someone who no longer
      // exists.
      .then(() => manager.query(
        `UPDATE workforce_attributes SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      /*
       * The vetting record: references, background checks, client standings, staff remarks and
       * score overrides.
       *
       * Every table here is keyed by `assayer_id` and read by something that assumes the person
       * exists — the empanelment gate in planning, the qualification score, the vetting dossier.
       *
       * Written out one statement per table rather than looped: `soft-delete-cascade.spec.ts`
       * reads this method as text and checks each table by name, and a loop hides them from it.
       */
      .then(() => manager.query(
        `UPDATE assayer_references SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      .then(() => manager.query(
        `UPDATE assayer_background_checks SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      .then(() => manager.query(
        `UPDATE assayer_client_empanelments SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      .then(() => manager.query(
        `UPDATE assayer_remarks SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      .then(() => manager.query(
        `UPDATE assayer_score_overrides SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
        [userId, id],
      ))
      /*
       * Assignments split by whether they were ever finished. A COMPLETED assignment is a
       * billable fact that happened — billing filters on `is_active`, so flipping it false here
       * would silently drop a completed audit from every invoice it should still appear on.
       * Everything else (still open, in progress, offered) never will be finished now that the
       * assayer is gone, so it is deactivated AND given a terminal status: without a terminal
       * status the branch's busy check (assignment `create()`, owned elsewhere) sees an
       * `is_active=false` row that is still sitting in a non-terminal status and keeps treating
       * the branch as occupied indefinitely.
       */
      /**
       * Two statements, because "not completed" is not the same question as "still open".
       *
       * This was one statement with `status != COMPLETED`, which swept up assignments that had
       * already reached a terminal state and rewrote them. Verified live: an assignment cancelled
       * with a stated reason had that reason replaced by "Assayer profile soft deleted" when the
       * assayer was deleted — a CANCELLED to CANCELLED self-transition the state machine does not
       * permit, performed in raw SQL that never consults it, bumping `entity_version` with no
       * audit event to say anything had changed. A REJECTED assignment got the same treatment,
       * replacing "the assayer declined" with "the work was cancelled", which is a different and
       * untrue fact.
       *
       * `OPEN_ASSIGNMENT_STATUSES` is the predicate the sibling cascade
       * (`cancelOpenAssignmentsOnDeparture`) already uses, and the reasoning is written out
       * beside its definition above. The two paths cancel the same work for the same reason and
       * had no business disagreeing about which work that is.
       */
      // 1. Genuinely open work is cancelled, and says why.
      .then(() => manager.query(
        `UPDATE assignments SET is_active = false, status = $1,
            cancel_reason = 'Assayer profile soft deleted', updated_by = $2,
            entity_version = COALESCE(entity_version, 1) + 1, updated_at = NOW()
          WHERE assayer_id = $3 AND is_active = true AND status = ANY($4)`,
        [AssignmentStatus.CANCELLED, userId, id, AssayerService.OPEN_ASSIGNMENT_STATUSES],
      ))
      /**
       * 2. Work that already ended — REJECTED or CANCELLED — is only deactivated, so the branch's
       * busy check stops seeing it as occupied. Its status and its stated reason are left exactly
       * as they were, because they record something that actually happened. COMPLETED is not
       * touched at all: billing filters on `is_active`, and clearing it would drop a delivered
       * audit off every invoice it belongs on.
       */
      .then(() => manager.query(
        `UPDATE assignments SET is_active = false, updated_by = $1, updated_at = NOW()
          WHERE assayer_id = $2 AND is_active = true AND status = ANY($3)`,
        [userId, id, [AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED]],
      ))
      /*
       * And the scheduled visits those assignments carry.
       *
       * The cascade stopped at the assignment, so a deleted assayer's schedules stayed active —
       * two of them in this database, both ACCEPTED, both for a profile that no longer exists.
       * A schedule is what the calendar, the day plan and the dispatch view read, so the effect
       * is a deleted person still holding dated slots that operations plans around. Scoped to
       * the same non-completed assignments as above, so a completed job's schedule (still part
       * of its billable history) is left alone too.
       */
      .then(() => manager.query(
        `UPDATE schedules SET is_active = false, updated_by = $1
          WHERE is_active = true AND assignment_id IN (
            SELECT id FROM assignments WHERE assayer_id = $2 AND status != $3
          )`,
        [userId, id, AssignmentStatus.COMPLETED],
      ))
      .then(() => this.auditService.recordEvent(
        {
          category: EventCategory.OPERATIONAL,
          eventType: 'ASSAYER_DELETED',
          entityType: 'ASSAYER',
          entityId: id,
          userId,
          previousState: deletedFrom,
          newState: AssayerLifecycleStatus.ARCHIVED,
          remarks: `Administrative deletion of ${assayer.displayName} (was ${deletedFrom}): ${reason.trim()}`
            + ' — cascaded deactivation to commercial profiles, documents, and non-completed assignments.',
          metadata: { reason: reason.trim(), deletedFrom },
        },
        { manager },
      )));

    this.eventPublisher.publish('assayer:deleted', {
      eventType: 'assayer:deleted',
      aggregateId: id,
      userId,
      organizationId: assayer.organizationId,
      payload: { id, displayName: assayer.displayName },
    });
  }

  /**
   * Moves that go on someone's employment record and need to say why.
   *
   * Progressing through onboarding is self-explanatory — "Moved to TRAINING" is the whole story.
   * Being suspended, deactivated, resigned or terminated is not: those are the entries that get
   * read back months later, in a dispute or a reference check, and a record that says only
   * "Moved to TERMINATED" cannot answer anything. Same standard already applied to rejecting an
   * assignment and to sending work back for rework.
   */
  private static readonly LIFECYCLE_MOVES_NEEDING_A_REASON = new Set<string>([
    AssayerLifecycleStatus.SUSPENDED,
    AssayerLifecycleStatus.INACTIVE,
    AssayerLifecycleStatus.RESIGNED,
    AssayerLifecycleStatus.TERMINATED,
    /**
     * INVITED only has one inbound edge in the shared map: the rehire from RESIGNED/TERMINATED
     * (see `AssayerStateMachine.rehire`). "Why was this person re-invited" deserves the same
     * answer on file that "why were they terminated" already gets — it is not a step of ordinary
     * onboarding progress the way DOCUMENT_VERIFICATION or TRAINING are.
     */
    AssayerLifecycleStatus.INVITED,
    /**
     * ARCHIVED joined this list on 2026-09-09, when INVITED → ARCHIVED and
     * DOCUMENT_VERIFICATION → ARCHIVED became real edges (see the shared map). Archival is now
     * two different acts wearing one name: filing away a leaver whose departure was already
     * reasoned, and revoking an invitation, which is a fresh decision about a person nobody has
     * ever recorded anything about. The second needs a sentence — `operatorRevokeInvitation`
     * always demanded one — and there is no way to demand it for one inbound edge and not the
     * other without splitting the state.
     *
     * The cost is one sentence on filing a leaver, on an action that ends a person's record and
     * cannot be undone. That is a cost worth paying.
     */
    AssayerLifecycleStatus.ARCHIVED,
  ]);

  /**
   * The two states that mean the person has left the workforce, as opposed to being unavailable
   * within it. INACTIVE, SUSPENDED and ON_LEAVE are all "not right now"; these two are "not any
   * more", and only these two carry a departure date and end the client standings.
   */
  private static readonly DEPARTED_LIFECYCLE = new Set<string>([
    AssayerLifecycleStatus.RESIGNED,
    AssayerLifecycleStatus.TERMINATED,
  ]);

  /**
   * Assignments a departure actually has to end — work that is still expected to happen.
   *
   * Written out rather than expressed as "not COMPLETED", which is what it used to be. That
   * predicate is true of CANCELLED and REJECTED as well, so every departure re-cancelled work
   * that some earlier decision had already closed and counted it again as a fresh consequence.
   * Reproduced without any race at all: resign somebody holding one accepted assignment, rehire
   * them, resign them again, and the second departure reports "1 open assignment cancelled" when
   * nothing was open.
   *
   * The count is the part that matters. It goes onto the employment record and into
   * `audit_events.remarks` so that "who took her off the Axis list?" has an answer — and it was
   * answering with work closed by a different decision, months earlier, on a table nothing can
   * correct because it is append-only.
   *
   * REJECTED is history in the same way COMPLETED is: the assayer was offered the job and said
   * no. Overwriting that with CANCELLED and "the work could not proceed as planned" replaces
   * something that happened with something that did not. The empanelment close next door was
   * always right about this — it filters on an explicit set of open standings, which is why it
   * was idempotent while this was not.
   */
  private static readonly OPEN_ASSIGNMENT_STATUSES: string[] = [...IN_FLIGHT_ASSIGNMENT_STATUSES];

  /**
   * Every lifecycle move goes through here, so the cached principal is dropped in one place.
   *
   * A signed-in assayer's roles and flags are resolved once and held in Redis for
   * `RBAC_CACHE_TTL_SECONDS` (30 by default). One of those flags is `onboarding`, which decides
   * whether the guard confines them to finishing their registration — so the moment HR activates
   * somebody, a cached principal would keep telling them their joining checks are outstanding.
   * Thirty seconds of that is survivable and it self-heals, but it is a confusing thirty seconds
   * at exactly the moment somebody has been told they can start, and the fix costs one call.
   *
   * Deliberately not narrowed to the ACTIVE transition: a suspension should stop being cached as
   * a working session just as promptly, and a rule that fires on every move cannot be wrong about
   * which move mattered.
   */
  async transitionLifecycle(id: string, targetStatus: string, userId: string, reason?: string, expectedVersion?: number): Promise<AssayerEntity> {
    const result = await this.dispatchLifecycleTransition(id, targetStatus, userId, reason, expectedVersion);
    await this.cache.del(rbacPrincipalCacheKey(id));
    return result;
  }

  /**
   * Routes a target status to the named method for it. Carries no rules of its own any more.
   *
   * The reason check used to live here, and a copy of it lived in `bulkTransitionLifecycle`
   * testing the final target only — so the bulk route could walk through SUSPENDED, INACTIVE or
   * INVITED without one. Both copies are gone; `doTransitionLifecycle` enforces it per hop, on
   * the one path all three routes share.
   */
  private async dispatchLifecycleTransition(id: string, targetStatus: string, userId: string, reason?: string, expectedVersion?: number): Promise<AssayerEntity> {
    if (!Object.values(AssayerLifecycleStatus).includes(targetStatus as AssayerLifecycleStatus)) {
      throw new BadRequestException(`Invalid target status: ${targetStatus}`);
    }

    /**
     * One call to the authority, rather than an eleven-armed switch onto eleven wrappers that
     * each made the same call. The wrappers still exist below — a few other modules call
     * `verifyDocuments` and `acceptResignation` by name — but the route no longer goes through
     * them, so a parameter added to the funnel (`expectedVersion` was the one that forced this)
     * does not have to be threaded through eleven signatures that would each be a place to
     * forget it.
     */
    const { saved, event } = await this.doTransitionLifecycle(
      id, targetStatus as AssayerLifecycleStatus, userId, reason, SystemRole.ADMIN, expectedVersion,
    );
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  /**
   * Move a batch of assayers forward to a single target stage as one operation.
   *
   * Each row is advanced through the allowed state-machine path to the target
   * (e.g. INVITED → DOCUMENT_VERIFICATION → BACKGROUND_VERIFICATION → TRAINING),
   * so a mixed-stage batch can be onboarded together without invalid jumps.
   * Every intermediate step still runs through the normal workflow command,
   * activity log and audit trail. Rows that cannot reach the target are skipped,
   * and per-row errors are isolated so one bad row never aborts the rest.
   *
   * ## THE CONTRACT, stated because it was previously only implied
   *
   * A walk is **staged, not atomic**, and it is staged because the domain cannot express the
   * alternative — not because nobody got round to a transaction:
   *
   *   - Each hop is its own workflow command, and `WorkflowEngine.executeCommand` is explicit
   *     that one transaction makes "the whole COMMAND atomic". The unit of atomicity in this
   *     system is the hop.
   *   - `audit_events` is append-only by database trigger. A hop that committed has written a
   *     row that nothing can retract, so "the walk never happened" is not a state the trail can
   *     be put back into.
   *   - The lifecycle map is very nearly one-directional. There is no DOCUMENT_VERIFICATION →
   *     INVITED edge, no BACKGROUND_VERIFICATION → DOCUMENT_VERIFICATION edge, and so on — so
   *     "return them to their exact original state" is not a move the state machine has. Undoing
   *     a walk would mean writing `lifecycle_status` directly, which is the precise bypass this
   *     module has spent its history removing.
   *   - Hops cascade beyond the row: departure dates, empanelment close-out, assignment
   *     cancellation, an `ASSAYER_ONBOARDED` notification. Those are not compensatable either.
   *
   * ## What changed: the walk is now decided BEFORE it starts
   *
   * Staged did not have to mean "find out half way". Everything a walk can be refused for that
   * is a property of the plan rather than of the world — the path, and the per-hop reason
   * requirement, and the identity gate when it is enforcing — is now checked against the WHOLE
   * path before the first hop is taken. A refusal of that kind lands in `skipped`, and nothing
   * moved. This is where the old code was actually dangerous:
   *
   *     INVITED → INACTIVE with no reason
   *       hop 1  INVITED → DOCUMENT_VERIFICATION      needs no reason, COMMITTED
   *       hop 2  DOCUMENT_VERIFICATION → INACTIVE     needs a reason, refused
   *       response said:  failed
   *       the database said: DOCUMENT_VERIFICATION
   *
   * The operator read "failed" and believed nothing had happened. Something had. The same call
   * now reports `skipped` and the person is still INVITED, because the missing reason was known
   * before hop one.
   *
   * ## What is left, and how it is reported
   *
   * A hop can still fail for a reason that is not knowable in advance — somebody else moved the
   * same person between hops (the funnel's compare-and-swap answers 409), or the database went
   * away. Then the walk really is part-done, and that row is reported as **`partial`**, naming
   * the state the person is actually in, re-read from the database rather than inferred from how
   * far the loop got. A row whose state changed is NEVER reported as `failed`: `failed` means the
   * record is exactly where it started.
   *
   * `via` is on every outcome for the same reason — a two-hop walk that reports only its
   * endpoints is not a truthful account of what was written to somebody's employment record.
   */
  async bulkTransitionLifecycle(
    ids: string[],
    targetStatus: string,
    userId: string,
    reason?: string,
  ): Promise<BulkLifecycleResult> {
    const validTargets = Object.values(AssayerLifecycleStatus);
    if (!validTargets.includes(targetStatus as AssayerLifecycleStatus)) {
      throw new BadRequestException(`Invalid target status: ${targetStatus}`);
    }

    /**
     * The ceiling, once for the request rather than once per row.
     *
     * `doTransitionLifecycle` enforces it too and is the authority; checking it here as well is
     * what keeps an over-long reason from being a per-row failure on every id in the batch after
     * the first row has already moved. Nothing has been touched at this point, so a throw here
     * is honest about having changed nothing — which is exactly what the single-transition route
     * does with the same input.
     */
    if (reason && reason.length > LIFECYCLE_REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `That reason is ${reason.length} characters. Keep it under ${LIFECYCLE_REASON_MAX_LENGTH} — `
        + 'it goes onto the employment record and into the audit trail, which cannot be edited later.',
      );
    }

    const succeeded: BulkLifecycleResult['succeeded'] = [];
    const partial: BulkLifecycleResult['partial'] = [];
    const skipped: BulkLifecycleResult['skipped'] = [];
    const failed: BulkLifecycleResult['failed'] = [];

    for (const id of ids) {
      let from: string | undefined;
      /** Hops this walk actually committed, pushed the instant `executeCommand` resolves. */
      const completed: AssayerLifecycleStatus[] = [];

      try {
        const assayer = await this.findOne(id);
        from = assayer.lifecycleStatus;
        const path = AssayerStateMachine.findPathTo(from, targetStatus) as AssayerLifecycleStatus[] | null;
        if (path === null) {
          skipped.push({
            id,
            current: from,
            reason: `No valid path from ${from} to ${targetStatus}.`
              + AssayerService.whyNoPath(from, targetStatus),
          });
          continue;
        }

        /**
         * The whole plan, held against the rules, before any of it is carried out. A blocker
         * here is a refusal of the WALK, and the record is untouched — so it is a skip.
         */
        const blocker = await this.lifecycleWalkBlocker(assayer, from, path, targetStatus, reason);
        if (blocker) {
          skipped.push({ id, current: from, reason: blocker });
          continue;
        }

        for (const step of path) {
          const { saved, event } = await this.doTransitionLifecycle(id, step, userId, reason);
          // Recorded BEFORE the publish: past this line the hop's transaction has committed, and
          // a subscriber that throws must not be able to make a committed hop look untaken.
          completed.push(step);
          if (event) {
            try {
              this.eventPublisher.publish(event.constructor.name, event);
            } catch (err) {
              this.logger.error(
                `Bulk lifecycle: ${step} committed for ${id} but publishing `
                + `${event.constructor.name} failed: ${(err as Error).message}`,
              );
            }
          }
          void saved;
        }
        succeeded.push({ id, from, to: targetStatus, via: path });
      } catch (e) {
        const message = (e as Error).message;

        /**
         * WHICH BUCKET, decided by the database rather than by our own bookkeeping.
         *
         * `completed` is what this loop believes it committed, and it is very probably right —
         * but "the response must not say failed for a record that moved" is a claim about the
         * database, so the database is what gets asked. `reachedState` reads the row directly,
         * archived rows included (`findOne` filters `is_active`, and ARCHIVED clears it, so the
         * ordinary reader cannot see the very row a walk to ARCHIVED just wrote).
         *
         * If the read itself fails we fall back to `completed`, and a walk that committed
         * nothing and cannot be re-read is the only case that still reports `failed` without
         * having confirmed the state — which is also the case where the record was never
         * loadable in the first place.
         */
        const reached = await this.reachedState(id).catch(() => undefined);
        const landed = reached ?? (completed.length > 0 ? completed[completed.length - 1] : undefined);
        const moved = from !== undefined && landed !== undefined && landed !== from;

        /**
         * Arrived anyway. `WorkflowEngine.executeCommand` runs `afterTransition` AFTER its
         * transaction has committed, so the last hop of a walk can commit and still throw — and
         * this loop, which pushes to `completed` only on a clean return, would call that
         * `partial` while the person is standing exactly where the operator asked. The database
         * decides: if they are at the target, the walk succeeded, and `via` reports the hops this
         * loop is sure of rather than claiming the one it never saw return.
         */
        if (from !== undefined && landed === targetStatus) {
          succeeded.push({ id, from, to: targetStatus, via: completed });
          continue;
        }

        if (moved || completed.length > 0) {
          const reachedState = landed ?? from!;
          partial.push({
            id,
            from: from!,
            reached: reachedState,
            target: targetStatus,
            via: completed,
            reason: message,
          });
          await this.recordAbandonedWalk(id, from!, reachedState, targetStatus, userId, message);
          continue;
        }

        failed.push({ id, reason: message });
      }
    }

    return { succeeded, partial, skipped, failed };
  }

  /**
   * Why this walk cannot be taken at all, or null when every hop of it will be allowed.
   *
   * Only rules that are a property of the PLAN belong here — ones whose answer cannot change
   * between this check and the last hop, so that a "yes" is not a promise this method had no
   * right to make. The reason requirement and the identity gate qualify; a concurrent transition
   * by another operator does not, which is why that one is still discovered mid-walk and reported
   * as `partial`.
   *
   * Every rule below is ALSO enforced by `doTransitionLifecycle`, per hop, and that is the
   * authority. This is a rehearsal of it, not a second copy of it: it reads the same
   * `LIFECYCLE_MOVES_NEEDING_A_REASON` set and calls the same `identityStanding`, and its only
   * job is to move the refusal from after hop one to before it. If the two ever disagree the
   * funnel wins and the row lands in `partial` — which is the safe direction, because `partial`
   * tells the truth about the outcome either way.
   */
  private async lifecycleWalkBlocker(
    assayer: AssayerEntity,
    from: string,
    path: AssayerLifecycleStatus[],
    targetStatus: string,
    reason?: string,
  ): Promise<string | null> {
    const route = path.length > 1 ? ` (via ${[from, ...path].join(' → ')})` : '';

    if (!reason?.trim()) {
      const needsOne = path.find((hop) => AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON.has(hop));
      if (needsOne) {
        return `${AssayerService.lifecycleReasonSentence(needsOne)}`
          + ` Reaching ${targetStatus} from ${from} passes through ${needsOne}${route}, so the whole`
          + ' move needs that sentence. Nothing was changed.';
      }
    }

    /**
     * The identity gate, asked about the ACTIVATION HOP rather than about the destination.
     *
     * `INVITED → ACTIVE` is the batch HR actually runs, and it is four hops. With the gate set to
     * enforce and the documents unchecked, three of those hops committed and the fourth was
     * refused — leaving a queue of people parked in TRAINING and a response that said they had
     * failed. Asked here, the same batch is refused before it starts and everybody is still
     * INVITED.
     *
     * Only when the gate is actually enforcing: under `warn` (the shipping default) and `off` the
     * activation is not refused at all, so pre-empting it would refuse a walk the funnel would
     * have allowed. A one-hop walk is left to the funnel too — it cannot be partial, and the
     * funnel's refusal is the same refusal the single-transition route gives.
     */
    if (path.length > 1 && path.includes(AssayerLifecycleStatus.ACTIVE) && this.rosterRecords) {
      const mode = await this.platformSettings?.get<string>('onboarding.identityGate.mode') ?? 'warn';
      if (mode === 'enforce') {
        const standing = await this.rosterRecords.identityStanding(assayer.id);
        if (!standing.ok) {
          const outstanding = [...standing.missing, ...standing.rejected]
            .map((d) => ONBOARDING_DOCUMENT_LABELS[d]).join(' and ');
          return `${assayer.displayName} cannot be activated yet: ${outstanding} `
            + (standing.rejected.length > 0
              ? 'was sent back and has not been replaced. '
              : 'has not been checked against the original. ')
            + `Reaching ${targetStatus} from ${from} passes through ACTIVE${route}, so the whole `
            + 'move is refused. Nothing was changed.';
        }
      }
    }

    return null;
  }

  /**
   * The half-sentence that turns "no valid path" into something an operator can act on.
   *
   * Empty when the two states are genuinely unconnected — nothing leaves ARCHIVED, and inventing
   * an explanation for that would be worse than the bare fact. Present when every route between
   * them runs through a state that is a decision rather than a corridor, because then the next
   * move is a real one: take that decision on the record, deliberately, and the batch becomes
   * available.
   *
   * ACTIVE is the entry that made this worth writing. "Select twelve INVITED people → Suspended"
   * used to walk them through an activation nobody had earned — four committed hops including an
   * `ASSAYER_ONBOARDED` notification — and `No valid path from INVITED to SUSPENDED` on its own
   * would leave a clerk believing the roster was broken rather than that the suspension is not
   * available until somebody is actually working.
   */
  private static whyNoPath(from: string, targetStatus: string): string {
    const blocker = assayerLifecycleBlockedBy(from, targetStatus);
    if (!blocker) return '';
    return ` Every route from ${from} to ${targetStatus} passes through ${blocker}, which is a`
      + ' decision somebody has to make and answer for, not a corridor — a bulk action will not'
      + ` take it on your behalf. Move them to ${blocker} as its own decision first. Nothing was`
      + ' changed.';
  }

  /**
   * The sentence a reason-requiring move is refused with, in one place.
   *
   * Said by the funnel when a single transition arrives without one and by the walk rehearsal
   * above when a batch would hit that hop three states from now. An operator who is told two
   * different things about the same rule reasonably concludes there are two rules.
   */
  private static lifecycleReasonSentence(target: AssayerLifecycleStatus | string): string {
    return `Say why this assayer is being moved to ${String(target).toLowerCase().replace(/_/g, ' ')}. `
      + 'This goes on their employment record and is what the decision will be judged on later.';
  }

  /**
   * The lifecycle state this id is actually in, archived rows included.
   *
   * Deliberately not `findOne`, which filters `isActive: true` — a walk whose last committed hop
   * was ARCHIVED has cleared that flag, so the ordinary reader 404s on the very row we are trying
   * to tell the truth about. Tenant-scoped by the same ambient filter every other read uses, so
   * this cannot become a way to read across tenants.
   */
  private async reachedState(id: string): Promise<string | undefined> {
    const row = await this.assayerRepository.findOne({
      where: tenantWhere<AssayerEntity>({ id }),
      select: { id: true, lifecycleStatus: true },
    });
    return row?.lifecycleStatus;
  }

  /**
   * Put the abandonment itself on the record, not only the hops that landed.
   *
   * The hops are already audited one row each — that is what makes a partial walk auditable at
   * all. What no row said was that somebody had asked for something else: the trail showed a
   * person moved to DOCUMENT_VERIFICATION with no hint that the request had been "make them
   * INACTIVE" and had stopped. Six months later, in a dispute, "why is this person half way
   * through onboarding" needs an answer, and the answer is here.
   *
   * Best-effort on purpose. This runs after the hops have committed, outside their transactions;
   * failing to write the note must not turn a truthfully-reported partial into a thrown error
   * that aborts the remaining rows of the batch.
   */
  private async recordAbandonedWalk(
    id: string,
    from: string,
    reached: string,
    target: string,
    userId: string,
    why: string,
  ): Promise<void> {
    const remarks = `Bulk move to ${target} stopped part way: asked to go ${from} → ${target}, `
      + `stopped at ${reached}. ${why}`;
    await this.recordActivity(id, 'ASSAYER_LIFECYCLE_WALK_ABANDONED', from, reached, userId, remarks)
      .catch((err) => this.logger.error(`Could not record the abandoned walk for ${id}: ${(err as Error).message}`));
    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_LIFECYCLE_WALK_ABANDONED',
      entityType: 'ASSAYER',
      entityId: id,
      previousState: from,
      newState: reached,
      userId,
      remarks,
    }).catch((err) => this.logger.error(`Could not audit the abandoned walk for ${id}: ${(err as Error).message}`));
  }

  /**
   * THE LIFECYCLE AUTHORITY. Every change to `lifecycle_status` goes through this method.
   *
   * ## What was wrong, and why it needed restructuring rather than patching
   *
   * This method used to read the assayer with a plain `findOne` — outside any transaction, with
   * no row lock — validate the requested edge against that in-memory copy, and only then hand a
   * closure to `workflowEngine.executeCommand`, which opened the transaction and saved. The
   * save emitted `UPDATE assayers SET …, version = version + 1 WHERE id = $1`, with no version
   * predicate, and `@VersionColumn` does not supply one: TypeORM raises
   * `OptimisticLockVersionMismatchError` only when a caller explicitly uses
   * `setLock('optimistic', v)`, which nothing does for assayers.
   *
   * So two operators moving the same person at the same time both read ACTIVE, both validated
   * against ACTIVE, and both committed. Measured on the live deployment: eight simultaneous
   * pairs, eight times both requests returned 201. The row ended up wherever the later write
   * landed, and the audit trail was left holding two rows that each claim `previous_state =
   * ACTIVE` — one of them describing a transition that never took effect, attributed to a named
   * operator at a timestamp. That is worse than the lost update. `audit_events` is append-only
   * by database trigger precisely so it can be read back in a dispute, and it was being handed
   * a contradiction it can never be corrected out of.
   *
   * The same hole defeated the self-transition guard: six identical concurrent requests wrote
   * six audit rows for one move.
   *
   * ## The shape now
   *
   * Read, validate, mutate and audit all happen inside one transaction, with the assayer row
   * held under `SELECT … FOR UPDATE` for the whole of it — the pattern `AssignmentService`
   * already uses for its own state commands, which is why the assignment races passed the same
   * certification this one failed. Concretely:
   *
   *   1. lock the row and re-read the lifecycle state and version FROM THE LOCKED ROW;
   *   2. compare-and-swap against what the caller was looking at, and against `expectedVersion`
   *      when the client supplied one;
   *   3. validate the edge against the LOCKED state, never the pre-read one;
   *   4. enforce the reason requirement (see `LIFECYCLE_MOVES_NEEDING_A_REASON`);
   *   5. run the identity gate — AFTER the edge is known to be legal, so a refused transition
   *      can no longer leave "Activated without a verified identity" on the timeline of somebody
   *      who was never activated;
   *   6. apply, cascade the side effects, and write the audit and activity rows, all in the
   *      transaction the lock is held in.
   *
   * The loser of a race now gets a 409 naming the state it lost to, and the trail contains
   * exactly one row per transition that actually happened.
   *
   * ## Why the pre-read still exists
   *
   * `workflowEngine.executeCommand` takes `fromState` in its signature and checks it before
   * opening its transaction, so one read has to happen first. It is used for that argument and
   * as the CAS baseline — never as the thing the state machine validates against.
   */
  private async doTransitionLifecycle(
    id: string,
    targetStatus: AssayerLifecycleStatus,
    userId: string,
    reason?: string,
    role = SystemRole.ADMIN,
    expectedVersion?: number,
  ): Promise<{ saved: AssayerEntity; event: any }> {
    const preRead = await this.findOne(id);
    const currentStatus = preRead.lifecycleStatus;

    /**
     * An early look at the edge, for the SENTENCE only. The authoritative check is under the lock.
     *
     * `workflowEngine.executeCommand` runs its own `canTransition` before it opens the
     * transaction, and its refusal reads "Invalid transition from 'RESIGNED' to 'ACTIVE' for
     * command 'ACTIVE_Command'" — a sentence about a command name the operator has never heard
     * of. The state machine's is "Invalid lifecycle transition from 'RESIGNED' to 'ACTIVE'",
     * which is the one that used to reach people, because before this method was restructured
     * the state machine ran first.
     *
     * So the edge is checked here purely so the better message wins the race to be thrown. This
     * check is deliberately NOT trusted for correctness: it reads a row fetched outside the
     * transaction, so under a concurrent move it can be out of date in either direction. It is
     * allowed to be wrong. `validateTransition` inside the locked section is what actually
     * decides, and a request that slips past this one is refused there against the real state.
     */
    if (!canTransitionAssayerLifecycle(currentStatus, targetStatus)) {
      throw new BadRequestException(
        `Invalid lifecycle transition from '${currentStatus}' to '${targetStatus}'`,
      );
    }

    let event: any;

    return this.workflowEngine.executeCommand(
      'assayer',
      preRead.id,
      `${targetStatus}_Command`,
      currentStatus,
      targetStatus,
      userId,
      role,
      [],
      async (manager) => {
        const assayerRepo = manager ? manager.getRepository(AssayerEntity) : this.assayerRepository;

        /**
         * The lock, and everything that has to be decided while holding it.
         *
         * `FOR UPDATE` on the assayer row: a second transition against the same person blocks
         * here until this one commits or rolls back, and then re-reads what actually landed.
         * Without a `manager` there is no transaction to lock in — that only happens if a caller
         * bypasses the workflow engine, which nothing does — so the lock is skipped rather than
         * silently taken on a connection that will autocommit around it.
         */
        const locked: Array<{ lifecycle_status: string; version: number }> = manager
          ? await manager.query(
              'SELECT lifecycle_status, version FROM assayers WHERE id = $1 AND is_active = true FOR UPDATE',
              [preRead.id],
            )
          : [];
        const lockedStatus = (manager ? locked?.[0]?.lifecycle_status : currentStatus) as AssayerLifecycleStatus;
        const lockedVersion = manager ? Number(locked?.[0]?.version ?? 0) : preRead.version;
        if (manager && !lockedStatus) throw new NotFoundException(`Assayer ${preRead.id} not found.`);

        /**
         * Compare-and-swap. The pre-read is what the caller believed; `lockedStatus` is the
         * truth. When they differ, somebody else moved this person between the two reads and
         * the edge this request validated no longer starts where it thought.
         *
         * A 409 rather than a 400, and the difference is the point: the request was not
         * malformed and the operator did nothing wrong. They were looking at a screen that has
         * since gone stale, and the remedy is to refresh and decide again with the new facts —
         * which is exactly what the message says.
         */
        if (lockedStatus !== currentStatus) {
          throw new ConflictException(
            `This assayer changed while you were acting on it — they are now `
            + `'${lockedStatus}', not '${currentStatus}'. Refresh the record and decide again.`,
          );
        }

        /**
         * The client's own precondition, when it offers one. Optional because the HR screens do
         * not carry a version today; honoured strictly when present, so an integration or a
         * mobile client CAN demand the stronger guarantee. Mirrors the assignment commands,
         * including the distinction between a stale version and one that never existed.
         */
        if (expectedVersion !== undefined && expectedVersion !== lockedVersion) {
          throw new ConflictException(
            expectedVersion < lockedVersion
              ? `STALE_ASSAYER_VERSION: this record is at version ${lockedVersion} (you sent `
                + `${expectedVersion}). Refresh and try again.`
              : `INVALID_ASSAYER_VERSION: version ${expectedVersion} does not exist — the record `
                + `is at version ${lockedVersion}.`,
          );
        }

        /**
         * The edge is validated against the LOCKED state, by re-reading it onto the entity
         * first. Before this, the state machine was handed an entity loaded outside the
         * transaction, so its verdict described a world that may already have moved on.
         */
        const assayer = await assayerRepo.findOne({ where: { id: preRead.id } });
        if (!assayer) throw new NotFoundException(`Assayer ${preRead.id} not found.`);
        // Callers receive this entity back and some of them read skills off it; the pre-read
        // was hydrated by `findOne`, so the locked copy has to be too or the shape changes
        // depending on which branch produced it.
        await this.hydrateWorkforceAttributes(assayer).catch(() => undefined);

        /**
         * WHY THE REASON IS CHECKED HERE and not only at the routes.
         *
         * It used to live in `dispatchLifecycleTransition` (the single-move route) and, copied,
         * in `bulkTransitionLifecycle` — where it tested the FINAL target only. So a bulk walk
         * whose destination needs no reason skipped the requirement for every reason-requiring
         * state it passed through: `RESIGNED → … → ACTIVE` re-invited and fully re-onboarded a
         * departed person in one unreasoned call, and `ACTIVE → ARCHIVED` removed a working
         * assayer from the workforce with nothing on the record saying why.
         *
         * A rule enforced at two of the three doors is not enforced. This is the one door they
         * all pass through, and per hop.
         */
        if (AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON.has(targetStatus) && !reason?.trim()) {
          throw new BadRequestException(AssayerService.lifecycleReasonSentence(targetStatus));
        }

        /**
         * The ceiling, again. `TransitionLifecycleDto` already carries `@MaxLength`, so the HTTP
         * routes never get this far — but the DTO is not the authority, and the recovery routes
         * and any in-process caller reach the funnel without passing one. A 200,000-character
         * reason was previously stored in full, twice, into a table nothing can delete from.
         */
        if (reason && reason.length > LIFECYCLE_REASON_MAX_LENGTH) {
          throw new BadRequestException(
            `That reason is ${reason.length} characters. Keep it under ${LIFECYCLE_REASON_MAX_LENGTH} — `
            + 'it goes onto the employment record and into the audit trail, which cannot be edited later.',
          );
        }

        /**
         * Nobody becomes active until somebody has established who they are.
         *
         * Three positions, defaulting to warn. On the day this shipped not one document in the
         * estate had ever been verified, so enforcing from the first boot would have refused
         * every activation in the company against a process the desk had never operated — which
         * is how a control gets switched off permanently rather than adopted. See
         * `onboarding.identityGate.mode`.
         *
         * MOVED, twice. It used to run before the edge was validated, and outside the
         * transaction. Both were wrong in the same direction — they let a REFUSED activation
         * leave evidence behind. An illegal `INVITED → ACTIVE` was correctly rejected with a
         * 400, but by then the warn arm had already written "Activated without a verified
         * identity" onto the timeline of somebody who was never activated, on its own
         * connection, where the rejection could not roll it back. Four attempts, four rows.
         * Under `enforce` the same ordering answered the wrong question entirely: the operator
         * was told to go and chase documents when the real problem was that the transition does
         * not exist.
         *
         * Now it runs after `validateTransition` has accepted the edge, inside the transaction,
         * so it can only ever describe an activation that is actually going to happen.
         */
        const runIdentityGate = async () => {
          if (targetStatus !== AssayerLifecycleStatus.ACTIVE || !this.rosterRecords) return;
          const mode = await this.platformSettings?.get<string>('onboarding.identityGate.mode') ?? 'warn';
          if (mode === 'off') return;
          const standing = await this.rosterRecords.identityStanding(preRead.id);
          if (standing.ok) return;
          const outstanding = [...standing.missing, ...standing.rejected]
            .map((d) => ONBOARDING_DOCUMENT_LABELS[d]).join(' and ');
          const sentence = `${assayer.displayName} cannot be activated yet: ${outstanding} `
            + (standing.rejected.length > 0
              ? 'was sent back and has not been replaced. '
              : 'has not been checked against the original. ')
            + 'Open their Documents tab, check the scan against what is recorded, and mark it '
            + 'verified.';
          if (mode === 'enforce') {
            throw withCode(new BadRequestException(sentence), ASSAYER_ERROR_CODES.IDENTITY_NOT_VERIFIED);
          }
          this.logger.warn(`Identity gate (warn only): ${sentence}`);
          await this.recordActivity(
            preRead.id, 'ASSAYER_UPDATED', null, null, userId,
            `Activated without a verified identity — ${outstanding} still unchecked. The identity `
            + 'check is set to warn; switch it to Enforce in Settings once the queue is being worked.',
            manager,
          ).catch(() => undefined);
        };

        if (targetStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
          event = AssayerStateMachine.verifyDocuments(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
          event = AssayerStateMachine.initiateBackgroundCheck(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.TRAINING) {
          event = AssayerStateMachine.startTraining(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.ACTIVE) {
          AssayerStateMachine.assertCanActivate(assayer);
          await runIdentityGate();
          event = AssayerStateMachine.activate(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.ON_LEAVE) {
          event = AssayerStateMachine.putOnLeave(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.SUSPENDED) {
          event = AssayerStateMachine.suspend(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.INACTIVE) {
          event = AssayerStateMachine.deactivate(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.RESIGNED) {
          event = AssayerStateMachine.acceptResignation(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.TERMINATED) {
          event = AssayerStateMachine.terminate(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.ARCHIVED) {
          event = AssayerStateMachine.archive(assayer, userId);
        } else if (targetStatus === AssayerLifecycleStatus.INVITED) {
          event = AssayerStateMachine.rehire(assayer, userId);
        } else {
          throw new BadRequestException(`Invalid lifecycle status: ${targetStatus}`);
        }

        // Before the save, because these are columns on the entity about to be written.
        const datesCorrected = this.reconcileDepartureDates(assayer, targetStatus);

        const saved = await assayerRepo.save(assayer);

        // After the save, so a departure whose workflow command was refused does not close the
        // client standings of somebody still on the roster.
        const empanelmentsClosed = AssayerService.DEPARTED_LIFECYCLE.has(targetStatus)
          ? await this.closeClientEmpanelmentsOnDeparture(saved.id, targetStatus, userId, manager)
          : 0;

        /**
         * One id for the whole departure, minted before the cascade and written onto both ends
         * of it: every cancelled assignment's own audit row, and the single lifecycle row below.
         * Without it the connection between "she resigned" and "this branch is unassigned" is a
         * guess from two timestamps a second apart.
         */
        const departureEventId = AssayerService.DEPARTED_LIFECYCLE.has(targetStatus)
          ? randomUUID()
          : null;

        // Same reasoning, same scope, same "after the save" ordering as the empanelment close
        // above — see `cancelOpenAssignmentsOnDeparture` for why this exists at all.
        const assignmentsCancelled = AssayerService.DEPARTED_LIFECYCLE.has(targetStatus)
          ? await this.cancelOpenAssignmentsOnDeparture(
            saved.id, targetStatus, userId, manager, departureEventId ?? undefined,
          )
          : 0;

        /**
         * The bookkeeping goes on the record with the reason, not silently alongside it. A
         * departure date the system chose and an empanelment it ended are both things somebody
         * will ask about later — "who took her off the Axis list?" has to have an answer.
         */
        const consequences = [
          datesCorrected,
          empanelmentsClosed > 0
            ? `${empanelmentsClosed} client empanelment${empanelmentsClosed === 1 ? '' : 's'} closed`
            : null,
          assignmentsCancelled > 0
            ? `${assignmentsCancelled} open assignment${assignmentsCancelled === 1 ? '' : 's'} cancelled`
            : null,
        ].filter(Boolean).join('; ');
        const remarks = [reason?.trim() || null, consequences || null].filter(Boolean).join(' — ') || null;

        await this.recordActivity(saved.id, 'ASSAYER_LIFECYCLE_TRANSITION', currentStatus, targetStatus, userId, remarks, manager);
        await this.auditService.recordEvent(
          {
            category: EventCategory.WORKFLOW,
            eventType: 'ASSAYER_LIFECYCLE_TRANSITION',
            entityType: 'ASSAYER',
            entityId: saved.id,
            previousState: currentStatus,
            newState: targetStatus,
            userId,
            remarks: remarks || `Lifecycle transition: ${currentStatus} → ${targetStatus}`,
            /**
             * The other end of the join. This row says how many assignments a departure closed;
             * the `ASSIGNMENT_CANCELLED` rows carrying the same `departureEventId` say which.
             */
            ...(departureEventId
              ? { metadata: { departureEventId, assignmentsCancelled, empanelmentsClosed } }
              : {}),
          },
          manager ? { manager } : undefined,
        );

        // Only on the crossing into ACTIVE, never on a re-save at ACTIVE. The dedupe key is the
        // assayer alone, so a later ON_LEAVE → ACTIVE return does not re-announce someone who
        // was onboarded months ago — "newly onboarded" is true exactly once per person.
        if (targetStatus === AssayerLifecycleStatus.ACTIVE && currentStatus !== AssayerLifecycleStatus.ACTIVE) {
          this.notificationDispatch.emitSafe({
            type: 'ASSAYER_ONBOARDED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            actorUserId: userId,
            assayerId: saved.id,
            dedupeKey: `ASSAYER_ONBOARDED:${saved.id}`,
            payload: { assayerName: saved.displayName },
          });
        }

        return { saved, event };
      }
    );
  }

  /**
   * Brings the departure dates into line with the state the assayer is being moved to, and
   * returns a sentence describing any correction so it can be written onto the record.
   *
   * Leaving. 24 of the 1,163 people the roster import brought in are RESIGNED or TERMINATED with
   * no departure date at all, so nothing that counts departures can see that they went: HR's
   * attrition rate, the roster's "Exited" chip and the workforce header's exit count all read a
   * date, and all three report zero for those 24. It was 5 until `scripts/repair-corrupt-dates.js`
   * blanked 19 more — their leaving dates were importer garbage in years 5295–6362, which read as
   * departures only because nothing checked the year. The class did not grow; it was always this
   * size and three quarters of it was hidden behind dates that looked filled in. The date is
   * *recorded* rather than *demanded* deliberately. Refusing the transition until somebody types
   * one leaves the person ACTIVE — still passing the planner's deployability gate, still offered
   * audits — and a departure dated the day it was processed instead of the day they actually left
   * is a far smaller error than a departure that never got recorded because the form would not
   * accept it. A date HR has already entered is never overwritten: that is the real last working
   * day, and it beats today's.
   *
   * `exit_date` is the column that carries it, for both kinds of leaving. All 421 recorded
   * departures on the live roster use it and not one uses `termination_date` — the column is
   * empty on every row — and HR's own queries read `COALESCE(exit_date, termination_date)`.
   * (447 before the repair; the 26 it blanked are the difference.) A termination stamps
   * `termination_date` as well, because "they were dismissed" is a fact the exit date alone does
   * not carry — but a termination with only that column set would be invisible to every reader
   * above, which is the failure this arm exists to avoid rather than one the data currently
   * shows.
   *
   * Coming back. 2 people are lifecycle ACTIVE with an exit date behind them: the record says both
   * that they work here and that they left, and the departure counts include somebody who is on
   * the plan tomorrow. Returning to ACTIVE therefore clears a departure date that has already
   * passed. A date still ahead is left alone — that is a notice period, which is a coherent thing
   * for a working person to have, and clearing it would erase a leaving date somebody entered on
   * purpose.
   */
  private reconcileDepartureDates(assayer: AssayerEntity, target: AssayerLifecycleStatus): string | null {
    const today = calendarDay(new Date())!;
    const corrections: string[] = [];

    if (AssayerService.DEPARTED_LIFECYCLE.has(target)) {
      if (!assayer.exitDate) {
        assayer.exitDate = new Date();
        corrections.push(`exit date recorded as ${today}`);
      }
      if (target === AssayerLifecycleStatus.TERMINATED && !assayer.terminationDate) {
        assayer.terminationDate = new Date();
        corrections.push(`termination date recorded as ${today}`);
      }
      /**
       * A date this method chose has to survive the same check a typed one does. Stamping today
       * onto somebody whose joining date is in the future would manufacture precisely the
       * impossible pair `create` and `update` refuse, and would do it automatically, at scale, in
       * a bulk transition — the one route by which a guard can end up creating the rows it exists
       * to prevent. Only asserted when something was stamped: an inverted pair the record already
       * carried is the data fix's problem, and refusing to record a real departure because of it
       * would leave that person deployable.
       */
      if (corrections.length) assertEmploymentDatesArePossible(assayer);
      return corrections.length ? corrections.join(', ') : null;
    }

    if (target === AssayerLifecycleStatus.ACTIVE) {
      const exit = calendarDay(assayer.exitDate);
      if (exit && exit <= today) {
        assayer.exitDate = null;
        corrections.push(`exit date ${exit} cleared on returning to work`);
      }
      const terminated = calendarDay(assayer.terminationDate);
      if (terminated && terminated <= today) {
        assayer.terminationDate = null;
        corrections.push(`termination date ${terminated} cleared on returning to work`);
      }
      return corrections.length ? corrections.join(', ') : null;
    }

    /**
     * Rehire: RESIGNED/TERMINATED → INVITED (2026-09-07). Load-bearing, not cosmetic — shared
     * `hasLeftWorkforce` (packages/shared/src/assayer-lifecycle.ts) reads `lifecycleStatus` alone
     * for this class of departure, so the status flip above already makes `stillWorkable`/
     * `ON_ROSTER` see this person as back. But every OTHER reader of a departure date — HR's
     * attrition figures, the roster's "Exited" chip, the workforce header's exit count — reads
     * `exitDate`/`terminationDate` regardless of status, and a stale departure date left in place
     * would keep counting a rehired, actively-onboarding person as an exit.
     *
     * Unconditional, unlike the ACTIVE branch above: that branch only clears a date already in
     * the past, leaving a future one alone because it could be a genuine notice period on someone
     * who never actually left. INVITED has no such case — its only inbound edge is this rehire,
     * which only exists because the person genuinely left before — so there is nothing to protect
     * by leaving either date in place.
     */
    if (target === AssayerLifecycleStatus.INVITED) {
      if (assayer.exitDate) {
        corrections.push(`exit date ${calendarDay(assayer.exitDate)} cleared on rehire`);
        assayer.exitDate = null;
      }
      if (assayer.terminationDate) {
        corrections.push(`termination date ${calendarDay(assayer.terminationDate)} cleared on rehire`);
        assayer.terminationDate = null;
      }
      return corrections.length ? corrections.join(', ') : null;
    }

    return null;
  }

  /**
   * Ends the client standings that keep someone who has left selectable, and reports how many.
   *
   * 7 people who had left still held an ACTIVE empanelment when this was written, so each
   * remained an eligible candidate for that bank's branches: the planner's per-client gate admits
   * an ACTIVE or RECOMMENDED standing and asks nothing whatsoever about whether the person still
   * works here. Those 7 have since been closed by the empanelment repair (originals in
   * `_fix_backup_empanelments`) and the live count is zero, which `DataIntegrityService`'s check 5
   * asserts on every scan — that check is the standing alarm, this method is what stops the
   * backlog re-forming one departure at a time. Both standings are closed, not just ACTIVE —
   * RECOMMENDED means "put forward, awaiting the client's decision", and somebody who has resigned
   * is not a candidate we are still putting forward.
   *
   * They become INACTIVE — "empanelled once, dormant now" — rather than RESIGNED or TERMINATED.
   * Those two record the *client's* decision about this person, and the client has not made one;
   * writing them here would put words in a bank's mouth. INACTIVE is also the only closed standing
   * the planner's excluded panel explains as reversible ("reactivate it on the vetting screen"),
   * which is exactly the affordance a reinstatement needs. The reason names the departure so the
   * next person to look does not have to infer it.
   *
   * Nothing reopens these. Coming back to ACTIVE clears the person's own contradictory dates, but
   * putting somebody back onto a bank's empanelment list is the bank's decision, never a side
   * effect of an HR screen — so the way back in is the vetting screen and a human. The asymmetry
   * is the point: leaving is our fact to record, returning to a client's panel is theirs.
   */
  private async closeClientEmpanelmentsOnDeparture(
    assayerId: string,
    target: AssayerLifecycleStatus,
    userId: string,
    manager?: EntityManager,
  ): Promise<number> {
    // TypeORM returns `[rows, rowCount]` from an UPDATE, not a rows array. Runs through the
    // caller's transaction manager when given one, so this closes together with the lifecycle
    // save rather than surviving a rollback of it.
    const runner = manager ?? this.dataSource;
    const [, affected] = await runner.query(
      `UPDATE assayer_client_empanelments
          SET status = $1, status_reason = $2, updated_by = $3
        WHERE assayer_id = $4 AND is_active = true AND status IN ($5, $6)`,
      [
        EmpanelmentStatus.INACTIVE,
        `Closed automatically on ${calendarDay(new Date())}: the assayer's workforce record was ` +
        `moved to ${target}. Reinstating them with this client is a fresh decision for the client.`,
        userId,
        assayerId,
        EmpanelmentStatus.ACTIVE,
        EmpanelmentStatus.RECOMMENDED,
      ],
    ) ?? [];
    return typeof affected === 'number' ? affected : 0;
  }

  /**
   * Ends this person's open assignments the moment they actually leave, and reports how many.
   *
   * `remove()` (a full delete) has always cancelled non-completed assignments — see its own
   * cascade — but resigning or terminating someone through the ordinary lifecycle screen is a
   * completely different code path, `doTransitionLifecycle`, which called
   * `closeClientEmpanelmentsOnDeparture` and stopped there. An assignment already offered or
   * accepted before the departure was left exactly as it stood: HR records somebody as
   * TERMINATED and the roster, the branch, and the client's expectation all still say that
   * person is coming. Live on this deployment: AS-04 (Aditya Sharma) holds four PENDING
   * assignments and AS-01 (Nilesh Rahane) one ACCEPTED one — moving either to TERMINATED closed
   * their empanelments as the existing code already promised and left every one of those
   * assignments exactly as it stood, with no warning anywhere HR would see it. The same defect
   * `remove()`'s own comment describes ("a 'deleted' person still holding live assignments and
   * dated slots"), reachable by the much more common door — read, not reproduced against either
   * of them: both are real people on the live roster, not test data. Reproduced instead against a
   * throwaway assayer and a throwaway assignment row — see `assayer.service.spec.ts`.
   *
   * Scoped to `DEPARTED_LIFECYCLE` (RESIGNED, TERMINATED) exactly like the empanelment close
   * next to it, and for the same reason: SUSPENDED, INACTIVE and ON_LEAVE are "not right now",
   * not "not any more" — an assignment held by someone on leave is not orphaned, it is waiting
   * for them, and auto-cancelling it on a status that is meant to be temporary would be a new
   * defect in the other direction.
   *
   * `status` only, not `is_active`: unlike `remove()`, the assayer's own row is NOT being taken
   * out of the operational picture here (`is_active` stays true — they are still an employee
   * record, just not a workable one), so their cancelled assignments should stay visible as
   * "cancelled" wherever assignments are normally listed, rather than disappear the way `remove()`
   * deliberately makes them disappear along with the person. `CANCELLED` is a terminal status
   * either way, which is what actually frees the branch and the schedule slot — see the comment
   * on `remove()`'s own assignment cascade for why a terminal status, not `is_active`, is what a
   * busy-check must see.
   */
  private async cancelOpenAssignmentsOnDeparture(
    assayerId: string,
    target: AssayerLifecycleStatus,
    userId: string,
    manager?: EntityManager,
    /**
     * The departure this cascade belongs to. Written into every assignment's audit row so the
     * cancellations and the lifecycle move that caused them can be joined back together — see
     * `auditCancelledOnDeparture`.
     */
    departureEventId?: string,
  ): Promise<number> {
    const runner = manager ?? this.dataSource;
    const reason = `Assayer workforce record moved to ${target} on ${calendarDay(new Date())}; ` +
      'the work could not proceed as planned. Reassign it if it still needs doing.';

    /**
     * One statement, and it hands back what it changed.
     *
     * The previous status has to come out of the same statement that overwrites it — read it
     * first and a concurrent accept between the read and the update makes the audit row describe
     * a state the assignment was no longer in. The self-join onto a `FOR UPDATE` subquery is how
     * an UPDATE reports the value it replaced: `before` is the row as it stood under the lock,
     * `a` is the row as it now stands.
     *
     * The predicate is unchanged — `OPEN_ASSIGNMENT_STATUSES`, is_active — so COMPLETED,
     * CANCELLED and REJECTED work is neither mutated nor audited. Nothing about a delivered or
     * already-closed assignment changes because somebody left.
     */
    const raw = await runner.query(
      `UPDATE assignments a
          SET status = $1, cancel_reason = $2, updated_by = $3,
              entity_version = COALESCE(a.entity_version, 1) + 1, updated_at = NOW()
         FROM (
           SELECT id, status, entity_version
             FROM assignments
            WHERE assayer_id = $4 AND is_active = true AND status = ANY($5)
              FOR UPDATE
         ) AS before
        WHERE a.id = before.id
    RETURNING a.id,
              a.assignment_number,
              before.status        AS previous_status,
              before.entity_version AS previous_version,
              a.entity_version      AS new_version,
              a.scheduled_date,
              a.project_branch_id`,
      [AssignmentStatus.CANCELLED, reason, userId, assayerId, AssayerService.OPEN_ASSIGNMENT_STATUSES],
    );

    /**
     * `[rows, affectedCount]`, not `rows` — and getting this wrong is silent.
     *
     * TypeORM hands a writing statement back as a two-element tuple, which is why the previous
     * version of this method read the count as `const [, affected] = …`. Treating that tuple as
     * the row list iterates over `[rows]` and a number, so every audit row is written with an
     * undefined `entityId`: the count on the employment record is right, the assignments still
     * have nothing against them, and every HTTP response is a 200. The unit fixture that served
     * rows directly was the shape that hid it; the live run is what found it.
     *
     * Both shapes are accepted rather than depending on a driver version — an array of arrays is
     * the tuple, an array of rows is the rows.
     */
    const cancelled: CancelledAssignmentRow[] = Array.isArray(raw) && Array.isArray(raw[0])
      ? raw[0]
      : (Array.isArray(raw) ? raw : []);

    await this.auditCancelledOnDeparture(cancelled, assayerId, target, userId, reason, manager, departureEventId);

    // Same follow-on `remove()` already applies: a cancelled assignment must not leave its
    // scheduled visit looking live on the calendar, the day plan or the dispatch view.
    await runner.query(
      `UPDATE schedules SET is_active = false, updated_by = $1
        WHERE is_active = true AND assignment_id IN (
          SELECT id FROM assignments WHERE assayer_id = $2 AND status = $3
        )`,
      [userId, assayerId, AssignmentStatus.CANCELLED],
    );

    return cancelled.length;
  }

  /**
   * AN ASSIGNMENT CANCELLED BY SOMEBODY'S DEPARTURE SAYS SO, ON ITS OWN RECORD.
   *
   * The cascade above used to write nothing against the assignments it cancelled. The only trail
   * was a single row on the ASSAYER — `4 open assignments cancelled` — which names neither the
   * assignments nor the branches nor the client whose work stopped. So the question an operations
   * lead actually asks, standing in front of one job that vanished ("why is this branch
   * unassigned, and who did it?"), had no answer anywhere in the system: the assignment's own
   * trail simply skipped from ACCEPTED to nothing, and `cancel_reason` was the only clue, on a
   * mutable column with no actor and no timestamp beside it.
   *
   * Every other cancel path in the product writes `ASSIGNMENT_CANCELLED` through
   * `assignment.service.ts`. This one bypassed the service entirely — a raw UPDATE, for the good
   * reason that the state machine's cancel demands things a cascade cannot supply — and took the
   * audit row with it. The event is written here in the same vocabulary, so an assignment history
   * reads the same whoever ended the work.
   *
   * `recordEvent`, not `recordEventSafe`, and on the transition's own `manager`: a cancellation
   * that cannot be recorded must not commit. The alternative is the exact silence this fixes,
   * reintroduced for the case where it matters most.
   *
   * `departureEventId` is the join key. The lifecycle row carries the same value, so "show me
   * everything that happened when she left" is one query rather than a guess based on timestamps
   * a second apart.
   */
  private async auditCancelledOnDeparture(
    cancelled: CancelledAssignmentRow[],
    assayerId: string,
    target: AssayerLifecycleStatus,
    userId: string,
    reason: string,
    manager?: EntityManager,
    departureEventId?: string,
  ): Promise<void> {
    for (const row of cancelled) {
      await this.auditService.recordEvent(
        {
          category: EventCategory.OPERATIONAL,
          eventType: `ASSIGNMENT_${AssignmentStatus.CANCELLED}`,
          entityType: 'ASSIGNMENT',
          entityId: row.id,
          previousState: row.previous_status,
          newState: AssignmentStatus.CANCELLED,
          userId,
          remarks: reason,
          metadata: {
            /** What ended the work, so the row explains itself without the assayer's trail. */
            cause: 'ASSAYER_DEPARTURE',
            lifecycleTarget: target,
            /**
             * The assayer this work was taken from. `assayer_id` is deliberately NOT cleared by
             * the cascade — the job stays attributed to whoever held it — but a reader looking at
             * a cancelled assignment months later should not have to infer the connection.
             */
            previousAssayerId: assayerId,
            /** The join key back to the one ASSAYER_LIFECYCLE_TRANSITION row for this departure. */
            departureEventId: departureEventId ?? null,
            assignmentNumber: row.assignment_number,
            projectBranchId: row.project_branch_id,
            scheduledDate: row.scheduled_date,
            previousValue: { status: row.previous_status, entityVersion: row.previous_version },
            newValue: { status: AssignmentStatus.CANCELLED, entityVersion: row.new_version },
            entityVersion: row.new_version,
          },
        },
        manager ? { manager } : undefined,
      );
    }
  }

  async verifyDocuments(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.DOCUMENT_VERIFICATION, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async initiateBackgroundCheck(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.BACKGROUND_VERIFICATION, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async startTraining(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.TRAINING, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async activateAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.ACTIVE, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async putOnLeave(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.ON_LEAVE, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async suspendAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.SUSPENDED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async deactivateAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.INACTIVE, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async acceptResignation(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.RESIGNED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async terminateAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.TERMINATED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async archiveAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.ARCHIVED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  /** RESIGNED/TERMINATED → INVITED. See `AssayerStateMachine.rehire`. */
  async rehireAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.INVITED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  // ---- Controlled Operator Recovery Actions ----

  /**
   * REWIND a stuck joiner to an earlier onboarding stage. It cannot do anything else.
   *
   * ## What this used to be, and what it cost
   *
   * It wrote `lifecycleStatus` straight onto the entity, and its only guard on the CURRENT state
   * was "not ACTIVE". Everything else walked through. The certification reproduced the worst
   * case in two API calls:
   *
   *     POST /assayers/:id/lifecycle {"targetStatus":"TRAINING"}          -> 400, correctly refused
   *     POST /assayers/:id/recovery/reset-onboarding-stage
   *          {"targetStage":"TRAINING","reason":"..."}                    -> 201
   *     POST /assayers/:id/lifecycle {"targetStatus":"ACTIVE"}            -> 201
   *
   * A dismissed person was back at work. Their audit trail contained no DOCUMENT_VERIFICATION
   * event and no BACKGROUND_VERIFICATION event, because neither happened; sign-in was restored;
   * the planner offered them for real branch work; and the departure dates were silently wiped by
   * the activation. The shared map's own comment exists to prevent exactly this — a rehire walks
   * the whole document → background → training chain BECAUSE identity was verified against
   * papers that may have expired and a termination usually happened for a reason somebody should
   * re-examine. Two calls defeated it. The same route also laundered a suspension: SUSPENDED →
   * DOCUMENT_VERIFICATION → … → ACTIVE returned somebody to work with no reinstatement decision
   * anywhere on file.
   *
   * ## What it is now
   *
   * A rewind, and only a rewind. The source must ALREADY be an onboarding stage and the target
   * must be at or before it. So it can undo a step somebody took by mistake, and it cannot
   * fabricate progress, cannot re-enter onboarding from outside it, and cannot manufacture a
   * rehire. Coming back after leaving is `RESIGNED/TERMINATED → INVITED`, deliberately, with a
   * reason, and then the chain walked properly.
   *
   * Kept as a policy operation rather than folded into the transition map, because a backwards
   * step is not a lifecycle event: nothing happened to this person, somebody corrected a filing
   * error. It writes its own distinctly-typed audit row saying so, and it holds the same row lock
   * as a real transition so it cannot race one.
   */
  async operatorResetOnboardingStage(
    id: string,
    targetStage: AssayerLifecycleStatus,
    reason: string,
    userId: string,
  ): Promise<AssayerEntity> {
    if (!ONBOARDING_STAGES.includes(targetStage)) {
      throw new BadRequestException(
        `Cannot reset to ${targetStage}: an onboarding rewind may only target an onboarding stage `
        + `(${ONBOARDING_STAGES.join(', ')}).`,
      );
    }

    if (!reason || reason.trim().length < 10) {
      throw new BadRequestException('A substantive operational reason (minimum 10 characters) is required to reset an onboarding stage.');
    }

    return this.uow.run(async (manager) => {
      const repo = manager.getRepository(AssayerEntity);
      const locked: Array<{ lifecycle_status: string }> = await manager.query(
        'SELECT lifecycle_status FROM assayers WHERE id = $1 AND is_active = true FOR UPDATE',
        [id],
      );
      const prevStatus = locked?.[0]?.lifecycle_status as AssayerLifecycleStatus;
      if (!prevStatus) throw new NotFoundException(`Assayer ${id} not found.`);

      /**
       * The source gate. "Not ACTIVE" was never the rule anybody meant — it admitted every
       * departed, suspended and on-leave state as a doorway back into onboarding.
       */
      if (!ONBOARDING_STAGES.includes(prevStatus)) {
        throw new BadRequestException(
          `Cannot reset onboarding for somebody who is ${prevStatus}: this corrects a joiner who is `
          + 'still going through onboarding. Bringing back a leaver is a rehire — move them to '
          + 'Invited and walk the checks again.',
        );
      }

      // Rewind only. Forward progress is a real transition, with its own event and its own gates.
      if (ONBOARDING_STAGES.indexOf(targetStage) > ONBOARDING_STAGES.indexOf(prevStatus)) {
        throw new BadRequestException(
          `Cannot reset ${prevStatus} forward to ${targetStage}: an onboarding rewind only goes `
          + 'back. To advance them, use the lifecycle action on their record.',
        );
      }

      if (targetStage === prevStatus) {
        throw new BadRequestException(`This assayer is already at ${prevStatus}.`);
      }

      const assayer = await repo.findOne({ where: { id } });
      if (!assayer) throw new NotFoundException(`Assayer ${id} not found.`);

      assayer.lifecycleStatus = targetStage;
      assayer.deriveOperationalStatus();
      assayer.isActive = true; // every onboarding stage is on the roster; ARCHIVED is unreachable here
      assayer.updatedBy = userId;
      const saved = await repo.save(assayer);

      await this.recordActivity(
        saved.id, 'ASSAYER_UPDATED', prevStatus, targetStage, userId,
        `Onboarding rewound from ${prevStatus} to ${targetStage}: ${reason.trim()}`, manager,
      ).catch(() => undefined);

      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_ONBOARDING_STAGE_RESET',
        entityType: 'ASSAYER',
        entityId: saved.id,
        previousState: prevStatus,
        newState: targetStage,
        userId,
        remarks: `Operator reset onboarding stage from ${prevStatus} to ${targetStage}: ${reason.trim()}`,
        metadata: { previousStage: prevStatus, newStage: targetStage, reason: reason.trim() },
      }, { manager });

      return saved;
    }).then(async (saved) => {
      /**
       * Outside the transaction, and unable to fail it.
       *
       * A rewind changes what the guard tells a signed-in assayer about their own onboarding, so
       * the cached principal has to go — but dropping it is a cache concern, not a correctness
       * one. Inside the `uow.run` above, a Redis hiccup would have rolled back a state change
       * that had every right to commit. The principal cache is fail-closed anyway
       * (`loadPrincipal` re-reads and re-checks `maySignIn`), so the worst a missed invalidation
       * costs is a stale session for the remainder of its TTL.
       */
      await this.cache?.del?.(rbacPrincipalCacheKey(saved.id))?.catch?.(() => undefined);
      return saved;
    });
  }

  /**
   * Revoke an invitation nobody took up.
   *
   * This is now a thin wrapper over the lifecycle authority. It used to write `ARCHIVED` onto the
   * entity by hand, from INVITED or DOCUMENT_VERIFICATION — an edge the transition map called
   * illegal and the transition endpoint refused with a 400 at the very same moment this route
   * performed it. The system held two opinions and the screens only knew about one, so the roster
   * could not offer the move and 79 unaccepted invitations had no way out at all.
   *
   * Both edges are in the shared map now (see `ASSAYER_LIFECYCLE_TRANSITIONS`), so the state
   * machine validates them, the UI can offer them, and the audit trail records them as the
   * transitions they are. What this route keeps is its own stricter door: a ten-character reason,
   * where the general endpoint would accept any non-blank one. Revoking somebody's invitation is
   * a decision about a person nobody has recorded anything about yet, and "no" is not a reason.
   */
  async operatorRevokeInvitation(id: string, reason: string, userId: string): Promise<AssayerEntity> {
    if (!reason || reason.trim().length < 10) {
      throw new BadRequestException('A substantive operational reason (minimum 10 characters) is required to revoke an invitation.');
    }

    const assayer = await this.findOne(id);
    const allowedStatuses = [AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.DOCUMENT_VERIFICATION];
    if (!allowedStatuses.includes(assayer.lifecycleStatus)) {
      throw new BadRequestException(`Cannot revoke invitation: assayer is currently in ${assayer.lifecycleStatus} stage.`);
    }

    const saved = await this.transitionLifecycle(
      id, AssayerLifecycleStatus.ARCHIVED, userId, `Invitation revoked: ${reason.trim()}`,
    );

    // Kept alongside the lifecycle row the funnel writes: "an invitation was withdrawn" is a
    // different question from "who archived this record", and the two are asked by different
    // people. The metadata carries the reason on its own so a query does not have to parse it
    // back out of the remark.
    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_INVITATION_REVOKED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      previousState: assayer.lifecycleStatus,
      newState: AssayerLifecycleStatus.ARCHIVED,
      userId,
      remarks: `Invitation revoked: ${reason.trim()}`,
      metadata: { reason: reason.trim() },
    });

    return saved;
  }

  /**
   * Reconcile departed assayer empanelments: closes active/recommended empanelments
   * for an assayer whose workforce status is RESIGNED, TERMINATED, ARCHIVED, or INACTIVE.
   */
  async operatorReconcileDepartedEmpanelments(assayerId: string, reason: string, userId: string): Promise<number> {
    const assayer = await this.findOne(assayerId);
    const isDeparted = [
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
      AssayerLifecycleStatus.ARCHIVED,
      AssayerLifecycleStatus.INACTIVE,
    ].includes(assayer.lifecycleStatus);

    if (!isDeparted) {
      throw new BadRequestException(`Assayer ${assayer.assayerCode} is currently ${assayer.lifecycleStatus} (not departed). Empanelment reconciliation only applies to departed personnel.`);
    }

    const closedCount = await this.closeClientEmpanelmentsOnDeparture(assayerId, assayer.lifecycleStatus, userId);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'DEPARTED_EMPANELMENTS_RECONCILED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId,
      remarks: `Operator reconciled departed empanelments (${closedCount} closed): ${reason.trim()}`,
      metadata: { closedCount, reason: reason.trim() },
    });

    return closedCount;
  }

  // ---- Stats & Profile ----

  /**
   * The cached `averageRating` on the assayer row, on the 1–5 scale its readers expect.
   *
   * Remarks themselves are written and read through AssayerRemarksService (modules/assayer-remarks);
   * this is the only remark-derived figure that still lives here, because it is a column on the
   * assayer row and is also refreshed from `updateAssayerStats`.
   *
   * Remark ratings are stored −2…+2 (see modules/assayer-remarks and migration
   * AssayerRemarkRatings1791430000000). This used to write the raw average, which was harmless
   * while no screen ever set a rating — the column sat at 0 and every reader hid it — but with the
   * signed scale a single +1 remark came out as "1.0 out of 5", the opposite of what was said.
   * `3 + mean` maps the neutral point to 3.0, all −2 to 1.0 and all +2 to 5.0, which is what the
   * planning modal's colour thresholds (≥4 good, ≥3 fair) and the mobile "out of 5" tile read.
   * Zero remains "nothing rated yet" and is still hidden by every reader's `> 0` guard.
   *
   * Deliberately a plain average over all live rated remarks, not the engine's recency-weighted
   * one: this is a lifetime figure on the profile, the engine's is a "who are they now" score,
   * and the two are labelled differently on screen.
   */
  async recomputeAverageRating(assayerId: string): Promise<void> {
    const result = await this.remarkRepository
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'avg')
      .where('r.assayerId = :assayerId', { assayerId })
      .andWhere('r.rating IS NOT NULL')
      .andWhere('r.isActive = :isActive', { isActive: true })
      .getRawOne();
    const mean = result?.avg === null || result?.avg === undefined ? null : Number(result.avg);
    const outOfFive = mean === null || !Number.isFinite(mean)
      ? 0
      : parseFloat(Math.max(1, Math.min(5, 3 + mean)).toFixed(2));
    await this.assayerRepository.update(assayerId, { averageRating: outOfFive });
  }

  /**
   * Recompute the derived counters cached on the assayer row.
   *
   * Nine independent reads and two writes. They used to run strictly one after another, each
   * waiting on the previous for no reason — none of them takes an input from another. On the
   * critical path of every assignment transition (accept, reject, cancel, complete), that was a
   * chain of round-trips the operator sat through before their click returned, and it grows with
   * the assayer's history rather than staying constant.
   *
   * Now issued together. Nothing else about the computation changes; the queries and the values
   * they produce are identical.
   */
  async updateAssayerStats(assayerId: string): Promise<void> {
    const mgr = this.assayerRepository.manager;

    // NOTE: 'AUDIT_COMPLETED'/'VALIDATION_COMPLETED'/'CLOSED' are ProjectBranchStatus values,
    // not AssignmentStatus values — they belong only in the pb.status clause. Putting them in
    // a.status IN (...) makes Postgres reject the whole query (invalid enum value for
    // assignments_status_enum), which silently no-ops every call via the caller's catch block.
    const [
      total,
      completedResult,
      cancelled,
      onTimeResult,
      lastAssignment,
    ] = await Promise.all([
      mgr.count('assignments', { where: { assayerId, isActive: true } }),
      mgr.query(
        `SELECT COUNT(*) as cnt FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         WHERE a.assayer_id = $1 AND a.is_active = true
         AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))`,
        [assayerId],
      ),
      mgr.count('assignments', {
        where: { assayerId, status: AssignmentStatus.CANCELLED, isActive: true },
      }),
      mgr.query(
        `SELECT COUNT(*) as cnt FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         WHERE a.assayer_id = $1 AND a.is_active = true
         AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))
         AND (a.completion_date IS NULL OR a.scheduled_date IS NULL OR a.completion_date <= a.scheduled_date)`,
        [assayerId],
      ),
      mgr.query(
        `SELECT updated_at FROM assignments a
         WHERE a.assayer_id = $1 AND a.is_active = true
         ORDER BY a.updated_at DESC LIMIT 1`,
        [assayerId],
      ),
    ]);

    const completed = Number(completedResult[0]?.cnt ?? 0);

    // Earnings are deliberately NOT cached here. What an assayer is owed has exactly one answer —
    // `BillingEngineService.assayerTotals` — and a counter that self-heals on read is still a
    // second answer that can be wrong between reads.
    await this.assayerRepository.update(assayerId, {
      totalAssignments: total,
      completedAssignments: completed,
      cancelledAssignments: cancelled,
      onTimeCompletions: Number(onTimeResult[0]?.cnt ?? 0),
      lastAssignmentDate: lastAssignment[0]?.updated_at ?? null,
    });
    await this.recomputeAverageRating(assayerId);
  }

  /**
   * Refresh the cached counters without making the caller wait.
   *
   * These are derived values — assignment counts, earnings, rating — read by roster listings and
   * reports, never by the response of the action that changes them. Awaiting the recompute inside
   * an assignment transition put a fan of queries between the operator's click and its
   * confirmation, for numbers nobody was about to look at. `getProfile` recomputes on read, so a
   * momentarily stale counter self-corrects the instant it matters.
   *
   * Failures are logged, never propagated: statistics must not be able to fail an acceptance.
   */
  scheduleStatsRefresh(assayerId: string): void {
    void this.updateAssayerStats(assayerId).catch((err) =>
      this.logger.warn(`Could not refresh cached stats for assayer ${assayerId}: ${err?.message}`),
    );
  }

  async getProfile(assayerId: string): Promise<AssayerEntity> {
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(assayerId);
    const where: any[] = isUuid
      ? [{ id: assayerId, isActive: true }]
      : [{ assayerCode: assayerId, isActive: true }, { employeeId: assayerId, isActive: true }];
    /**
     * `tenantWhere` and not a single appended clause, because this `where` is an ARRAY and
     * TypeORM OR-s an array. Adding `{ organizationId }` as a fourth element would produce
     * `(code = x) OR (employeeId = x) OR (org = mine)` — every assayer in the caller's own
     * organisation, matched by nothing but membership, which is a wider query than the unscoped
     * one it replaced. The helper distributes the predicate into each branch instead.
     *
     * This route is the dossier the app and the roster screen both open, and it accepts an
     * assayer *code* as well as a uuid — codes are short and sequential (`AS0688`), so an
     * unscoped lookup by code was cross-tenant enumeration with no guessing required.
     */
    const assayer = await this.assayerRepository.findOne({ where: tenantWhere<AssayerEntity>(where) });
    if (!assayer) throw new NotFoundException(`Assayer ${assayerId} not found.`);

    // Live update stats & ratings from real DB tables
    await this.updateAssayerStats(assayer.id).catch(err => console.error('Failed to update assayer stats in profile:', err));

    // Refetch to get fresh metrics
    const updated = await this.assayerRepository.findOne({ where: { id: assayer.id } });
    const target = updated || assayer;

    await this.hydrateWorkforceAttributes(target);

    const mgr = this.assayerRepository.manager;

    // 1. Query Count raised against this assayer.
    // Counted on vq.assayer_id directly — the previous version joined `a.id = vq.assignment_id`,
    // a column validation_queries does not have, so Postgres errored on every call and the
    // `.catch(() => 0)` below reported zero clarifications for every assayer, forever, silently.
    const queryRes = await mgr.query(
      `SELECT COUNT(*) as cnt FROM validation_queries vq
       WHERE vq.assayer_id = $1 AND vq.is_active = true`,
      [target.id],
    ).catch(() => [{ cnt: 0 }]);
    (target as any).queryCount = Number(queryRes[0]?.cnt ?? 0);

    // 2. Acceptance vs Rejection Rate Breakdown
    const totalOffered = await mgr.count('assignments', { where: { assayerId: target.id, isActive: true } });
    const acceptedCount = await mgr.count('assignments', { where: { assayerId: target.id, status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED]), isActive: true } });
    const rejectedCount = await mgr.count('assignments', { where: { assayerId: target.id, status: AssignmentStatus.REJECTED, isActive: true } });
    
    (target as any).acceptanceRate = totalOffered > 0 ? Math.round((acceptedCount / totalOffered) * 100) : 100;
    (target as any).rejectionRate = totalOffered > 0 ? Math.round((rejectedCount / totalOffered) * 100) : 0;

    // 3. Full Audit History with branch details & fees
    const auditHistory = await mgr.query(
      `SELECT a.id, a.assignment_number, a.status, a.agreed_fee, a.proposed_fee, a.scheduled_date, a.completion_date,
              b.name as branch_name, b.city as branch_city, b.state as branch_state, p.name as project_name
       FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       LEFT JOIN branches b ON b.id = pb.branch_id
       LEFT JOIN projects p ON p.id = pb.project_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       ORDER BY a.created_at DESC LIMIT 20`,
      [target.id],
    ).catch(() => []);
    (target as any).auditHistory = auditHistory;

    // 4. Attach active commercial profile
    const activeCommercial = await this.getActiveCommercialProfile(target.id, new Date()).catch(() => null);
    (target as any).activeCommercialProfile = activeCommercial;

    // 5. Does this person need to fix where they are on the map? True when there is no fix, or
    // the fix is coarser than a pincode (~3 km) — a district or state centroid, usually because
    // their recorded state and pincode disagree. A manual pin (they confirmed it, or ops did)
    // is never flagged. The app reads this to decide whether to prompt them on sign-in.
    (target as any).locationNeedsConfirmation =
      (target as any).geoSource !== 'manual'
      && (target.latitude == null
        || (target as any).geoSource == null
        || Number((target as any).geoAccuracyMeters ?? 0) > 3000);

    return target;
  }

  /**
   * The two facts about a candidate that only exist as a "current moment" snapshot, not a
   * lifetime stat: how full their diary is right now, and whether anything is currently flagged
   * against them. Split out of `getProfile` (which the mobile app also calls, for its own
   * signed-in user) rather than added to it, so a heavier, staff-only read never rides the
   * self-service profile the field app polls.
   *
   * `activeCount`/`maxWeeklyCapacity` mirror `WorkloadScoreCalculator.calculate` exactly (same
   * statuses, same capacity fallback) — this must read as the same number that decided the
   * candidate's "Spare capacity" score, not a second, differently-defined workload figure.
   */
  async getPlanningSnapshot(assayerId: string): Promise<{
    workload: { activeCount: number; maxWeeklyCapacity: number; remaining: number };
    riskFlags: Array<{ reason: string; rawValue: string; createdAt: string }>;
  }> {
    // The two queries below are correlated on `assayerId`, so this load is the only gate on them:
    // if it refuses, neither the workload figure nor the import-issue risk flags are ever read.
    const assayer = await this.assayerRepository.findOne({ where: tenantWhere<AssayerEntity>({ id: assayerId }) });
    if (!assayer) throw new NotFoundException(`Assayer ${assayerId} not found.`);

    const mgr = this.assayerRepository.manager;
    const [activeCount, riskFlagRows] = await Promise.all([
      mgr.count('assignments', { where: { assayerId, status: In(COMMITTED_ASSIGNMENT_STATUSES), isActive: true } }),
      mgr.query(
        `SELECT reason, raw_value, created_at FROM assayer_import_issues
         WHERE assayer_id = $1 AND source_sheet = $2 AND resolved_at IS NULL
         ORDER BY created_at DESC LIMIT 10`,
        [assayerId, DATA_INTEGRITY_SHEET],
      ).catch(() => []),
    ]);
    const maxWeeklyCapacity = assayer.maxWeeklyWorkload || DEFAULT_WEEKLY_CAPACITY;

    return {
      workload: { activeCount, maxWeeklyCapacity, remaining: Math.max(0, maxWeeklyCapacity - activeCount) },
      riskFlags: (riskFlagRows as any[]).map((r) => ({ reason: r.reason, rawValue: r.raw_value, createdAt: r.created_at })),
    };
  }

  // ---- Activity Timeline ----

  // Public because it is the ONE writer of assayer_activities — QualificationScoreService
  // records score overrides through it rather than growing a second writer with its own idea
  // of the row shape.
  async recordActivity(assayerId: string, eventType: string, previousState: string | null, newState: string | null, userId: string, remarks: string | null, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(AssayerActivityEntity) : this.activityRepository;
    const activity = repo.create({
      assayerId,
      eventType,
      previousState,
      newState,
      performedBy: userId,
      performedByName: null,
      remarks,
      createdBy: userId,
      updatedBy: userId,
    });
    await repo.save(activity);
  }

  async getActivityTimeline(assayerId: string, page = 1, limit = 20): Promise<{ activities: AssayerActivityEntity[]; total: number }> {
    // The timeline is the record of everything that has ever been done to this person — every
    // lifecycle move, every reason given, every operator who touched them. `assayer_activities`
    // has no organisation of its own, so the gate is on the parent.
    await this.assertAssayerInTenant(assayerId, `Assayer ${assayerId} not found.`);
    const [activities, total] = await this.activityRepository.findAndCount({
      where: { assayerId },
      order: { occurredAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { activities: await this.withActorNames(activities), total };
  }

  /**
   * Fills in `performedByName`, which is written as null at event time — the audit
   * trail stored only an actor UUID, so every history view rendered "system" no
   * matter who actually made the change. Resolved on read so existing rows gain
   * names too. An actor is a staff user, or an assayer acting on their own record.
   */
  private async withActorNames(activities: AssayerActivityEntity[]): Promise<AssayerActivityEntity[]> {
    const ids = [...new Set(activities.map((a) => a.performedBy).filter(Boolean))] as string[];
    if (ids.length === 0) return activities;

    const names = new Map<string, string>();
    const rows = await this.activityRepository.manager.query(
      `SELECT id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), username) AS name
         FROM users WHERE id = ANY($1)
       UNION ALL
       SELECT id, display_name AS name FROM assayers WHERE id = ANY($1)`,
      [ids],
    );
    for (const r of rows) names.set(r.id, r.name);

    return activities.map((a) => {
      if (!a.performedByName && a.performedBy && names.has(a.performedBy)) {
        a.performedByName = names.get(a.performedBy)!;
      }
      return a;
    });
  }

  // ---- Commercial Profiles ----

  /**
   * A new rate card closes the one it replaces.
   *
   * Nothing used to end the previous row, so two open-ended profiles could both be "in force"
   * and the winner was whichever the reader's ORDER BY happened to pick — the fee quoted, the
   * fee booked and the fee paid could differ for the same audit. The new row's start is the old
   * row's end: rates change on a date, and both sides of that date have exactly one answer.
   *
   * The database enforces this too (an EXCLUDE constraint over the active period, migration
   * 1793400000000) — this is the half that keeps the constraint from ever firing in normal use.
   */
  async createCommercialProfile(assayerId: string, dto: any, userId: string): Promise<AssayerCommercialProfileEntity> {
    await this.findOne(assayerId);
    const startDate = new Date(dto.effectiveStartDate);

    const open = await this.commercialRepository.find({
      where: { assayerId, isActive: true },
    });
    // Everything already running on the day the new card starts — an open-ended row, or one
    // whose end falls on or after that day.
    const superseded = open.filter((p) => {
      const s = new Date(p.effectiveStartDate).getTime();
      const e = p.effectiveEndDate ? new Date(p.effectiveEndDate).getTime() : Infinity;
      return s <= startDate.getTime() && e >= startDate.getTime();
    });
    for (const old of superseded) {
      // Ends the day before the new one starts, so the two never both cover a day.
      const endsAt = new Date(startDate.getTime() - 86_400_000);
      old.effectiveEndDate = endsAt < old.effectiveStartDate ? old.effectiveStartDate : endsAt;
      old.updatedBy = userId;
      await this.commercialRepository.save(old);
    }

    const profile = this.commercialRepository.create({
      ...dto,
      assayerId,
      effectiveStartDate: startDate,
      effectiveEndDate: dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.commercialRepository.save(profile) as unknown as AssayerCommercialProfileEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_COMMERCIAL_PROFILE_CREATED',
      entityType: 'ASSAYER_COMMERCIAL_PROFILE',
      entityId: saved.id,
      userId,
      remarks: `Created commercial profile for assayer ${assayerId} with base fee ₹${dto.baseFee}`,
    });
    await this.recordActivity(assayerId, 'ASSAYER_COMMERCIAL_PROFILE_CREATED', null, null, userId, `Commercial profile created with base fee ₹${dto.baseFee}`);
    return saved;
  }

  async updateCommercialProfile(profileId: string, dto: any, userId: string): Promise<AssayerCommercialProfileEntity> {
    const profile = await this.commercialRepository.findOne({ where: { id: profileId, isActive: true } });
    if (!profile) throw new NotFoundException(`Commercial profile ${profileId} not found.`);
    // `PUT /assayers/commercial/:id` is keyed on the rate card, not the person, so it takes no
    // `@GlobalScopeFilter` and calls no guard — the only route in the commercial group that does
    // neither. Its sibling `POST /assayers/:assayerId/commercial` is covered by `findOne`; this
    // one has to resolve the owner from the row it just loaded. Pay terms are the thing being
    // written, so an unscoped id here rewrites what another organisation owes its workforce.
    await this.assertAssayerInTenant(profile.assayerId, `Commercial profile ${profileId} not found.`);
    if (dto.baseFee !== undefined) profile.baseFee = dto.baseFee;
    if (dto.hourlyRate !== undefined) profile.hourlyRate = dto.hourlyRate;
    if (dto.dailyRate !== undefined) profile.dailyRate = dto.dailyRate;
    if (dto.travelReimbursement !== undefined) profile.travelReimbursement = dto.travelReimbursement;
    if (dto.accommodationAllowance !== undefined) profile.accommodationAllowance = dto.accommodationAllowance;
    if (dto.mealAllowance !== undefined) profile.mealAllowance = dto.mealAllowance;
    if (dto.currency !== undefined) profile.currency = dto.currency;
    if (dto.effectiveStartDate !== undefined) profile.effectiveStartDate = new Date(dto.effectiveStartDate);
    if (dto.effectiveEndDate !== undefined) profile.effectiveEndDate = dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null;
    profile.updatedBy = userId;
    const saved = await this.commercialRepository.save(profile) as unknown as AssayerCommercialProfileEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_COMMERCIAL_PROFILE_UPDATED',
      entityType: 'ASSAYER_COMMERCIAL_PROFILE',
      entityId: saved.id,
      userId,
      remarks: `Updated commercial profile ${profileId}`,
    });
    await this.recordActivity(profile.assayerId, 'ASSAYER_COMMERCIAL_PROFILE_UPDATED', null, null, userId, `Commercial profile updated`);
    return saved;
  }

  async getCommercialProfiles(assayerId: string): Promise<AssayerCommercialProfileEntity[]> {
    await this.assertAssayerInTenant(assayerId, `Assayer ${assayerId} not found.`);
    return this.commercialRepository.find({
      where: { assayerId, isActive: true },
      order: { effectiveStartDate: 'DESC' },
    });
  }

  async getActiveCommercialProfile(assayerId: string, date: Date = new Date()): Promise<AssayerCommercialProfileEntity | null> {
    await this.assertAssayerInTenant(assayerId, `Assayer ${assayerId} not found.`);
    const profiles = await this.commercialRepository.find({
      where: { assayerId, isActive: true, effectiveStartDate: LessThanOrEqual(date) },
      order: { effectiveStartDate: 'DESC' },
    });
    for (const p of profiles) {
      if (!p.effectiveEndDate || p.effectiveEndDate >= date) return p;
    }
    return null;
  }

  /**
   * Every assayer's commercial terms as they stand today, in one query.
   *
   * The pay screen needs the whole roster's rate card at once — to compare terms, and to see
   * who has no active profile and therefore falls back to the client's default fee. Loading it
   * one assayer at a time (the only route that existed) is 26+ round trips for one table.
   *
   * "As they stand today" uses the same rule the fee calculator and the recommendation scorers
   * use: the profile effective on the date, newest start winning. A profile dated in the future
   * is not yet in force and is reported as such rather than as the current rate.
   */
  async getRosterCommercialProfiles(onDate: Date = new Date()):
    Promise<Array<{ assayerId: string; profile: AssayerCommercialProfileEntity | null; hasFutureProfile: boolean }>> {
    // `GET /assayers/commercial/roster` takes no scope filter of any kind — it is the whole rate
    // card in one call, which is exactly why it needs the predicate here rather than at the route.
    // The profiles are then matched by id against this list, so narrowing the roster narrows the
    // payload: a profile belonging to another organisation has no assayer to attach to and is
    // dropped, without a second predicate on a table that has no `organization_id` to filter on.
    const assayers = await this.assayerRepository.find({
      where: tenantWhere<AssayerEntity>({ isActive: true }),
      select: { id: true },
    });
    const all = await this.commercialRepository.find({
      where: { isActive: true },
      order: { effectiveStartDate: 'DESC' },
    });

    const byAssayer = new Map<string, AssayerCommercialProfileEntity[]>();
    for (const p of all) {
      (byAssayer.get(p.assayerId) ?? byAssayer.set(p.assayerId, []).get(p.assayerId)!).push(p);
    }

    return assayers.map((a) => {
      const rows = byAssayer.get(a.id) ?? [];
      const inForce = rows.find((p) => p.effectiveStartDate <= onDate && (!p.effectiveEndDate || p.effectiveEndDate >= onDate)) ?? null;
      const hasFutureProfile = rows.some((p) => p.effectiveStartDate > onDate);
      return { assayerId: a.id, profile: inForce, hasFutureProfile };
    });
  }

  // ---- Workforce Attributes ----

  /**
   * Refuse a skill, language, certification or specialisation the person already holds.
   *
   * Adding the same one twice created two rows. Beyond reading as a mistake on screen, removing
   * it then took the person only halfway: one row went, the other stayed, so an assayer whose
   * skill HR had just deleted still satisfied a SKILL rule and still appeared as a candidate.
   * Matching is case-insensitive because "Gold Assaying" and "gold assaying" are the same skill.
   */
  async addWorkforceAttribute(assayerId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity> {
    await this.findOne(assayerId);

    const existing = await this.workforceAttributeRepository.findOne({
      where: { assayerId, type: dto.type, name: ILike(String(dto.name ?? '').trim()), isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        `This assayer already has the ${String(dto.type).toLowerCase()} “${existing.name}”.`,
      );
    }

    const attr = this.workforceAttributeRepository.create({
      ...dto,
      assayerId,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.workforceAttributeRepository.save(attr) as unknown as WorkforceAttributeEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_CREATED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: saved.id,
      userId,
      remarks: `Added ${dto.type} '${dto.name}' to assayer ${assayerId}`,
    });
    await this.recordActivity(assayerId, 'WORKFORCE_ATTRIBUTE_CREATED', null, null, userId, `Added ${dto.type} '${dto.name}'`);
    return saved;
  }

  async updateWorkforceAttribute(attributeId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity> {
    const attr = await this.workforceAttributeRepository.findOne({ where: { id: attributeId, isActive: true } });
    if (!attr) throw new NotFoundException(`Workforce attribute ${attributeId} not found.`);
    // `PUT /assayers/workforce-attribute/:id` names the attribute, never the person — so nothing
    // upstream has had an assayer id to check, and the region guard the sibling routes call was
    // never even reachable here. The owner has to be resolved from the row before it can be
    // written to. Same message as the miss above: a caller must not be able to tell "no such
    // attribute" from "somebody else's attribute".
    await this.assertAssayerInTenant(attr.assayerId, `Workforce attribute ${attributeId} not found.`);
    if (dto.name !== undefined) attr.name = dto.name;
    if (dto.level !== undefined) attr.level = dto.level;
    if (dto.expiryDate !== undefined) attr.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
    if (dto.metadata !== undefined) attr.metadata = dto.metadata;
    attr.updatedBy = userId;
    const saved = await this.workforceAttributeRepository.save(attr) as unknown as WorkforceAttributeEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_UPDATED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: saved.id,
      userId,
      remarks: `Updated workforce attribute ${attributeId}`,
    });
    await this.recordActivity(attr.assayerId, 'WORKFORCE_ATTRIBUTE_UPDATED', null, null, userId, `Updated workforce attribute '${attr.name}'`);
    return saved;
  }

  async removeWorkforceAttribute(attributeId: string, userId: string): Promise<void> {
    const attr = await this.workforceAttributeRepository.findOne({ where: { id: attributeId, isActive: true } });
    if (!attr) throw new NotFoundException(`Workforce attribute ${attributeId} not found.`);
    // Keyed by the attribute, like `updateWorkforceAttribute` — see the note there.
    await this.assertAssayerInTenant(attr.assayerId, `Workforce attribute ${attributeId} not found.`);
    attr.isActive = false;
    attr.updatedBy = userId;
    await this.workforceAttributeRepository.save(attr);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_REMOVED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: attributeId,
      userId,
      remarks: `Removed workforce attribute '${attr.name}' from assayer ${attr.assayerId}`,
    });
    await this.recordActivity(attr.assayerId, 'WORKFORCE_ATTRIBUTE_REMOVED', null, null, userId, `Removed workforce attribute '${attr.name}'`);
  }

  async getWorkforceAttributes(assayerId: string, type?: string): Promise<WorkforceAttributeEntity[]> {
    await this.assertAssayerInTenant(assayerId, `Assayer ${assayerId} not found.`);
    const where: any = { assayerId, isActive: true };
    if (type) where.type = type;
    return this.workforceAttributeRepository.find({ where, order: { type: 'ASC', name: 'ASC' } });
  }

  /**
   * Assayer intake template.
   *
   * Headers deliberately match the column names on the rosters actually received
   * ("Assayer code", "Assayer Name", "Residence Address", "Location", "Zone")
   * rather than an idealised internal shape, so a roster can be filled in and sent
   * back without being restructured. The importer accepts both spellings.
   *
   * Only the four fields the record genuinely cannot function without are
   * required. Everything else is optional and can be filled in later — a long
   * mandatory list is what pushes people back to editing the database by hand.
   */
  /**
   * The download-and-fill template for the FULL roster importer.
   *
   * Its columns are exactly the fields `RosterImportService.importAssayerSheet` reads, spelled
   * cleanly — the client's own roster carries typos ("Total Expierence", "Refference 1 Name",
   * "A/c Number", "Aadhar Card Number") that we do not want to teach people to reproduce. The
   * importer matches headers case/space/punctuation-insensitively and carries the clean spelling
   * as an alias for every one of these, so a file filled from this template imports with nothing
   * lost. `roster-template-truth.spec.ts` and `roster-import.spec.ts` are the guards that keep
   * the two in step: a column here the importer does not read would be silent data loss.
   *
   * Only `Appraiser code` is required — it is the single field the importer skips a row for.
   * `State`, `Appraiser Name` and `Zone` change nothing about whether a row imports but shape
   * almost everything useful about the record, so they are called out as strongly recommended.
   */
  async generateTemplate(): Promise<Buffer> {
    const DOCUMENT_NOTE =
      'Onboarding paperwork. Enter "Yes" if the soft copy has been received, "No" if it is still ' +
      'awaited, or leave blank if not known.';

    // Generated from the shared maps, not hand-typed, so the document columns can never drift from
    // the columns the importer actually reads. Only requirements that have a real column in the
    // roster are shipped — driving licence, voter ID and passport have none.
    const documentColumns = (Object.keys(ONBOARDING_DOCUMENT_COLUMNS) as OnboardingDocument[])
      .filter((doc) => ONBOARDING_DOCUMENT_COLUMNS[doc])
      .map((doc) => ({
        field: ONBOARDING_DOCUMENT_LABELS[doc],
        required: 'No' as const,
        description: DOCUMENT_NOTE,
      }));

    // Field / Required / Description for every column, in the order they appear on the sheet.
    // `headers` and the Instructions sheet are both derived from this one list, so they cannot
    // disagree about which columns exist.
    const columns: Array<{ field: string; required: 'Yes' | 'No'; description: string }> = [
      // ── Identity ──
      { field: 'Appraiser code', required: 'Yes', description: 'Unique code for this appraiser, e.g. AS0643. This is the ONLY must-fill column — a row with no code is skipped. Re-importing the same code updates that appraiser instead of adding a duplicate.' },
      { field: 'Appraiser Name', required: 'No', description: 'Full name in one cell, e.g. Shinil T. Strongly recommended — without it the record shows only the code. The last word is taken as the surname.' },
      { field: 'PAN Number', required: 'No', description: 'PAN, e.g. ABCDE1234F. Needed before any payment is released.' },
      { field: 'Aadhaar Card Number', required: 'No', description: '12-digit Aadhaar number.' },
      { field: 'Date of Birth', required: 'No', description: 'Date of birth. Day-first is fine — 03-01-1974 means 3 January 1974.' },
      { field: 'Qualification', required: 'No', description: 'Highest qualification, e.g. B.Com, Diploma in Gold Assaying.' },
      { field: 'VSTS Code', required: 'No', description: 'VSTS identifier, where the appraiser has one.' },
      // ── Contact & location ──
      { field: 'Phone Number 1', required: 'No', description: 'Ten-digit mobile number; more than one may be written in the cell, separated by a slash. The row is still accepted without a number, but the appraiser cannot be called or dispatched to until one is filled in.' },
      { field: 'Phone Number 2', required: 'No', description: 'A second contact number, if any.' },
      { field: 'Email ID', required: 'No', description: 'Email address, used for notifications where available.' },
      { field: 'Residence Address', required: 'No', description: 'Full home address. Used to work out travel distance to branches. A 6-digit pincode written inside this text is picked up automatically.' },
      { field: 'Location', required: 'No', description: 'Town or locality, e.g. Kunnamangalam. Stored as the city.' },
      { field: 'District', required: 'No', description: 'District. Used for travel distance and coverage planning.' },
      { field: 'State', required: 'No', description: 'Home state, e.g. Kerala. Strongly recommended — it sets the appraiser’s region, zone and public-holiday calendar; without it they drop out of every region-scoped view.' },
      { field: 'Zone', required: 'No', description: 'Operating zone: North, South, East, West, Central or North East. Strongly recommended — it decides the desk that can see and plan this appraiser. Casing is ignored, so "north" and "North" are one zone.' },
      // ── Banking ──
      { field: 'Bank Name', required: 'No', description: 'Bank the fees are paid into.' },
      { field: 'Account Number', required: 'No', description: 'Bank account number, needed to pay fees.' },
      { field: 'IFSC Code', required: 'No', description: 'Branch IFSC code, needed to pay fees.' },
      // ── Employment ──
      { field: 'Joining Date', required: 'No', description: 'Date the appraiser joined. Day-first dates are read correctly.' },
      { field: 'Exit Date', required: 'No', description: 'Date the appraiser left, if they have.' },
      { field: 'HR Name', required: 'No', description: 'HR person who owns this appraiser’s file.' },
      { field: 'Total Experience', required: 'No', description: 'Years of experience, e.g. 20 Years. The number feeds the match score.' },
      { field: 'Active / Inactive', required: 'No', description: 'Availability and how they are engaged, as written in the roster, e.g. "Active / Regular", "Inactive / Not Interested", "Active / Back up". Read into availability, reason and engagement type. Strongly recommended: left blank on a NEW appraiser, the import will not assume a status — the person is created as INVITED and listed for review — so a blank here is the most common reason a row that "followed the template" still needs reviewing.' },
      { field: 'Status', required: 'No', description: 'Employment outcome where there is one, e.g. Resigned, Terminated, Expired. Takes precedence over the availability column when deciding the final status.' },
      { field: 'Remarks', required: 'No', description: 'Any free-text note about this appraiser.' },
      // ── References ──
      { field: 'Reference 1 Name', required: 'No', description: 'Name of the first reference.' },
      { field: 'Reference 1 Contact', required: 'No', description: 'Contact number of the first reference.' },
      { field: 'Reference 2 Name', required: 'No', description: 'Name of the second reference.' },
      { field: 'Reference 2 Contact', required: 'No', description: 'Contact number of the second reference.' },
      // ── Onboarding documents (soft copy Yes/No) ──
      ...documentColumns,
      { field: 'NDA Hard Copy Status', required: 'No', description: 'The signed NDA original: whether the hard copy has been received and, where noted, which office holds it (e.g. Bangalore office).' },
      // ── Background & credit check ──
      { field: 'Background Verification Done', required: 'No', description: 'Outcome of the background check, e.g. Clear, Criminal Case, Civil Case. Only recognised outcomes are recorded; anything else is kept for a person to review.' },
      { field: 'CIBIL Status', required: 'No', description: 'Credit band from the CIBIL check: Good, Average, Poor, Bad, or No Credit History.' },
      { field: 'CIBIL Score', required: 'No', description: 'The numeric CIBIL score, e.g. 750.' },
      { field: 'CIBIL Date', required: 'No', description: 'Date the CIBIL check was done.' },
      // ── Client empanelment ──
      { field: 'ICICI Status', required: 'No', description: 'Where this appraiser stands with ICICI, e.g. Recommended, Not Recommended, Active, Rejected. Recorded against the ICICI client.' },
      { field: 'ICICI Documents Required', required: 'No', description: 'Which documents ICICI still needs before empanelment, if any.' },

      { field: 'Project Name', required: 'No', description: 'Every bank this appraiser works for, separated by slashes, e.g. "AXIS / AU FINANCE / IDFC". Each named bank becomes an active standing with that client; a bank not yet in the system is created automatically with minimal details (the import summary lists what to complete).' },
      { field: 'Link for Document', required: 'No', description: 'Link to the folder holding this appraiser\'s scanned documents (e.g. a Google Drive share). Shown on their profile.' },
      { field: 'Courier Date / Tracking number', required: 'No', description: 'Courier reference for the signed ethical-conduct letter on its way in, as written, e.g. "23-03-2026 / India Post / RX1234".' },
    ];

    const headers = columns.map((c) => c.field);
    const ws = xlsx.utils.json_to_sheet([], { header: headers });
    ws['!cols'] = headers.map((h) => ({ wch: h === 'Residence Address' ? 50 : Math.max(16, h.length + 4) }));

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Assayers');

    const instructions = columns.map((c) => ({ Field: c.field, Required: c.required, Description: c.description }));
    const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
    instrWs['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 100 }];
    xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');

    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  /**
   * `uploadFromExcel` was removed, with `POST /assayers/upload`.
   *
   * It was the second assayer importer and the losing one. Fed a real client roster — several
   * sheets, `Appraiser code`/`Appraiser Name` headers, 70-odd columns of HR, KYC, banking and
   * compliance — it scored the branch-audit sheet above the roster sheet, read the wrong sheet
   * entirely (an assayer code repeats per branch there), and called distinct people duplicates, so
   * most of the file never landed. `RosterImportService.importAssayerSheet` reads the roster sheet,
   * recognises the Appraiser headers, and spreads every column across the tables that hold them.
   *
   * Nothing called this: the web moved to `/assayers/roster/import` and the endpoint had no client
   * in either app. The two behaviours it *did* have that the roster importer lacked — finding the
   * roster whatever the sheet is called, and refusing a branch list as the wrong file — were moved
   * across first, together with their tests (see `roster-import.spec.ts`).
   */

  /**
   * Lets an assayer change their own password.
   *
   * Until now there was no route anywhere that wrote `assayers.password_hash` outside bulk
   * import, and that write is guarded by `if (!existing)`. `POST /users/me/change-password`
   * queries the `users` repository, and assayers have no `users` row, so it 404s for them.
   * The practical effect: a field worker could never change the password they were issued, so
   * every imported account sat on the importer's documented default with no route off it.
   *
   * This is also the precondition for rotating that default — without a way for people to set
   * a new password, rotating it just locks the whole field workforce out of their jobs.
   */
  async changeOwnPassword(assayerId: string, currentPassword: string, newPassword: string): Promise<void> {
    const assayer = await this.assayerRepository.findOne({
      where: { id: assayerId },
      select: { id: true, passwordHash: true },
    });
    if (!assayer) throw new NotFoundException('Assayer not found.');
    if (!assayer.passwordHash) {
      throw withCode(
        new BadRequestException('This account has no password set. Ask your HR contact to set one for you.'),
        AUTH_ERROR_CODES.NO_PASSWORD_SET,
      );
    }

    const ok = await bcrypt.compare(currentPassword, assayer.passwordHash);
    if (!ok) {
      throw withCode(
        new UnauthorizedException('Your current password is not correct.'),
        AUTH_ERROR_CODES.CURRENT_PASSWORD_WRONG,
      );
    }

    this.assertPasswordAcceptable(newPassword);

    await this.assayerRepository.update(assayerId, {
      passwordHash: await bcrypt.hash(newPassword, 12),
      // The holder has now chosen their own credential, so the forced-rotation flag clears.
      mustChangePassword: false,
      // And with it the temporary password's expiry. A date somebody else's credential was good
      // until has no meaning against one this person chose, and leaving it set would arm a
      // deadline over an account that no longer has anything expiring.
      tempPasswordExpiresAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedBy: assayerId,
    });

    // Deterministic, awaited invalidation of the cached RBAC principal, and revocation of every
    // other session — the assayer-mobile-principal equivalent of UserService.changePassword. See
    // the comments there: without this, a stolen/lingering refresh token would keep rotating for
    // the full refresh TTL after the password that was supposed to kill it changed.
    await this.cache.del(rbacPrincipalCacheKey(assayerId));
    this.eventPublisher.publish('user:password-changed', { userId: assayerId });

    /**
     * Credential changes are audited.
     *
     * Neither this method nor resetPasswordByStaff recorded anything, while the equivalent
     * user paths emit USER_PASSWORD_CHANGED / USER_PASSWORD_RESET. On a system whose output
     * is legal audit evidence, a credential change with no trail cannot be investigated at
     * all — found while trying to establish who had changed an assayer's password and
     * discovering the answer was unrecoverable.
     */
    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'ASSAYER_PASSWORD_CHANGED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: assayerId,
      remarks: 'Assayer changed their own password.',
    });

    await this.recordActivity(assayerId, 'ASSAYER_PASSWORD_CHANGED', null, null, assayerId, 'Password changed by the assayer');
  }

  /**
   * Hand back one sensitive identifier in clear, and record that it happened.
   *
   * The reads are masked, so this is the single route by which a PAN, an Aadhaar number or a
   * bank account leaves the system whole — which is the point: one place to watch, one row in
   * `audit_events` per look, naming who looked at which field of whose record and when.
   *
   * Two decisions worth stating.
   *
   * The audit write is `recordEvent`, not `recordEventSafe`, and it is awaited BEFORE the value
   * is returned. Everywhere else in this service the reasoning runs the other way — a completed
   * state change must not be undone because its trail entry failed. Here there is no state
   * change to protect, and an unrecorded reveal is precisely the event this endpoint exists to
   * prevent, so a failed audit must fail the reveal.
   *
   * The lookup does not filter on `isActive`. A departed assayer still has a final settlement to
   * pay, and the bank account it is paid into is on a row this system marks inactive the moment
   * they leave; refusing to show it would leave finance reading it out of the spreadsheet the
   * encryption was meant to replace. The audit row is what makes that safe.
   */
  async revealSensitiveField(
    assayerId: string,
    field: string,
    actor: { id: string; displayName?: string | null; ipAddress?: string | null },
  ): Promise<{ value: string }> {
    // Named fields only, and an unknown one is the caller's mistake rather than ours. Reaching
    // straight into the entity with whatever string arrived would 500 on a bad segment, and a
    // 500 that only happens for some segments tells an attacker which columns exist.
    if (!Object.prototype.hasOwnProperty.call(SENSITIVE_ASSAYER_FIELDS, field)) {
      throw new BadRequestException(
        `"${field}" is not a field that can be revealed. Ask for one of: ${SENSITIVE_FIELD_NAMES.join(', ')}.`,
      );
    }
    const name = field as SensitiveAssayerField;
    const property = SENSITIVE_ASSAYER_FIELDS[name];

    // Through the repository, so the `encryptedColumn` transformer decrypts on read — a raw
    // query here would hand back the `enc:v1:` ciphertext and look like it had worked.
    //
    // Scoped, because this is the sharpest edge of F-03 and the one that was demonstrated: an
    // OPERATIONS user in one organisation called `GET /assayers/<other-org-id>/sensitive/bank` and
    // got another tenant's bank account number back in cleartext, decrypted for them by this very
    // transformer. Note the ordering — the load fails first, so no `ASSAYER_SENSITIVE_FIELD_REVEALED`
    // audit row is written for a reveal that did not happen. `audit_events` is append-only, so a
    // row written here on the way to a refusal could never be retracted, and a compliance report
    // that shows a bank reveal against a record the actor could not read is worse than no row.
    const assayer = await this.assayerRepository.findOne({
      where: tenantWhere<AssayerEntity>({ id: assayerId }),
      select: { id: true, assayerCode: true, displayName: true, [property]: true } as any,
    });
    if (!assayer) throw new NotFoundException('Assayer not found.');

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'ASSAYER_SENSITIVE_FIELD_REVEALED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actor.id,
      userDisplayName: actor.displayName ?? undefined,
      ipAddress: actor.ipAddress ?? undefined,
      remarks:
        `Revealed the ${SENSITIVE_FIELD_LABELS[name]} of ${assayer.displayName ?? assayer.assayerCode ?? assayerId}.`,
      // The field name, never the value. An audit trail that quotes what it was protecting is a
      // second copy of it, in a table more people can read than the one it came from.
      metadata: { field: name, property, assayerCode: assayer.assayerCode ?? null },
    });

    // Empty string, not null, for "nothing on file": the caller asked to see a value and the
    // answer is that there isn't one, which is a successful read of an empty field.
    return { value: (assayer as any)[property] ?? '' };
  }

  /**
   * How long HR should tell an assayer the temporary password is good for.
   *
   * Seven days is the window a phone-first handover actually needs: HR issues access while the
   * person is in front of them or on the call, and a field worker who is mid-assignment may not
   * install the app until the weekend.
   *
   * This is enforced. It was not at first — the date was computed for display only, with no
   * column to hold it, so the response told HR a credential expired while nothing at sign-in ever
   * compared against it. `assayers.temp_password_expires_at` now carries it and
   * `AuthService.login` refuses a password past it, but only while `mustChangePassword` is still
   * true: once the assayer chooses their own password the expiry is cleared, so this can never
   * shut somebody out of a credential they picked themselves.
   */
  private static readonly APP_ACCESS_VALID_DAYS = 7;

  /** The moment a temporary password issued right now stops working. */
  private static tempPasswordExpiry(): Date {
    return new Date(Date.now() + AssayerService.APP_ACCESS_VALID_DAYS * 24 * 60 * 60 * 1000);
  }

  /**
   * Issue app access to an assayer as a one-time invitation.
   *
   * The existing route out of this is `resetPasswordByStaff` — a *reset*, which is the recovery
   * path for somebody locked out and reads that way on screen. There was no way to say "this
   * person is joining, give them the app", so first-time access was being handed out as a
   * password reset for a password that had never existed, and `INVITED` was a lifecycle label
   * nothing ever sent.
   *
   * The word-based generator is kept deliberately: these are field workers reading a credential
   * off a phone call in bad light, and "tiger-mango-river-stone4" survives that trip where a hex
   * blob does not. `mustChangePassword` is set, so the words are spent at first sign-in.
   *
   * ## Issuing access does not make anyone assignable, and is not gated on activation
   *
   * The credential works from onboarding: `maySignIn` admits the four onboarding stages as well
   * as ACTIVE and ON_LEAVE (`ONBOARDING_SIGN_IN` in auth.service.ts), into a session
   * `JwtAuthGuard` confines to finishing that person's own registration — which is what the two
   * fields returned below have to tell HR apart. Signing in is still not being on duty:
   * deployability is `isActive && status === ACTIVE`, so nothing issued here puts anybody in
   * front of a planner.
   *
   * Issuing before activation is deliberate — the handover happens when the person is present,
   * which is usually during onboarding, not on the day activation is clicked. The reverse is the
   * rule that matters more: activation must NEVER require app access to have been issued. Not
   * every appraiser has a smartphone, and making the invitation a precondition would quietly bar
   * the phone-only half of the workforce from being activated at all.
   */
  async issueAppAccess(
    assayerId: string,
    actorId: string,
  ): Promise<{ username: string; temporaryPassword: string; expiresAt: string; canSignInNow: boolean; accessScope: 'FULL' | 'REGISTRATION_ONLY' }> {
    // Scoped here rather than in `issueAppAccessCore`, which takes an already-loaded entity and is
    // also driven by `bulkIssueAppAccess` — the two entry points load separately, so each one
    // carries its own predicate. Issuing app access mints a credential and speaks a temporary
    // password back to the caller, so an unscoped id here is account takeover of another tenant's
    // field worker, not merely a read.
    const assayer = await this.assayerRepository.findOne({
      where: tenantWhere<AssayerEntity>({ id: assayerId }),
      select: { id: true, assayerCode: true, displayName: true, phone: true, email: true, lifecycleStatus: true },
    });
    if (!assayer) throw new NotFoundException('Assayer not found.');

    return this.issueAppAccessCore(assayer, actorId);
  }

  /**
   * The password generation, hashing, storage, cache invalidation, event and audit trail that
   * `issueAppAccess` used to do inline.
   *
   * Pulled out so `bulkIssueAppAccess` can drive the exact same behaviour per person instead of
   * a second, inevitably-drifting copy of it — HR was doing 540 people one at a time from
   * `AssayerRecord.tsx` purely because this logic had only ever been wired to a single-id route.
   * The public method above still does its own lookup and 404, since a bulk caller has already
   * fetched (and needs to keep) the row to decide whether to call this at all.
   */
  private async issueAppAccessCore(
    assayer: Pick<AssayerEntity, 'id' | 'assayerCode' | 'displayName' | 'phone' | 'email' | 'lifecycleStatus'>,
    actorId: string,
  ): Promise<{ username: string; temporaryPassword: string; expiresAt: string; canSignInNow: boolean; accessScope: 'FULL' | 'REGISTRATION_ONLY' }> {
    const assayerId = assayer.id;
    const password = this.generateTemporaryPassword();
    this.assertPasswordAcceptable(password);

    await this.assayerRepository.update(assayerId, {
      passwordHash: await bcrypt.hash(password, 12),
      // Whatever they held before is now void — issuing access replaces a credential, it does not
      // add a second one, and a re-issue is usually a response to the first one going astray.
      mustChangePassword: true,
      // Stored, not merely computed for the card. The date below used to be display-only, so the
      // response told HR a credential expired while nothing ever compared against it.
      tempPasswordExpiresAt: AssayerService.tempPasswordExpiry(),
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedBy: actorId,
    });

    // Same reasoning as resetPasswordByStaff: the cached RBAC principal and every live session
    // built on the old credential have to go, or a re-issue leaves the previous holder signed in.
    await this.cache.del(rbacPrincipalCacheKey(assayerId));
    this.eventPublisher.publish('user:password-changed', { userId: assayerId });

    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ASSAYER_APP_ACCESS_ISSUED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actorId,
      remarks:
        `App access issued to ${assayer.displayName ?? assayer.assayerCode ?? assayerId}. `
        + 'They must choose their own password at first sign-in.',
      // Never the password, generated or otherwise — see the note on the reveal audit above.
      metadata: {
        assayerCode: assayer.assayerCode ?? null,
        lifecycleStatus: assayer.lifecycleStatus ?? null,
      },
    });

    await this.recordActivity(
      assayerId, 'ASSAYER_APP_ACCESS_ISSUED', null, null, actorId, 'App access issued by staff',
    );

    // Recomputed rather than read back: a second call to `tempPasswordExpiry()` lands a few
    // milliseconds after the stored one, which is immaterial against a seven-day window and
    // avoids a re-select purely to echo a value this method just wrote.
    const expiry = AssayerService.tempPasswordExpiry();


    return {
      // The assayer code, because it is the one identifier every roster row has: phone is
      // optional on admission and email more so. Sign-in accepts any of the three.
      username: assayer.assayerCode,
      temporaryPassword: password,
      expiresAt: expiry.toISOString(),
      /**
       * Whether the credential works at all, and how far it goes — two different questions, so
       * two fields.
       *
       * This was one field meaning "fully usable", and it returned false for somebody mid-
       * onboarding because those stages could not sign in. They can now, into a session confined
       * to finishing their own registration, so a single false would state the opposite of what
       * happens: HR would read "they cannot sign in yet" onto a card whose password works.
       *
       * `accessScope` is what the card should actually say out loud. REGISTRATION_ONLY means they
       * can upload their papers and nothing else until their joining checks are signed off.
       */
      canSignInNow: maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus),
      accessScope: isOnboardingStage(assayer.lifecycleStatus) ? 'REGISTRATION_ONLY' : 'FULL',
    };
  }

  /**
   * Issue app access to a batch of assayers in one operation, delivered by email and SMS
   * instead of read off a screen one person at a time.
   *
   * 540 of 548 active assayers were imported with a lifecycle record and no password at all,
   * and the only way to give one out was `issueAppAccess` above from `AssayerRecord.tsx` —
   * built for HR handing a card to one person on a call, not for clearing a backlog that size.
   * This drives the exact same `issueAppAccessCore` per person (nothing about how a credential
   * is generated, hashed, stored or audited changes for a bulk run) and then tries to hand it to
   * the person itself, since there is no HR officer reading it aloud on the other end.
   *
   * Shaped like `bulkTransitionLifecycle`: a plain loop, one id's failure caught and recorded
   * without aborting the rest, and a `{ succeeded, skipped, failed }` summary instead of a
   * thrown error for anything short of the whole request being malformed.
   *
   * The temporary password exists in memory only for the two delivery calls below. It is never
   * put into `succeeded`/`skipped`/`failed`, never interpolated into a log line, and never added
   * to the per-person audit metadata that `issueAppAccessCore` already writes — the entire point
   * of a bulk tool handling 540 credentials unattended is that nothing durable holds them in the
   * clear.
   */
  async bulkIssueAppAccess(
    ids: string[],
    actorId: string,
  ): Promise<{
    succeeded: { id: string; channels: ('EMAIL' | 'SMS')[] }[];
    skipped: { id: string; reason: string }[];
    failed: { id: string; reason: string }[];
  }> {
    // Same ceiling `BatchResolveImportIssuesDto` puts on closing import issues: a batch this
    // size already asks for 500 sequential bcrypt hashes plus up to 1000 delivery calls inside
    // one request, which is as far as a plain loop like this should be pushed before it needs
    // to become a background job instead.
    if (ids.length > 500) {
      throw new BadRequestException('Issue app access to at most 500 assayers at a time.');
    }

    const succeeded: { id: string; channels: ('EMAIL' | 'SMS')[] }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        const assayer = await this.findOne(id);
        if (!assayer.email && !assayer.phone) {
          skipped.push({ id, reason: 'No email or phone on file to deliver a credential to.' });
          continue;
        }

        const issued = await this.issueAppAccessCore(assayer, actorId);
        const channels: ('EMAIL' | 'SMS')[] = [];

        // Built once and handed to both channels — reused, not logged, and gone once this
        // iteration ends.
        const message =
          `Your FAPOMS sign-in is ${issued.username} and your temporary password is ` +
          `${issued.temporaryPassword}. It works for 7 days and you will be asked to choose ` +
          'your own password the first time you sign in.';

        if (assayer.email) {
          const emailResult = await this.emailProvider.send({
            to: assayer.email,
            subject: 'Your FAPOMS app access',
            text: message,
          });
          if (emailResult.success) channels.push('EMAIL');
        }
        if (assayer.phone) {
          const smsSent = await this.smsProvider.send(assayer.phone, message);
          if (smsSent) channels.push('SMS');
        }

        // A person with neither channel reporting success is not moved to `failed`: the
        // credential is live either way (issueAppAccessCore already committed it, and already
        // wrote its own audit row), and `channels: []` is how HR sees that nothing actually
        // reached this person and a manual follow-up is needed.
        succeeded.push({ id, channels });
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }

    // One row for the whole run, counts only — the run-level record of who triggered a batch
    // of how many, same shape as ROSTER_IMPORT_APPLIED. The per-person ASSAYER_APP_ACCESS_ISSUED
    // rows already exist, written by issueAppAccessCore inside the loop above.
    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'BULK_APP_ACCESS_ISSUED',
      entityType: 'ASSAYER',
      entityId: 'bulk',
      userId: actorId,
      remarks:
        `Bulk app-access issuance: ${succeeded.length} issued, ${skipped.length} skipped, `
        + `${failed.length} failed.`,
      metadata: {
        requested: ids.length,
        succeeded: succeeded.length,
        skipped: skipped.length,
        failed: failed.length,
        emailed: succeeded.filter((s) => s.channels.includes('EMAIL')).length,
        texted: succeeded.filter((s) => s.channels.includes('SMS')).length,
      },
    });

    return { succeeded, skipped, failed };
  }

  /** HR/admin resets an assayer's password — the only recovery path for someone locked out. */
  async resetPasswordByStaff(
    assayerId: string,
    newPassword: string | undefined,
    actorId: string,
  ): Promise<{ generatedPassword?: string }> {
    // Same reasoning as `issueAppAccess`: the recovery path is a credential-issuing path, and the
    // `update` below is keyed on `assayerId` with no predicate of its own, so this load is what
    // stands between a foreign id and another organisation's password hash being replaced.
    const assayer = await this.assayerRepository.findOne({
      where: tenantWhere<AssayerEntity>({ id: assayerId }),
      select: { id: true },
    });
    if (!assayer) throw new NotFoundException('Assayer not found.');

    // When HR does not supply one, generate a readable temporary password and return it once.
    // The point of the reset is a locked-out field worker on the phone, so the credential has to
    // be sayable — hence a short memorable form rather than a random hex blob — and it is never
    // stored in readable form, only its hash.
    const wasGenerated = !newPassword;
    const password = newPassword ?? this.generateTemporaryPassword();

    this.assertPasswordAcceptable(password);

    await this.assayerRepository.update(assayerId, {
      passwordHash: await bcrypt.hash(password, 12),
      failedLoginAttempts: 0,
      lockedUntil: null,
      // A password chosen by HR is a temporary credential, not the assayer's own. Forcing a
      // change at next sign-in keeps a staff-known password from becoming the permanent one.
      mustChangePassword: true,
      // And it expires on the same clock as an issued invite: both are a credential somebody
      // else chose and spoke aloud, so there is no reason one should outlive the other.
      tempPasswordExpiresAt: AssayerService.tempPasswordExpiry(),
      updatedBy: actorId,
    });

    // Same reasoning as changeOwnPassword: an HR-initiated reset is, in practice, always a
    // response to "this assayer is locked out or their credential may be compromised" — ending
    // every existing session is the point of it, not a side effect.
    await this.cache.del(rbacPrincipalCacheKey(assayerId));
    this.eventPublisher.publish('user:password-changed', { userId: assayerId });

    // Who reset whose credential, and when — see the note in changeOwnPassword.
    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ASSAYER_PASSWORD_RESET',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actorId,
      remarks: 'Password reset by staff. The assayer must choose a new one at next sign-in.',
    });

    await this.recordActivity(assayerId, 'ASSAYER_PASSWORD_RESET', null, null, actorId, 'Password reset by staff');

    return wasGenerated ? { generatedPassword: password } : {};
  }

  /**
   * A short, sayable temporary password: four distinct lowercase words from the 2048-word
   * BIP-39 English wordlist (see temp-password-words.ts), hyphen-joined with a trailing digit,
   * e.g. "tiger-mango-river-stone4". Drawing 4 of 2048 without repeats gives roughly
   * 2048 x 2047 x 2046 x 2045 ~= 1.75e13 (~2^44) possible passwords — far beyond any
   * brute-force budget the account lockout allows — while staying readable aloud once and
   * typeable with one thumb. Not meant to be kept — mustChangePassword forces a change at
   * first sign-in.
   */
  private generateTemporaryPassword(): string {
    // randomInt is a CSPRNG; Math.random must never mint a credential.
    const chosen = new Set<string>();
    while (chosen.size < 4) {
      chosen.add(TEMP_PASSWORD_WORDS[randomInt(TEMP_PASSWORD_WORDS.length)]);
    }
    return `${[...chosen].join('-')}${randomInt(10)}`;
  }

  /**
   * Deliberately modest rules. These users are field workers on cheap handsets, often typing
   * with one thumb in bad light — a complexity policy they cannot satisfy produces written-down
   * passwords, which is worse than a simple one they can remember. What it does refuse is the
   * shared defaults, because those are known to anyone holding the roster spreadsheet.
   */
  private assertPasswordAcceptable(password: string): void {
    const pw = (password ?? '').trim();
    if (pw.length < 8) {
      throw withCode(
        new BadRequestException('Please choose a password of at least 8 characters.'),
        AUTH_ERROR_CODES.PASSWORD_TOO_SHORT,
      );
    }
    const BANNED = ['assayer123', 'password@123', 'password', '12345678'];
    if (BANNED.includes(pw.toLowerCase())) {
      throw withCode(
        new BadRequestException('That password is too easy to guess. Please choose a different one.'),
        AUTH_ERROR_CODES.PASSWORD_TOO_WEAK,
      );
    }
  }

  /**
   * Frozen payable disbursement destination snapshots for an assayer.
   */
  async getPayables(assayerId: string): Promise<any[]> {
    /**
     * Gated on the parent rather than filtered in the SQL, because `assayer_payables` carries no
     * `organization_id` and the columns this returns are the reason it matters: the destination
     * bank name, IFSC, account number and account-holder name of every payout ever made to this
     * person. That is the same disclosure `revealSensitiveField` exists to control, reached by a
     * route that had no ownership check at all.
     */
    await this.assertAssayerInTenant(assayerId, `Assayer ${assayerId} not found.`);
    return this.dataSource.query(
      `SELECT id, payable_number as "payableNumber", status, total_amount as "amount",
              currency, approved_at as "approvedAt",
              destination_bank_name as "destinationBankName",
              destination_ifsc as "destinationIfsc",
              destination_bank_account_number as "destinationBankAccountNumber",
              destination_account_holder_name as "destinationAccountHolderName",
              payout_evidence_version_id as "payoutEvidenceVersionId",
              destination_verified_at as "destinationVerifiedAt",
              -- Returned beside the timestamp deliberately: a verification date with no named
              -- evidence is exactly the claim that turned out to be fabricated. NULL here means
              -- the destination is unverified, which the timestamp alone could not say.
              destination_verified_source as "destinationVerifiedSource"
       FROM assayer_payables
       WHERE assayer_id = $1
       ORDER BY created_at DESC`,
      [assayerId],
    );
  }
}
