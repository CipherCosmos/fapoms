import {
  Injectable, NotFoundException, ConflictException, BadRequestException, UnauthorizedException, OnModuleInit, Logger } from '@nestjs/common'; import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'; import { Repository, LessThanOrEqual, In, DataSource, ILike } from 'typeorm'; import * as xlsx from 'xlsx'; import * as bcrypt from 'bcrypt'; import { randomInt } from 'crypto'; import { AssayerEntity } from './assayer.entity'; import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity'; import { WorkforceAttributeEntity } from './workforce-attribute.entity'; import { AssayerRemarkEntity } from './assayer-remark.entity'; import { AssayerActivityEntity } from './assayer-activity.entity'; import { TEMP_PASSWORD_WORDS } from './temp-password-words'; import { AuditService } from '../../core/audit/audit.service'; import { AssayerStateMachine } from './assayer.state-machine'; import { DomainEventPublisher } from '../../core/events/domain-event.publisher'; import { WorkflowEngine } from '../platform/workflow/workflow.engine'; import { NotificationDispatchService } from '../notifications/notification-dispatch.service'; import { CacheService } from '../../infrastructure/cache/cache.service'; import { rbacPrincipalCacheKey, isOnboardingStage, maySignIn } from '../auth/auth.service'; import { ASSAYER_ERROR_CODES, AUTH_ERROR_CODES, EventCategory, AssayerLifecycleStatus, AssayerStatus, AssignmentStatus, SystemRole, resolveRegion, canonicalStateName, canonicalState, ASSAYER_LIFECYCLE_TRANSITIONS, toWorkflowTransitions, AssayerEngagementType, AssayerUnavailableReason, EmpanelmentStatus, OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, businessDateKey, looksMasked, DocumentVerification, PLANNABLE_EMPANELMENT_STANDINGS,
} from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { COMMITTED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { geocodeIndia, pincodeAuthority } from '../geo/india-geocoder';
import { resolveCoordinates, needsBetterFix, isPlausibleIndianCoord, GeoFields } from '../geo/coordinate-resolution';
import { reverseFreely } from '../geo/osm-geocoder';

/**
 * Resolves an assayer's home coordinates using ONLY the shared Google geocoder.
 * Returns null when nothing resolves (no key, error, or no sane in-state hit) —
 * the caller must treat that as "unknown" rather than inventing a location.
 */
async function geocodeAddress(
  address: string,
  city: string,
  district: string,
  state: string,
  pincode?: string | null,
): Promise<{ lat: number; lng: number; accuracyMeters: number } | null> {
  return geocodeIndia(address, city, district, state, pincode);
}

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
 * Enforces that an assayer's state, district and pincode all describe the same
 * place, using the pincode as the anchor of truth. A mixed entry — a Bengaluru
 * pincode with "Karnataka" in the state field but a Delhi district, or a Delhi
 * address tagged as Karnataka — produces a clear, actionable error instead of a
 * silently wrong map pin.
 */
async function assertAddressConsistent(dto: {
  address?: string;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string | null;
}): Promise<void> {
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
  if (!/^\d{6}$/.test(pin)) return; // no pincode to anchor on — nothing further to verify
  const authority = await fetchPincodeAuthority(pin);
  if (!authority) return; // couldn't verify — skip rather than block on a guess

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
  if (
    dto.district &&
    authority.district &&
    normalizePlace(dto.district) !== normalizePlace(authority.district)
  ) {
    throw new BadRequestException(
      `Pincode ${pin} is in ${authority.district} district (${authority.state}), but the entered district is "${dto.district}". ` +
        `State, district, city, address and pincode must all describe the same place (got ${where}).`,
    );
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
  firstName: string;
  lastName: string;
  email?: string;
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // CacheModule is @Global(), so this needs no module wiring. Used only to invalidate the RBAC
    // principal cache synchronously on a password change — see changeOwnPassword/resetPasswordByStaff.
    private readonly cache: CacheService,
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

  private async syncWorkforceAttributes(assayerId: string, dto: CreateAssayerDto | UpdateAssayerDto, userId: string): Promise<void> {
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

    await this.workforceAttributeRepository.delete({
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
      await this.workforceAttributeRepository.save(newAttrs as any[]);
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

    const [assayers, total] = await this.assayerRepository.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
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
   * The pool the live map draws — every active assayer with exactly the facts a pin needs and
   * nothing else. The map used to fetch the full entity list (78 columns of HR, banking and
   * KYC detail for a layer that renders a dot), and it fetched it unscoped. This read selects
   * eleven fields, honours the region scope the way findAll does, and answers the two
   * questions the roster row cannot: which banks the person is empanelled with (one grouped
   * query, client names joined) and whether they are already committed somewhere today.
   */
  async mapRoster(scope?: Partial<GlobalScope>): Promise<Array<Record<string, unknown>>> {
    const where: Record<string, unknown> = { isActive: true };
    if (scope?.regions?.length) where.region = In(scope.regions);

    const assayers = await this.assayerRepository.find({
      select: [
        'id', 'assayerCode', 'displayName', 'phone', 'status', 'lifecycleStatus',
        'latitude', 'longitude', 'state', 'district', 'geoSource', 'geoAccuracyMeters',
      ],
      where,
      order: { displayName: 'ASC' },
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

  async findOne(id: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
    if (!assayer) throw new NotFoundException(`Assayer ${id} not found.`);
    await this.hydrateWorkforceAttributes(assayer);
    return assayer;
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
  async create(dto: CreateAssayerDto, userId: string, organizationId?: string | null): Promise<AssayerEntity> {
    // A create carrying a masked value is rarer than an edit — it happens when a form is cloned
    // from a record that was read masked — but it stores the same asterisks, so it is refused the
    // same way rather than left as the one door the guard does not cover.
    assertNoMaskedPii(dto as Record<string, any>);
    const supplied = dto.assayerCode?.trim();
    if (supplied) {
      const existing = await this.assayerRepository.findOne({ where: { assayerCode: supplied } });
      if (existing) throw new ConflictException(`Assayer code ${supplied} already exists.`);
      return this.persistNewAssayer(dto, supplied, userId, organizationId);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.allocateAssayerCode();
      try {
        return await this.persistNewAssayer(dto, candidate, userId, organizationId);
      } catch (err: any) {
        // 23505 = unique_violation. Anything else is a real failure and must surface.
        if (err?.code !== '23505' && err?.driverError?.code !== '23505') throw err;
      }
    }
    throw new ConflictException('Could not allocate an assayer code just now. Please try again.');
  }

  private async persistNewAssayer(
    dto: CreateAssayerDto,
    assayerCode: string,
    userId: string,
    organizationId?: string | null,
  ): Promise<AssayerEntity> {
    dto = { ...dto, assayerCode };

    await assertAddressConsistent(dto);

    /**
     * Checked on admission too, even though `CreateAssayerDto` carries no exit date today.
     *
     * The rule has one home and both writers call it, so on the day somebody adds `exitDate` to
     * admission — back-loading a leaver from the roster is the obvious reason, and this is where
     * it would land — the check is already standing rather than something to remember. Skipping
     * it here because the field does not exist yet is how `create` and `update` drift apart.
     */
    assertEmploymentDatesArePossible(dto);

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
      // Canonicalised from the state, exactly as branches are. Left to the caller this column
      // arrives null (the seed never sets it) or as a free-text zone name from an Excel import,
      // and either way `region IN ('WEST')` matches nobody — a region-scoped operator would
      // open the map, the roster and the capacity tile and find their workforce empty.
      region: resolveRegion(dto.region) ?? resolveRegion(dto.state) ?? null,
      joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
      displayName: `${dto.firstName} ${dto.lastName}`,
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: AssayerStatus.INACTIVE,
      organizationId: organizationId ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.assayerRepository.save(assayer);
    await this.syncWorkforceAttributes(saved.id, dto, userId);
    await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created');
    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_CREATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
    });
    await this.eventPublisher.publish('assayer:created', {
      eventType: 'assayer:created',
      aggregateId: saved.id,
      userId,
      organizationId: saved.organizationId,
      payload: { id: saved.id, displayName: saved.displayName, assayerCode: saved.assayerCode },
    });
    await this.hydrateWorkforceAttributes(saved);
    return saved;
  }

  async update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity> {
    // Before anything is merged onto the entity: see `assertNoMaskedPii`. This has to run ahead
    // of the copy loop below, which writes any key of the payload that matches a column.
    assertNoMaskedPii(dto as Record<string, any>);
    const assayer = await this.findOne(id);
    const orig = {
      address: assayer.address,
      city: assayer.city,
      district: assayer.district,
      state: assayer.state,
      pincode: assayer.pincode,
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
    for (const decided of ['status', 'lifecycleStatus'] as const) {
      if ((dto as Record<string, unknown>)[decided] !== undefined) {
        throw new BadRequestException(
          "An assayer's status is changed with the lifecycle actions on their record — activate, " +
          'put on leave, suspend, resign, terminate — which ask for a reason and record who ' +
          'decided. It cannot be set from the profile form.',
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
    if (dto.firstName || dto.lastName) {
      assayer.displayName = `${dto.firstName ?? assayer.firstName} ${dto.lastName ?? assayer.lastName}`;
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

    if (addressChanged || cityChanged || districtChanged || stateChanged) {
      await assertAddressConsistent({
        address: dto.address ?? orig.address,
        city: dto.city ?? orig.city,
        district: dto.district ?? orig.district,
        state: dto.state ?? orig.state,
        pincode: dto.pincode ?? orig.pincode,
      });
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
    await this.syncWorkforceAttributes(saved.id, dto, userId);
    await this.recordActivity(saved.id, 'ASSAYER_UPDATED', null, null, userId, 'Profile updated');
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_UPDATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Updated assayer profile: ${saved.displayName}`,
    });
    await this.eventPublisher.publish('assayer:updated', {
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
    await this.findOne(id);
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

    await this.assayerRepository.update(id, update as any);
    await this.recordActivity(id, 'ASSAYER_CONFIRMED_LOCATION', null, null, userId ?? id,
      `Base location set by the assayer to ${latitude.toFixed(5)}, ${longitude.toFixed(5)} from the app.`)
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
   */
  private static readonly HOLDS_ACTIVE_WORK: AssignmentStatus[] = [
    AssignmentStatus.ACCEPTED,
    AssignmentStatus.CHECKED_IN,
    AssignmentStatus.IN_PROGRESS,
  ];

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

  async remove(id: string, userId: string): Promise<void> {
    const assayer = await this.findOne(id);
    assayer.isActive = false;
    assayer.updatedBy = userId;
    await this.assayerRepository.save(assayer);

    // Deactivate assayer commercial profiles
    await this.dataSource.query(
      `UPDATE assayer_commercial_profiles SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate assayer documents
    await this.dataSource.query(
      `UPDATE assayer_documents SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Skills, languages and certifications. Missing from this cascade, these outlived the person:
    // the HR compliance queries join `assayers` and read `w.is_active`, so a deleted assayer's
    // certifications kept appearing under "falling due" and their skills kept counting toward
    // capability coverage — HR chasing renewals for someone who no longer exists.
    await this.dataSource.query(
      `UPDATE workforce_attributes SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    /**
     * The vetting record: references, background checks, client standings, staff remarks and
     * score overrides.
     *
     * These were never in the cascade, and the statement that used to sit here targeted
     * `assayer_government_documents` — a table `1792500000000-OneDocumentRecord` dropped. That
     * UPDATE raised 42P01 on every delete, and because it sat BEFORE the assignments and
     * schedules statements, the cascade died halfway: the person vanished from every list while
     * still holding live assignments and dated slots. Ops saw a 500, retried, and deepened the
     * partial state each time.
     *
     * Every table here is keyed by `assayer_id` and read by something that assumes the person
     * exists — the empanelment gate in planning, the qualification score, the vetting dossier.
     *
     * Written out one statement per table rather than looped: `soft-delete-cascade.spec.ts`
     * reads this method as text and checks each table by name, and a loop hides them from it.
     */
    await this.dataSource.query(
      `UPDATE assayer_references SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );
    await this.dataSource.query(
      `UPDATE assayer_background_checks SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );
    await this.dataSource.query(
      `UPDATE assayer_client_empanelments SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );
    await this.dataSource.query(
      `UPDATE assayer_remarks SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );
    await this.dataSource.query(
      `UPDATE assayer_score_overrides SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate active assignments for this assayer
    await this.dataSource.query(
      `UPDATE assignments SET is_active = false, cancel_reason = 'Assayer profile soft deleted', updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    /**
     * And the scheduled visits those assignments carry.
     *
     * The cascade stopped at the assignment, so a deleted assayer's schedules stayed active —
     * two of them in this database, both ACCEPTED, both for a profile that no longer exists.
     * A schedule is what the calendar, the day plan and the dispatch view read, so the effect
     * is a deleted person still holding dated slots that operations plans around.
     */
    await this.dataSource.query(
      `UPDATE schedules SET is_active = false, updated_by = $1
        WHERE is_active = true AND assignment_id IN (SELECT id FROM assignments WHERE assayer_id = $2)`,
      [userId, id],
    );

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_DELETED',
      entityType: 'ASSAYER',
      entityId: id,
      userId,
      remarks: `Soft deleted assayer profile ${assayer.displayName} and cascaded deactivation to commercial profiles, documents, and active assignments`,
    });
    await this.eventPublisher.publish('assayer:deleted', {
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
  async transitionLifecycle(id: string, targetStatus: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const result = await this.dispatchLifecycleTransition(id, targetStatus, userId, reason);
    await this.cache.del(rbacPrincipalCacheKey(id));
    return result;
  }

  private async dispatchLifecycleTransition(id: string, targetStatus: string, userId: string, reason?: string): Promise<AssayerEntity> {
    if (AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON.has(targetStatus) && !reason?.trim()) {
      throw new BadRequestException(
        `Say why this assayer is being moved to ${targetStatus.toLowerCase().replace(/_/g, ' ')}. ` +
        'This goes on their employment record and is what the decision will be judged on later.',
      );
    }

    if (targetStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
      return this.verifyDocuments(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
      return this.initiateBackgroundCheck(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.TRAINING) {
      return this.startTraining(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.ACTIVE) {
      return this.activateAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.ON_LEAVE) {
      return this.putOnLeave(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.SUSPENDED) {
      return this.suspendAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.INACTIVE) {
      return this.deactivateAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.RESIGNED) {
      return this.acceptResignation(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.TERMINATED) {
      return this.terminateAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.ARCHIVED) {
      return this.archiveAssayer(id, userId, reason);
    } else {
      throw new BadRequestException(`Invalid target status: ${targetStatus}`);
    }
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
   */
  async bulkTransitionLifecycle(
    ids: string[],
    targetStatus: string,
    userId: string,
    reason?: string,
  ): Promise<{
    succeeded: { id: string; from: string; to: string }[];
    skipped: { id: string; current: string; reason: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const validTargets = Object.values(AssayerLifecycleStatus);
    if (!validTargets.includes(targetStatus as AssayerLifecycleStatus)) {
      throw new BadRequestException(`Invalid target status: ${targetStatus}`);
    }

    // Doing it to twenty people at once does not make the reason less necessary. This path calls
    // `doTransitionLifecycle` directly, so the check in `transitionLifecycle` never saw it.
    if (AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON.has(targetStatus) && !reason?.trim()) {
      throw new BadRequestException(
        `Say why these assayers are being moved to ${targetStatus.toLowerCase().replace(/_/g, ' ')}. ` +
        'It goes on each of their employment records.',
      );
    }

    const succeeded: { id: string; from: string; to: string }[] = [];
    const skipped: { id: string; current: string; reason: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        const assayer = await this.findOne(id);
        const path = AssayerStateMachine.findPathTo(assayer.lifecycleStatus, targetStatus);
        if (path === null) {
          skipped.push({
            id,
            current: assayer.lifecycleStatus,
            reason: `No valid path from ${assayer.lifecycleStatus} to ${targetStatus}`,
          });
          continue;
        }
        const from = assayer.lifecycleStatus;
        for (const step of path) {
          const { saved, event } = await this.doTransitionLifecycle(id, step as AssayerLifecycleStatus, userId, reason);
          if (event) this.eventPublisher.publish(event.constructor.name, event);
          void saved;
        }
        succeeded.push({ id, from, to: targetStatus });
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }

    return { succeeded, skipped, failed };
  }

  private async doTransitionLifecycle(
    id: string,
    targetStatus: AssayerLifecycleStatus,
    userId: string,
    reason?: string,
    role = SystemRole.ADMIN,
  ): Promise<{ saved: AssayerEntity; event: any }> {
    const assayer = await this.findOne(id);
    const currentStatus = assayer.lifecycleStatus;

    let event: any;
    if (targetStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
      event = AssayerStateMachine.verifyDocuments(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
      event = AssayerStateMachine.initiateBackgroundCheck(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.TRAINING) {
      event = AssayerStateMachine.startTraining(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.ACTIVE) {
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
    } else {
      throw new BadRequestException(`Invalid lifecycle status: ${targetStatus}`);
    }

    // Before the save, because these are columns on the entity about to be written.
    const datesCorrected = this.reconcileDepartureDates(assayer, targetStatus);

    return this.workflowEngine.executeCommand(
      'assayer',
      assayer.id,
      `${targetStatus}_Command`,
      currentStatus,
      targetStatus,
      userId,
      role,
      [],
      async () => {
        const saved = await this.assayerRepository.save(assayer);

        // After the save, so a departure whose workflow command was refused does not close the
        // client standings of somebody still on the roster.
        const empanelmentsClosed = AssayerService.DEPARTED_LIFECYCLE.has(targetStatus)
          ? await this.closeClientEmpanelmentsOnDeparture(saved.id, targetStatus, userId)
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
        ].filter(Boolean).join('; ');
        const remarks = [reason?.trim() || null, consequences || null].filter(Boolean).join(' — ') || null;

        await this.recordActivity(saved.id, 'ASSAYER_LIFECYCLE_TRANSITION', currentStatus, targetStatus, userId, remarks);
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'ASSAYER_LIFECYCLE_TRANSITION',
          entityType: 'ASSAYER',
          entityId: saved.id,
          previousState: currentStatus,
          newState: targetStatus,
          userId,
          remarks: remarks || `Lifecycle transition: ${currentStatus} → ${targetStatus}`,
        });

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
  ): Promise<number> {
    // TypeORM returns `[rows, rowCount]` from an UPDATE, not a rows array.
    const [, affected] = await this.dataSource.query(
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
    const assayer = await this.assayerRepository.findOne({ where });
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

  // ---- Activity Timeline ----

  // Public because it is the ONE writer of assayer_activities — QualificationScoreService
  // records score overrides through it rather than growing a second writer with its own idea
  // of the row shape.
  async recordActivity(assayerId: string, eventType: string, previousState: string | null, newState: string | null, userId: string, remarks: string | null): Promise<void> {
    const activity = this.activityRepository.create({
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
    await this.activityRepository.save(activity);
  }

  async getActivityTimeline(assayerId: string, page = 1, limit = 20): Promise<{ activities: AssayerActivityEntity[]; total: number }> {
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
    return this.commercialRepository.find({
      where: { assayerId, isActive: true },
      order: { effectiveStartDate: 'DESC' },
    });
  }

  async getActiveCommercialProfile(assayerId: string, date: Date = new Date()): Promise<AssayerCommercialProfileEntity | null> {
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
    const assayers = await this.assayerRepository.find({ where: { isActive: true }, select: { id: true } });
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
      { field: 'Active / Inactive', required: 'No', description: 'Availability and how they are engaged, as written in the roster, e.g. "Active / Regular", "Inactive / Not Interested", "Active / Back up". Read into availability, reason and engagement type.' },
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
    const assayer = await this.assayerRepository.findOne({
      where: { id: assayerId },
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
    const assayer = await this.assayerRepository.findOne({
      where: { id: assayerId },
      select: { id: true, assayerCode: true, displayName: true, phone: true, email: true, lifecycleStatus: true },
    });
    if (!assayer) throw new NotFoundException('Assayer not found.');

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

  /** HR/admin resets an assayer's password — the only recovery path for someone locked out. */
  async resetPasswordByStaff(
    assayerId: string,
    newPassword: string | undefined,
    actorId: string,
  ): Promise<{ generatedPassword?: string }> {
    const assayer = await this.assayerRepository.findOne({ where: { id: assayerId }, select: { id: true } });
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

}
