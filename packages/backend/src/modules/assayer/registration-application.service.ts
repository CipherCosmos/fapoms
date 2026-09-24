import {
  Injectable, Inject, Logger, NotFoundException, BadRequestException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { EventCategory, ApplicationStatus, APPLICATION_TERMINAL_STATUSES, applicationIsEditableByCandidate, EmploymentCategory, OnboardingDocument, ONBOARDING_DOCUMENT_LABELS, DocumentRejectionReason, DOCUMENT_REJECTION_GUIDANCE, ApplicationDocumentReviewStatus, APPLICATION_INFO_REQUESTABLE_FIELDS, readApplicationInfoRequests, type ApplicationInfoRequestItem, normalizeApplicationReferences, referenceSubmitProblem, AssayerLifecycleStatus, ApplicationSource, ASSAYER_ERROR_CODES, pickRegistrationRecordFields, groupRegistrationRecordFields, REGISTRATION_SECRET_FIELD_KEYS, CURRENT_CONSENT_NOTICE, CURRENT_CONSENT_VERSION, consentNoticeFor, type ConsentNotice, REGISTRATION_FIELD_GROUPS, maskRegistrationFields, looksMasked, pickEmploymentTermFields, mergedRegistrationView, missingRegistrationFields, isValidPan, isValidIfsc, isValidAadhaar, isBankAccountNumber, normaliseBankAccountNumber, BANK_ACCOUNT_NUMBER_RULE, REGISTRATION_REQUIRED_DOCUMENTS, normalisePhone, dateOfBirthProblem, maskTail, type OutboundMessageReceipt, businessDateKey, businessTodayDateKey, normalizeSourceReferral, candidateMayEditSourceReferral, type SourceReferral, type ReferralRecordedBy, VERIFIED_DOCUMENTS, candidateJourneyStage, type CandidateJourneyProgress } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { AssayerApplicationEntity } from './assayer-application.entity';
import { AssayerApplicationDocumentEntity } from './assayer-application-document.entity';
import { AssayerInterviewEntity, type InterviewAttachment } from './assayer-interview.entity';
import { AssayerEntity } from './assayer.entity';
import { AssayerService, CreateAssayerDto } from './assayer.service';
import { RosterRecordsService } from './roster-records.service';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { appPublicUrl } from '../../infrastructure/notifications/email-provider';
import { REGISTRATION_INVITE_INTRO } from '../../infrastructure/notifications/email-template-registry';
import { EmailService } from '../notifications/email.service';
import { SmsService } from '../notifications/sms.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { GeoPrecisionService } from '../geo/geo-precision.service';
import { needsBetterFix } from '../geo/coordinate-resolution';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { hashCode, numericCode, hashesEqual } from '../auth/otp-codes';
import { fieldFingerprint, encryptField, decryptField, isEncrypted } from '../../infrastructure/security/field-encryption';
import { assertUploadAllowed, SCAN_UPLOAD_TYPES } from '../document/upload-validation';
import { lookupIfsc } from '../geo/ifsc-lookup.helper';
import { lookupPincodeDetailed } from '../geo/pincode-lookup.helper';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { tenantWhere } from '../../infrastructure/tenancy/ambient-tenant-context';
import type { Readable } from 'stream';

const TOKEN_BYTES = 32;
const OTP_TTL_SECONDS = 300;
const OTP_VERIFIED_TTL_SECONDS = 24 * 60 * 60;
const OTP_SEND_WINDOW_SECONDS = 60 * 60;
const OTP_SEND_MAX_PER_WINDOW = 5;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

/**
 * The floor on the reason for admitting a candidate no interview ever saw.
 *
 * Matched by `OpenWithoutInterviewDto`'s `@MinLength(10)` so a caller that skips the controller
 * meets the same bar. Ten characters is not a judgement of quality — nothing can be — it is the
 * length at which "ok", "walk in" and a stray keypress stop qualifying as a recorded decision.
 */
const MIN_NO_INTERVIEW_REASON_LENGTH = 10;

/**
 * The first half of an approval claim's advisory-lock key; the application id is the second.
 *
 * The two-key form lives in a different lock space from the single-bigint keys used elsewhere
 * (the audit seal), so no application id can ever contend with them.
 */
const APPROVAL_CLAIM_NAMESPACE = 'assayer_application_approval';

/**
 * Why a candidate is in the pipeline with no interview behind them.
 *
 * Stored in `extendedProfile.openedWithoutInterview` rather than in a column of its own: the
 * absence of an interview is already visible as a null `interviewId`, and what was missing was
 * the reason for it. `getApplication` hands this to the review drawer so the reviewer reads the
 * decision — and who made it — beside the application it excused.
 */
export interface OpenedWithoutInterviewStamp {
  reason: string;
  byId: string;
  byName: string | null;
  /** ISO-8601, because this rides in jsonb where a `Date` would come back as a string anyway. */
  at: string;
}

/**
 * The stamp, read back out of untyped jsonb.
 *
 * Shape-checked rather than cast: `extendedProfile` is a column anything can have been written
 * into, including by an older build, and a half-written stamp rendered as "Added without an
 * interview — undefined" would be a worse answer than no banner at all.
 */
function readOpenedWithoutInterview(
  application: Pick<AssayerApplicationEntity, 'extendedProfile'>,
): OpenedWithoutInterviewStamp | null {
  const raw = (application.extendedProfile as Record<string, unknown> | null)?.openedWithoutInterview;
  if (!raw || typeof raw !== 'object') return null;
  const stamp = raw as Partial<OpenedWithoutInterviewStamp>;
  if (typeof stamp.reason !== 'string' || !stamp.reason) return null;
  return {
    reason: stamp.reason,
    byId: typeof stamp.byId === 'string' ? stamp.byId : '',
    byName: typeof stamp.byName === 'string' ? stamp.byName : null,
    at: typeof stamp.at === 'string' ? stamp.at : '',
  };
}

/**
 * One document HR wants re-uploaded: which requirement, why (structured), and what to do.
 *
 * `reason` is a `DocumentRejectionReason` value when given — the same list the roster's vetting
 * tab offers, so a reviewer learns one set of words and the candidate gets actionable guidance
 * (`DOCUMENT_REJECTION_GUIDANCE`) instead of a paragraph to decode.
 */
export interface DocumentInfoRequestInput {
  requirement: OnboardingDocument;
  reason?: string;
  note?: string;
}

/** One form field HR wants corrected: which field, and what is wrong with it. */
export interface FieldInfoRequestInput {
  key: string;
  message?: string;
}

/**
 * The targeted replacement for one free-text "request info" note: the exact documents and
 * fields HR ticked, plus an optional overall note. A plain string is still accepted anywhere
 * this goes (treated as `{notes}`), so older callers keep working.
 */
export interface StructuredInfoRequestInput {
  notes?: string;
  documents?: DocumentInfoRequestInput[];
  fields?: FieldInfoRequestInput[];
}

/** HR's ticked field key → the words both screens use for it. Falls back to the raw key. */
function fieldRequestLabel(key: string): string {
  return APPLICATION_INFO_REQUESTABLE_FIELDS.find((f) => f.key === key)?.label ?? key;
}

/** Is this a tickable field — something the candidate can actually fix on their link? */
function isRequestableField(key: string): boolean {
  return APPLICATION_INFO_REQUESTABLE_FIELDS.some((f) => f.key === key);
}

function isValidRejectionReason(reason: string): boolean {
  return (Object.values(DocumentRejectionReason) as string[]).includes(reason);
}

/**
 * Validate HR's ticked documents and fields into the to-do list the candidate's link renders.
 *
 * Throws on anything the candidate could not act on: an unknown document, an unknown reason, a
 * field the form never asks for. A request that names nothing real is worse than no request —
 * the candidate's link would reopen with an empty checklist and no idea what to do.
 */
function buildInfoRequestItems(input: StructuredInfoRequestInput): ApplicationInfoRequestItem[] {
  const items: ApplicationInfoRequestItem[] = [];
  for (const doc of input.documents ?? []) {
    if (!Object.values(OnboardingDocument).includes(doc.requirement)) {
      throw new BadRequestException('That is not a recognised document type.');
    }
    const reason = doc.reason?.trim() || null;
    if (reason && !isValidRejectionReason(reason)) {
      throw new BadRequestException('That is not a recognised send-back reason.');
    }
    const note = doc.note?.trim() || '';
    const guidance = reason ? DOCUMENT_REJECTION_GUIDANCE[reason as DocumentRejectionReason] : '';
    const message = note || guidance || 'Please re-upload a clear scan of this document.';
    if (message.length > 1000) {
      throw new BadRequestException('Keep each document instruction under 1000 characters.');
    }
    items.push({
      kind: 'document',
      key: doc.requirement,
      label: ONBOARDING_DOCUMENT_LABELS[doc.requirement] ?? doc.requirement,
      message,
      reason,
    });
  }
  const seenFields = new Set<string>();
  for (const field of input.fields ?? []) {
    const key = field.key?.trim() || '';
    if (!key || !isRequestableField(key)) {
      throw new BadRequestException(`"${field.key ?? ''}" is not something the candidate can fix on their form.`);
    }
    if (seenFields.has(key)) continue;
    seenFields.add(key);
    const message = field.message?.trim() || 'Please check and correct this field.';
    if (message.length > 1000) {
      throw new BadRequestException('Keep each field instruction under 1000 characters.');
    }
    items.push({ kind: 'field', key, label: fieldRequestLabel(key), message });
  }
  return items;
}

/** Merge new asks into the stored to-do list: same kind+key is replaced, the rest is kept. */
function mergeInfoRequestItems(
  existing: ApplicationInfoRequestItem[],
  incoming: ApplicationInfoRequestItem[],
): ApplicationInfoRequestItem[] {
  const next = existing.filter(
    (item) => !incoming.some((ask) => ask.kind === item.kind && ask.key === item.key),
  );
  return [...next, ...incoming];
}

/**
 * The documents the Appraiser Recruitment spec asks for beyond the common set, split by
 * `EmploymentCategory`. A presentation-layer list, not a vocabulary change — same precedent as
 * `SELF_SERVICE_REQUIRED`/`SELF_SERVICE_OPTIONAL` in `assayer-self-service.controller.ts`. Lives
 * here rather than in `@fapoms/shared` because that controller's split is for an authenticated
 * `SystemRole.ASSAYER`, which a pre-account candidate is not.
 *
 * `RENT_AGREEMENT` and `ELECTRICITY_BILL` are offered to both categories, never hard-required —
 * the spec itself conditions them ("if address is different than Aadhar", "if shop is rented"),
 * and nothing here or in `submit()` blocks on document completeness at all: that judgement is
 * HR's, at review (`requestMoreInfo` exists precisely for "you're missing X").
 */
const COMMON_REGISTRATION_DOCUMENTS: readonly OnboardingDocument[] = [
  /**
   * A face, first.
   *
   * The ID card printed "Photo unavailable" for every person who joined remotely, because
   * `assayers.photograph` is written only as a side effect of attaching a PHOTOGRAPH document and
   * registration never asked for one. A field identity card with no face on it is not an identity
   * card, and it is the thing a bank's security desk actually looks at. This is the one document
   * approval refuses without.
   */
  OnboardingDocument.PHOTOGRAPH,
  OnboardingDocument.PAN_CARD,
  OnboardingDocument.AADHAAR_FRONT,
  OnboardingDocument.AADHAAR_BACK,
  /**
   * The account the pay goes to, evidenced. Required at submit (`REGISTRATION_REQUIRED_DOCUMENTS`):
   * the page of the passbook — or a cancelled cheque or statement page — showing their name, the
   * account number and the IFSC, which is what the reviewer checks the typed numbers against.
   */
  OnboardingDocument.BANK_PASSBOOK,
  OnboardingDocument.OFFICE_ADDRESS_PROOF,
  OnboardingDocument.RENT_AGREEMENT,
  OnboardingDocument.ELECTRICITY_BILL,
];

const FREELANCER_DOCUMENTS: readonly OnboardingDocument[] = [
  ...COMMON_REGISTRATION_DOCUMENTS,
  OnboardingDocument.EXPERIENCE_LETTER,
];

const PROPRIETOR_DOCUMENTS: readonly OnboardingDocument[] = [
  ...COMMON_REGISTRATION_DOCUMENTS,
  OnboardingDocument.SHOP_ENTITY_PROOF,
  OnboardingDocument.ASSOCIATION_LETTER,
];

export function documentsRequestedFor(category?: EmploymentCategory | null): readonly OnboardingDocument[] {
  if (category === EmploymentCategory.PROPRIETOR) return PROPRIETOR_DOCUMENTS;
  if (category === EmploymentCategory.FREELANCER) return FREELANCER_DOCUMENTS;
  return COMMON_REGISTRATION_DOCUMENTS;
}

const EDITABLE_DRAFT_FIELDS = [
  'fullName', 'email', 'dateOfBirth', 'gender', 'address', 'state', 'city', 'pincode',
  'experienceYears', 'currentEmployer', 'expertise', 'availability', 'employmentCategory',
  // `mobile` is here so a candidate can correct the number before they verify it; `verifyOtp` is
  // what makes the corrected number stick, because that is where it is proven.
  'mobile',
] as const;

/**
 * An extended profile with its record fields filtered to what a registration may set.
 *
 * Returns the profile unchanged apart from `fields`, and drops `fields` entirely when nothing
 * survives the filter — an empty object stored there would read as "asked and left blank".
 */
function filterExtendedProfile(
  profile: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!profile) return null;
  const fields = pickRegistrationRecordFields(
    (profile as { fields?: Record<string, unknown> }).fields,
  );
  const { fields: _ignored, ...rest } = profile as Record<string, unknown>;
  return Object.keys(fields).length > 0 ? { ...rest, fields } : { ...rest };
}


/**
 * THE APPLICATION HOLDS THE SAME THREE NUMBERS THE RECORD ENCRYPTS.
 *
 * `assayers` has encrypted `pan_number`, `aadhaar_number` and `bank_account_number` since the
 * column encryption landed. The application — the same numbers, typed by the same person, minutes
 * earlier — kept them as plain text in a jsonb column, went on holding them after approval, and
 * returned them whole to every HR list and detail response. An audit found them sitting in the live
 * database in the clear.
 *
 * So they are sealed on the one write path (`mergeRecordFields`), opened again only where the
 * plaintext is genuinely needed — the duplicate check, promotion, and the candidate's own form —
 * and masked everywhere a staff screen can see them.
 */
function sealSecretFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  for (const key of REGISTRATION_SECRET_FIELD_KEYS) {
    const value = out[key];
    if (typeof value !== 'string' || value.trim() === '' || isEncrypted(value)) continue;
    out[key] = encryptField(value.trim());
  }
  return out;
}

function openSecretFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  for (const key of REGISTRATION_SECRET_FIELD_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && isEncrypted(value)) out[key] = decryptField(value);
  }
  return out;
}

/** The stored answers with their secrets readable — for promotion, duplicate checks and the candidate. */
function openProfile(profile: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!profile) return null;
  const fields = (profile as { fields?: Record<string, unknown> }).fields;
  if (!fields) return { ...profile };
  return { ...profile, fields: openSecretFields(fields) };
}

/**
 * The current value of every field HR asked to have corrected, as comparable text.
 *
 * Columns are read off the application; record answers off `extendedProfile.fields`, OPENED first
 * — a PAN is stored encrypted, and comparing ciphertext would call every save a change. A date is
 * read as its calendar day, so a `Date` and the "1985-03-14" that produced it compare equal.
 */
function askedFieldValues(
  application: AssayerApplicationEntity,
  asks: ApplicationInfoRequestItem[],
): Record<string, string> {
  const fields = (openProfile(application.extendedProfile as Record<string, unknown> | null)?.fields ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const { key } of asks) {
    const raw = (EDITABLE_DRAFT_FIELDS as readonly string[]).includes(key)
      ? (application as unknown as Record<string, unknown>)[key]
      : fields[key];
    out[key] = raw instanceof Date
      ? (Number.isNaN(raw.getTime()) ? '' : businessDateKey(raw))
      : String(raw ?? '').trim();
  }
  return out;
}

/**
 * A field ask leaves the to-do list when the candidate (or the desk) actually changes that field.
 *
 * Document asks already cleared themselves on a fresh scan; field asks never did, so "Date of
 * birth — please correct" stayed on the candidate's link and on HR's "waiting on candidate" list
 * after it had been corrected. "Changed", not "saved": the form saves every box on blur, so a
 * candidate tabbing past the date of birth would otherwise have cleared the ask without touching
 * it. A field they deliberately leave as it was stays asked — and `submit` settles those.
 */
function dropAnsweredFieldAsks(
  application: AssayerApplicationEntity,
  asks: ApplicationInfoRequestItem[],
  before: Record<string, string>,
): void {
  const after = askedFieldValues(application, asks);
  const answered = new Set(asks.filter((a) => before[a.key] !== after[a.key]).map((a) => a.key));
  if (answered.size === 0) return;
  application.infoRequests = readApplicationInfoRequests(application.infoRequests)
    .filter((i) => !(i.kind === 'field' && answered.has(i.key))) as unknown as Array<Record<string, unknown>>;
}

/** The stored answers as a staff screen may see them: last four digits, never the number. */
function maskProfile(profile: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!profile) return null;
  const fields = (profile as { fields?: Record<string, unknown> }).fields;
  if (!fields) return { ...profile };
  return { ...profile, fields: maskRegistrationFields(openSecretFields(fields)) };
}

/** An application with its stored answers masked, for any response staff receive. */
function maskApplication<T extends { extendedProfile?: unknown }>(application: T): T {
  if (!application?.extendedProfile) return application;
  return { ...application, extendedProfile: maskProfile(application.extendedProfile as Record<string, unknown>) } as T;
}


/**
 * Remove from the application the identity numbers the record accepted.
 *
 * Keyed off the same groups promotion applies (`REGISTRATION_FIELD_GROUPS`), so a refused group
 * keeps its numbers here — the only remaining copy — rather than losing them.
 */
function clearAppliedSecrets(application: AssayerApplicationEntity, failedGroups: string[]): void {
  const profile = (application.extendedProfile ?? null) as Record<string, unknown> | null;
  const fields = profile?.fields as Record<string, unknown> | undefined;
  if (!fields) return;

  const failed = new Set(failedGroups);
  const next = { ...fields };
  let changed = false;
  for (const key of REGISTRATION_SECRET_FIELD_KEYS) {
    if (!(key in next)) continue;
    const group = REGISTRATION_FIELD_GROUPS.find((g) => (g.keys as readonly string[]).includes(key));
    if (group && failed.has(group.name)) continue;
    delete next[key];
    changed = true;
  }
  if (changed) application.extendedProfile = { ...profile, fields: next } as never;
}

/**
 * What a reviewer may add when they approve — see `approve()` for why the three groups are kept
 * apart rather than merged into one bag of fields.
 */
export interface ApproveApplicationInput {
  /** Record fields the candidate answered wrongly. Filtered by the registration allow-list. */
  corrections?: Record<string, unknown>;
  /** What only the desk decides. Filtered by `EMPLOYMENT_TERM_FIELD_KEYS`. */
  terms?: Record<string, unknown>;
  /** The rate card, filed in the same action rather than remembered afterwards. */
  commercial?: Record<string, unknown>;
  /** First client standings. Without at least one, nobody can be given work for anybody. */
  empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
  allowSharedContact?: boolean;
  sharedContactReason?: string;
}

export interface UpdateApplicationDraftDto {
  fullName?: string;
  /** The candidate's own number. Confirmed by `verifyOtp`, which is what writes it for good. */
  mobile?: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  state?: string;
  city?: string;
  pincode?: string;
  experienceYears?: number;
  currentEmployer?: string;
  expertise?: string;
  availability?: string;
  employmentCategory?: EmploymentCategory;
  /**
   * Everything else the person will need once they are real — identity numbers, bank details,
   * emergency contact, qualification, map pin — keyed by the ASSAYER RECORD's own field names and
   * filtered through `pickRegistrationRecordFields` before it is stored.
   *
   * It goes under `extendedProfile.fields`, which promotion already applies through the guarded
   * `AssayerService.update`. That is why a candidate filling this in on their phone and a clerk
   * filling it in at the desk produce the same person: there is one storage, one filter and one
   * applier, rather than a wizard that wrote the record directly and a candidate form that could
   * not reach half of it.
   */
  record?: Record<string, unknown>;
  /**
   * People who can vouch for the candidate — up to three, at least one with a number before
   * submit. Held under `extendedProfile.references`, which promotion replays onto the record.
   * Normalized on the way in (trimmed, empties dropped, capped), so no door stores a fourth
   * reference or a number with no name.
   */
  references?: Array<Record<string, unknown>>;
  /**
   * Who referred them — the source reference, under `extendedProfile.sourceReferral`. The
   * candidate may write it only while HR has not (`candidateMayEditSourceReferral`).
   */
  sourceReferral?: unknown;
}

/**
 * What the desk may write when it fills a form in for somebody.
 *
 * Everything a candidate can put in their own draft, plus the three groups only a desk decides —
 * the rate card, the references and the first client standings. Those three are not candidate
 * answers and never were; they live under `extendedProfile` and `approve()` already knows how to
 * apply all of them.
 *
 * Notably NOT here: consent, the verification code, and submit. Those are the candidate's, and a
 * desk-filled application still waits for them.
 */
export interface StaffApplicationPatch extends UpdateApplicationDraftDto {
  commercial?: Record<string, unknown>;
  references?: Array<Record<string, unknown>>;
  empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
}

/**
 * The Appraiser Recruitment application layer: invite tokens, pre-account OTP verification,
 * draft/submit, and HR's approve/reject/request-more-info review — including promotion into a
 * real `AssayerEntity`.
 *
 * See `AssayerApplicationEntity`'s class comment for why this is a separate table rather than a
 * status on the live assayer, and this module's plan doc for the full design. Two invariants worth
 * restating here because a change to either would quietly break candidates already mid-flow:
 *
 * 1. Only a token's HASH is ever stored (`hashCode`, the same SHA-256 discipline `MfaService` uses
 *    for delivered codes). A "resend" always mints a fresh token — there is no raw value left to
 *    resend, which is the point.
 * 2. `submit()` deliberately does not block on document completeness. HR's `requestMoreInfo` is
 *    where an incomplete file gets caught, matching how the ungated HR-desk wizard next to this
 *    also never gates Finish on documents.
 */
/**
 * What a submitted application's registration link may still show: enough to tell the candidate
 * where they stand, and none of what they told us. See `hydrate`.
 */
function submittedApplicationView(application: AssayerApplicationEntity): AssayerApplicationEntity {
  return {
    id: application.id,
    status: application.status,
    fullName: application.fullName,
    email: application.email,
    // The page may say which number HR will call; the last four identify it well enough.
    mobile: application.mobile ? maskTail(application.mobile) : application.mobile,
    employmentCategory: application.employmentCategory,
    consentAcceptedAt: application.consentAcceptedAt,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    extendedProfile: null,
  } as unknown as AssayerApplicationEntity;
}

/** The one sentence an expired link is refused with. */
const LINK_EXPIRED_MESSAGE = 'This registration link has expired. Ask HR to resend it.';

/** Whether a link is past its expiry — the one rule every use of the link reads. */
function linkHasExpired(application: AssayerApplicationEntity): boolean {
  return !application.tokenExpiresAt || application.tokenExpiresAt.getTime() < Date.now();
}

/**
 * Where a link past its expiry may still show the candidate's progress: every status after the form
 * was sent. A DRAFT has nothing to report, and stays refused.
 */
const PROGRESS_AFTER_EXPIRY: readonly ApplicationStatus[] = [
  ApplicationStatus.PENDING_VALIDATION,
  ApplicationStatus.AWAITING_INFO,
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
];

/**
 * The documents an approved candidate's link may say HR has asked for again: their photograph and
 * the papers a reviewer verifies (identity documents and the passbook) — the only rows HR can send
 * back, through review or "Ask to re-upload". Named rather than "every sent-back row" so the
 * company's own paperwork about a person, above all the background-verification report, can never
 * surface on an unauthenticated page even if one were one day marked as sent back.
 */
const CANDIDATE_RESENDABLE_DOCUMENTS: readonly OnboardingDocument[] = [
  OnboardingDocument.PHOTOGRAPH,
  ...VERIFIED_DOCUMENTS,
];

/** Which channel carried a registration verification code, and where, masked for the page to show. */
export interface RegistrationOtpDelivery {
  channel: 'SMS' | 'EMAIL';
  sentTo: string;
  cooldownSeconds?: number;
  expiresInSeconds?: number;
}

/**
 * A mobile number as the registration page may repeat it back: the last four digits only, behind a
 * fixed-width run of bullets so the mask does not give away how long the number is — "••••• 4455".
 */
export function maskedMobile(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return `••••• ${digits.slice(-4)}`;
}

/** An email address as the registration page may repeat it back: "r•••@example.com". */
export function maskedEmail(email: string): string {
  const [user, domain] = (email ?? '').trim().split('@');
  if (!user || !domain) return '•••';
  return `${user.charAt(0)}•••@${domain}`;
}

@Injectable()
export class RegistrationApplicationService {
  private readonly logger = new Logger(RegistrationApplicationService.name);

  constructor(
    @InjectRepository(AssayerApplicationEntity)
    private readonly applications: Repository<AssayerApplicationEntity>,
    @InjectRepository(AssayerApplicationDocumentEntity)
    private readonly applicationDocuments: Repository<AssayerApplicationDocumentEntity>,
    /** Read only to show the reviewer the number HR typed beside the one the candidate confirmed. */
    @InjectRepository(AssayerInterviewEntity)
    private readonly interviews: Repository<AssayerInterviewEntity>,
    /**
     * Written to for exactly one thing: carrying the candidate's consent onto the record they
     * become. It does not go through `AssayerService.update` because consent is not an editable
     * field — correcting it later would be rewriting what somebody agreed to.
     */
    @InjectRepository(AssayerEntity)
    private readonly assayers: Repository<AssayerEntity>,
    private readonly assayerService: AssayerService,
    private readonly rosterRecords: RosterRecordsService,
    private readonly auditService: AuditService,
    private readonly notificationDispatch: NotificationDispatchService,
    /**
     * Every email this service sends. All but the verification code are queued; the code is sent
     * while the candidate waits, because the page must not say "sent" for one that was not.
     */
    private readonly emails: EmailService,
    private readonly cache: CacheService,
    private readonly settings: PlatformSettingsService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    /**
     * Holds an approval's claim — see `approve`. Through the port, so this service still opens no
     * transaction at an isolation level of its own choosing (`persistence-boundary.spec.ts`).
     */
    private readonly uow: UnitOfWork,
    /** Where a newly approved person's home is placed, after the approval request has returned. */
    private readonly geoPrecision: GeoPrecisionService,
    /**
     * The verification code, texted to the number being verified when SMS is set up (email is the
     * fallback). Last, so the positional spec harness gains an argument rather than shifting one.
     */
    private readonly sms: SmsService,
  ) {}

  // ── Invite creation ──────────────────────────────────────────────────────

  /** Mutates `application.token*` in place and returns the raw token — callers persist it. */
  private async mintToken(application: AssayerApplicationEntity): Promise<string> {
    const expiryHours = await this.settings.getNumber('registration.inviteExpiryHours', 72);
    const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
    application.tokenHash = hashCode(rawToken);
    application.tokenExpiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
    application.tokenConsumedAt = null;
    return rawToken;
  }

  /**
   * The candidate-facing URL for a freshly minted token.
   *
   * Returned to the person who just minted it, and to nobody else: the token IS the candidate's
   * authorisation, so it never appears in a list, a read, or an audit remark. Handing it back at
   * the moment of minting is what makes the flow work on a deployment whose email is off — which
   * is every deployment until someone configures a mailbox. Without it a PASS verdict produced a
   * token that existed only inside an email that was never sent, and the candidate had no way in
   * at all.
   */
  private inviteLink(rawToken: string): string {
    return `${appPublicUrl()}/register/${rawToken}`;
  }

  /**
   * Queues the invite and returns its receipt — null when there is no address to send to.
   *
   * The receipt, not a boolean, because callers must not assume the email went. The HR screen once
   * said "an invite has been emailed to …" purely because an address existed, while a deployment
   * with email switched off sent nothing at all. The send used to happen right here, inside the
   * desk's request, and cost it ~5 s; now the screen gets the receipt at once and watches it reach
   * SENT or FAILED (`GET /outbound-emails/:id`), which keeps the answer honest without the wait.
   *
   * `intro` is what this link is for — a first invitation, a replacement, a request for more — and
   * is the only wording decided here. The rest of the email lives in the `registration-invite`
   * template, which carries `intro` in both its shipped HTML and its built-in fallback.
   */
  private async sendInviteEmail(
    application: AssayerApplicationEntity,
    rawToken: string,
    intro: string,
    requestedBy?: string | null,
  ): Promise<OutboundMessageReceipt | null> {
    if (!application.email) return null;
    return this.emails.queue({
      kind: 'REGISTRATION_INVITE',
      to: application.email,
      content: {
        template: 'registration-invite',
        data: {
          fullName: application.fullName || 'Candidate',
          inviteUrl: this.inviteLink(rawToken),
          intro,
          logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
          companyName: 'Sumeru Global',
        },
      },
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      requestedBy: requestedBy ?? null,
    });
  }

  /**
   * The row behind an interview, for the desk's correction window.
   *
   * Read rather than guarded here because the caller is the one that knows what it is about to
   * change; `AssayerInterviewService.amend` decides whether the window is still open from
   * `tokenConsumedAt` and the status. Returns null for an interview whose application has been
   * deleted, which no code path does today.
   */
  async findApplicationForAmend(id: string): Promise<AssayerApplicationEntity | null> {
    return this.applications.findOne({ where: { id } });
  }

  /**
   * Is this person already partway in?
   *
   * Asked before an interview PASS mints anything. Two PASS verdicts for one candidate — a second
   * interview, or simply somebody pressing Record twice — used to produce two applications and two
   * live invite links for one person, with no unique index, no idempotency key and nothing to
   * notice. Whichever link the candidate happened to open became the real one, and the other
   * application sat in the queue as a phantom.
   *
   * Terminal applications are ignored on purpose: somebody rejected a year ago and interviewed
   * again is a new candidate, and refusing them would be the wrong kind of memory.
   */
  async openApplicationForMobile(
    mobile: string,
    organizationId?: string | null,
  ): Promise<AssayerApplicationEntity | null> {
    const trimmed = (mobile ?? '').trim();
    if (!trimmed) return null;
    const found = await this.applications.find({
      where: { mobile: trimmed, isActive: true, ...(organizationId ? { organizationId } : {}) } as any,
      order: { createdAt: 'DESC' },
    });
    return found.find((a) => (a.isActive ?? true) && !APPLICATION_TERMINAL_STATUSES.includes(a.status) && a.status !== ApplicationStatus.WITHDRAWN) ?? null;
  }

  /**
   * Is this number already somebody else's — on the roster, or on another live application?
   *
   * TWO EXCLUSIONS, AND BOTH ARE THE DIFFERENCE BETWEEN A CHECK AND A WALL.
   *
   * `excludeApplicationId` keeps an application from colliding with itself. `excludeAssayerId` is
   * the one that was missing, and it made the candidate-facing page unusable: approving somebody
   * CREATES an assayer carrying their number, so from that moment their own application matched
   * the roster row it had just produced, and every OTP request, verification and submit answered
   * "This mobile number is already registered with someone else" — about them, to them. Callers
   * pass `application.promotedAssayerId`.
   *
   * `isActive` matters for the same reason it does on the identifier check: a soft-deleted ghost
   * must not veto a live registration.
   *
   * Two sentences come back, because there are two audiences. `message` is candidate-safe and
   * names nobody — whose number it is is somebody else's identity, and the public form is not
   * entitled to it. `detail` names the person and their code for the desk, which is the only way
   * a clerk can tell a real duplicate from a seeded row or a number typed into two records.
   */
  async checkMobileConflict(
    phone: string,
    organizationId?: string | null,
    excludeApplicationId?: string,
    excludeAssayerId?: string | null,
  ): Promise<{
    conflict: boolean; target: 'ASSAYER' | 'APPLICATION'; message: string; detail: string;
    assayerCode?: string; displayName?: string;
  } | null> {
    const raw = (phone ?? '').trim();
    if (!raw) return null;
    const normalized = normalisePhone(raw) ?? raw.replace(/\D/g, '').slice(-10);
    if (!normalized || normalized.length < 6) return null;

    const variants = Array.from(new Set([
      normalized,
      `+91${normalized}`,
      `91${normalized}`,
      `0${normalized}`,
      raw,
    ])).filter(Boolean);

    // 1. Already on the roster — but not counting this application's own promoted record, and not
    //    counting anybody soft-deleted off the roster.
    if (this.assayers && typeof this.assayers.findOne === 'function') {
      for (const v of variants) {
        const match = await this.assayers.findOne({
          where: {
            phone: v,
            isActive: true,
            ...(organizationId ? { organizationId } : {}),
          } as any,
        });
        // `excludeAssayerId` only excuses a match when it is actually set: comparing two
        // undefineds would read every conflict as "that is just them" and wave it through.
        if (match && (!excludeAssayerId || match.id !== excludeAssayerId)) {
          const who = [match.displayName, match.assayerCode ? `(${match.assayerCode})` : null]
            .filter(Boolean).join(' ');
          return {
            conflict: true,
            target: 'ASSAYER',
            assayerCode: match.assayerCode ?? undefined,
            displayName: match.displayName ?? undefined,
            message: 'This mobile number is already in use by somebody on our roster. If it is '
              + 'your own number, contact the office — they can sort it out.',
            detail: who
              ? `${raw} is already on the roster as ${who}.`
              : `${raw} is already on the roster.`,
          };
        }
      }
    }

    // 2. Check if already claimed by another active registration application
    if (this.applications && typeof this.applications.findOne === 'function') {
      for (const v of variants) {
        const match = await this.applications.findOne({
          where: {
            mobile: v,
            isActive: true,
            ...(organizationId ? { organizationId } : {}),
          } as any,
        });
        if (match && (!excludeApplicationId || match.id !== excludeApplicationId)
          && (match.isActive ?? true)
          && !APPLICATION_TERMINAL_STATUSES.includes(match.status)
          && match.status !== ApplicationStatus.WITHDRAWN) {
          return {
            conflict: true,
            target: 'APPLICATION',
            displayName: match.fullName ?? undefined,
            message: 'This mobile number is already being used by another application. If it is '
              + 'your own number, contact the office — they can sort it out.',
            detail: match.fullName
              ? `${raw} is already on an open application for ${match.fullName}.`
              : `${raw} is already on another open application.`,
          };
        }
      }
    }

    return null;
  }

  async checkPhoneForToken(rawToken: string, phone: string) {
    const application = await this.findByRawToken(rawToken);
    const conflict = await this.checkMobileConflict(phone, application.organizationId, application.id, application.promotedAssayerId);
    if (!conflict) return { conflict: false as const };
    // The rulebook's own candidate-safe sentence, not a fourth copy of it: this screen is the
    // candidate's, so it says there is a clash and never whose number it is.
    return { conflict: true as const, message: conflict.message };
  }

  /**
   * The application and its token, written and nothing else.
   *
   * Split from the send below because the two must not share a fate. Minting used to save the row
   * and email the link in one call, inside a hand-off that then had a second write to do
   * (`AssayerInterviewService` links the interview back to the application it spawned) — so a
   * failure after the email left a candidate holding a working link to an application the desk's
   * own log did not know about. The write now happens on the caller's transaction and the email
   * goes out after it commits, which is the only order in which an unsendable email is the worse
   * outcome rather than the unrecallable one.
   *
   * `manager` is the caller's transaction when there is one. There is no version of this that
   * sends anything.
   */
  async createInviteRecord(
    input: {
      interviewId?: string | null;
      fullName?: string | null;
      mobile: string;
      email?: string | null;
      organizationId?: string | null;
      /** Who referred them, as HR recorded it at intake — already in the shared shape. */
      sourceReferral?: SourceReferral | null;
    },
    manager?: EntityManager,
  ): Promise<{ application: AssayerApplicationEntity; rawToken: string }> {
    const application = this.applications.create({
      interviewId: input.interviewId ?? null,
      fullName: input.fullName ?? null,
      mobile: input.mobile,
      email: input.email ?? null,
      organizationId: input.organizationId ?? null,
      status: ApplicationStatus.DRAFT,
      ...(input.sourceReferral ? { extendedProfile: { sourceReferral: input.sourceReferral } as never } : {}),
    });
    const rawToken = await this.mintToken(application);
    const saved = manager
      ? await manager.save(AssayerApplicationEntity, application)
      : await this.applications.save(application);
    return { application: saved, rawToken };
  }

  /**
   * Deliver a minted link, and hand back what the screen needs to report whether it went.
   *
   * Called after the transaction that created the row has committed. `email` is a receipt the
   * screen watches (`emailDelivery`) rather than a delivery it announces, so the interview screen can say what
   * happened instead of announcing a delivery on the strength of an address being present.
   */
  async deliverInvite(
    application: AssayerApplicationEntity,
    rawToken: string,
    requestedBy?: string | null,
  ): Promise<{ emailDelivery: OutboundMessageReceipt | null; inviteLink: string }> {
    const emailDelivery = await this.sendInviteEmail(application, rawToken, REGISTRATION_INVITE_INTRO, requestedBy);
    return { emailDelivery, inviteLink: this.inviteLink(rawToken) };
  }

  /**
   * Mint and send in one call — the composition of the two above, for a caller with no transaction
   * of its own to join.
   */
  async createInvite(input: {
    interviewId?: string | null;
    fullName?: string | null;
    mobile: string;
    email?: string | null;
    organizationId?: string | null;
    requestedBy?: string | null;
  }): Promise<{ application: AssayerApplicationEntity; emailDelivery: OutboundMessageReceipt | null; inviteLink: string }> {
    const { application, rawToken } = await this.createInviteRecord(input);
    const { emailDelivery, inviteLink } = await this.deliverInvite(application, rawToken, input.requestedBy);
    return { application, emailDelivery, inviteLink };
  }

  /**
   * A candidate the interview gate never saw — admitted on a reason, not on a shrug.
   *
   * Until now a PASS was the only door into the pipeline, so a walk-in or a referral could be
   * hired only by recording an interview that never happened. A mandatory step that blocks real
   * work does not survive contact with the desk; it survives as a fiction, and the fiction is
   * worse than the gap because it also destroys the screening record for everybody who WAS
   * interviewed. So the step is skippable and the skip is the thing that gets written down.
   *
   * What separates this from the interview path is only the absence of an interview:
   * `interviewId` stays null, the row, the token and the email are the same ones
   * `createInviteRecord`/`deliverInvite` mint for a PASS, and `source` stays SELF_SERVICE because
   * the candidate is still the one who fills the form in. (`HR_DESK` means the desk typed the
   * substance, and it is what maker–checker keys on at `approve()` — claiming it here would
   * quietly bar whoever added the candidate from ever reviewing them.)
   *
   * The two calls are used rather than `createInvite` for the reason `createInviteRecord`'s own
   * docblock gives: the stamp is saved before anything is sent, because an email cannot be
   * recalled and a stamp that failed to save would leave a candidate holding a live link into a
   * pipeline with no record of why they are in it.
   */
  async openWithoutInterview(
    input: { fullName: string; mobile: string; email?: string | null; reason: string; sourceReferral?: unknown },
    actor: { id: string; name?: string | null; organizationId?: string | null },
  ): Promise<{ applicationId: string; emailDelivery: OutboundMessageReceipt | null; inviteLink: string }> {
    const fullName = (input.fullName ?? '').trim();
    const mobile = (input.mobile ?? '').trim();
    const reason = (input.reason ?? '').trim();
    if (!fullName) throw new BadRequestException('Candidate name is required.');
    if (!mobile) throw new BadRequestException('Mobile number is required.');
    const { referral: sourceReferral, error: referralError } = normalizeSourceReferral(input.sourceReferral, 'HR');
    if (referralError) throw new BadRequestException(referralError);
    if (reason.length < MIN_NO_INTERVIEW_REASON_LENGTH) {
      throw new BadRequestException(
        'Say why this candidate is being added without an interview. The reason is stamped on '
        + 'their application and written to the audit trail, so it has to be a sentence somebody '
        + 'can read later.',
      );
    }

    // The same refusal a PASS gets: somebody already on the roster is not a candidate, and a
    // second application would race the first for the same person.
    const conflict = await this.checkMobileConflict(mobile, actor.organizationId);
    if (conflict && conflict.target === 'ASSAYER') {
      throw new ConflictException(conflict.detail);
    }

    /*
      Already in the queue?

      `openApplicationForMobile` is the same look `AssayerInterviewService.record` takes before a
      PASS mints anything, and it ignores decided applications on purpose — somebody rejected a
      year ago is a new candidate. The id travels in the body so the screen can offer to open the
      application they already have rather than leaving the desk to search for it.
    */
    const open = await this.openApplicationForMobile(mobile, actor.organizationId);
    if (open) {
      const who = open.fullName?.trim() || fullName;
      const refusal = new ConflictException(
        `${who} already has an open application on ${mobile}. Open that one rather than starting a second.`,
      );
      const body = refusal.getResponse();
      if (typeof body === 'object' && body !== null) Object.assign(body, { applicationId: open.id });
      throw refusal;
    }

    const { application, rawToken } = await this.createInviteRecord({
      fullName,
      mobile,
      email: input.email?.trim() || null,
      organizationId: actor.organizationId ?? null,
      sourceReferral,
    });

    /*
      The decision, stamped where the screen can read it.

      `extendedProfile` is the jsonb `deskEditors` already rides in, and `applyExtendedProfile`
      reads that column by named group — so a key it does not know is carried to approval and
      ignored there, exactly as `deskEditors` is. No column, no migration: `interviewId` stays
      null, and this stamp is the answer to "why is there no interview behind this person?".
    */
    const stamp: OpenedWithoutInterviewStamp = {
      reason,
      byId: actor.id,
      byName: actor.name?.trim() || null,
      at: new Date().toISOString(),
    };
    const profile = (application.extendedProfile ?? {}) as Record<string, unknown>;
    application.extendedProfile = { ...profile, openedWithoutInterview: stamp } as never;
    const saved = await this.applications.save(application);

    const { emailDelivery, inviteLink } = await this.deliverInvite(saved, rawToken, actor.id);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_OPENED_WITHOUT_INTERVIEW',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actor.id,
      remarks: `${fullName} was added to the hiring pipeline with no interview on record, by `
        + `${stamp.byName ?? actor.id}. Reason: ${reason} — ${inviteDeliveryRemark(emailDelivery, saved.email)}`,
      metadata: emailDelivery?.id ? { outboundMessageId: emailDelivery.id } : undefined,
    });

    // The email is a receipt the screen watches rather than a delivery it assumes, and the link
    // comes back either way, so the desk can read it out when the send does not happen — the same
    // contract the interview path has.
    return { applicationId: saved.id, emailDelivery, inviteLink };
  }

  /**
   * Send the candidate a fresh link.
   *
   * Two places already told people this existed — the candidate's own "This registration link is
   * not valid. Ask HR to resend it." and the interview screen's advice after a failed send — while
   * nothing could actually do it. A lost or undelivered invite was therefore a dead end: the
   * application sits in DRAFT, the roster never gains the person, and the only route back was a
   * second interview record.
   *
   * It mints a new token rather than re-sending the old one because only the hash was ever
   * stored, so the original raw token no longer exists anywhere. This stays the ONE place that
   * rotates the link: `requestMoreInfo` deliberately keeps the candidate's link working instead.
   */
  async resendInvite(id: string, actorUserId: string): Promise<{ application: AssayerApplicationEntity; emailDelivery: OutboundMessageReceipt | null; inviteLink: string }> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    if (APPLICATION_TERMINAL_STATUSES.includes(application.status)) {
      throw new BadRequestException('This application has already been decided — there is nothing left to complete.');
    }

    // A missing email used to be a refusal. It is not one: the desk can read the link out over
    // the phone or paste it into a message, and on a deployment with email switched off that is
    // the ONLY way a candidate is ever reached. Minting still happens; only the send is skipped.
    const rawToken = await this.mintToken(application);
    const saved = await this.applications.save(application);
    const emailDelivery = await this.sendInviteEmail(
      saved,
      rawToken,
      'Here is a fresh link to complete your Appraiser registration. Any earlier link has stopped working.',
      actorUserId,
    );
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_INVITE_RESENT',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actorUserId,
      remarks: `Fresh link generated; ${inviteDeliveryRemark(emailDelivery, saved.email)}`,
      metadata: emailDelivery?.id ? { outboundMessageId: emailDelivery.id } : undefined,
    });
    return { application: saved, emailDelivery, inviteLink: this.inviteLink(rawToken) };
  }

  // ── Token resolution ─────────────────────────────────────────────────────

  /** The application a link belongs to, whether or not the link has expired. Unknown is a 404. */
  private async resolveRawToken(rawToken: string): Promise<AssayerApplicationEntity> {
    const tokenHash = hashCode(rawToken);
    const application = await this.applications.findOne({ where: { tokenHash } });
    if (!application) {
      throw new NotFoundException('This registration link is not valid. Ask HR to resend it.');
    }
    return application;
  }

  /**
   * The application a link belongs to — for anything that reads the form or changes it. An expired
   * link is refused here, for every write and for the full form; only `hydrate` looks past the
   * expiry, and then only to say how the candidate is getting on (`statusOnlyView`).
   */
  private async findByRawToken(rawToken: string): Promise<AssayerApplicationEntity> {
    const application = await this.resolveRawToken(rawToken);
    if (linkHasExpired(application)) {
      throw new BadRequestException(LINK_EXPIRED_MESSAGE);
    }
    return application;
  }

  async hydrate(rawToken: string): Promise<{
    application: AssayerApplicationEntity;
    documents: AssayerApplicationDocumentEntity[];
    documentsRequested: readonly OnboardingDocument[];
    otpVerified: boolean;
    /** What the form must show, and agree to, before it collects anything. */
    consentNotice: ConsentNotice & { grievanceContact: string };
    /**
     * Exactly what HR asked for, when the link reopened as `AWAITING_INFO` — the to-do list the
     * form renders instead of one free-text banner. Empty on a first fill and once submitted.
     */
    infoRequests: ApplicationInfoRequestItem[];
    /**
     * Where an APPROVED candidate has got to since — the step, whether they are paused, and what HR
     * has asked them to send again. Null for every other status. See `approvedJourney`.
     */
    journey: CandidateJourneyProgress | null;
    /**
     * True when the link has expired and this is only the candidate's progress — no form, nothing
     * of what they gave, no way to change anything. See `statusOnlyView`.
     */
    statusOnly: boolean;
  }> {
    const application = await this.resolveRawToken(rawToken);
    if (linkHasExpired(application)) {
      if (!PROGRESS_AFTER_EXPIRY.includes(application.status)) throw new BadRequestException(LINK_EXPIRED_MESSAGE);
      return this.statusOnlyView(application);
    }
    if (!application.tokenConsumedAt) {
      application.tokenConsumedAt = new Date();
      await this.applications.save(application);
    }
    const documents = await this.applicationDocuments.find({ where: { applicationId: application.id } });
    const verified = await this.cache.getJson<{ phone: string }>(`regotp:verified:${hashCode(rawToken)}`);

    /*
      A SUBMITTED APPLICATION'S LINK STOPS BEING A KEY TO THE CANDIDATE'S IDENTITY.

      The link is a bearer credential: whoever holds it is treated as the candidate. That is
      necessary while they are filling the form in, and for nothing afterwards — yet this returned
      the whole application, PAN, Aadhaar, bank account and all, for as long as the link lived,
      including after HR had approved it. The link ends up in browser history, forwarded messages
      and, as an audit of the running stack found, in hundreds of proxy log lines.

      Once the application is out of the candidate's hands, the page needs only enough to say
      "submitted, under review": who, which status, where we will write to them. Every stored answer
      and every scan stays behind the desk's own authenticated routes. If HR sends it back for more
      information it is editable again, and the full form returns with it.
    */
    if (!applicationIsEditableByCandidate(application.status)) {
      return {
        application: submittedApplicationView(application),
        documents: documents.map((d) => ({
          ...d,
          // Same count, so the page can still say how many were received; no storage keys.
          filePaths: (d.filePaths ?? []).map(() => '[submitted]'),
        })) as AssayerApplicationDocumentEntity[],
        documentsRequested: documentsRequestedFor(application.employmentCategory),
        otpVerified: Boolean(verified),
        // Still shown after submission: what they agreed to is theirs to re-read, and the page
        // offers withdrawal from here until a decision is made.
        consentNotice: await this.consentNotice(),
        infoRequests: [],
        journey: await this.approvedJourney(application),
        statusOnly: false,
      };
    }

    return {
      // The candidate's own answers, readable, so a resumed form shows what they typed. Theirs to
      // see; the link is locked down the moment they submit (above).
      application: { ...application, extendedProfile: openProfile(application.extendedProfile as Record<string, unknown> | null) } as AssayerApplicationEntity,
      documents,
      documentsRequested: documentsRequestedFor(application.employmentCategory),
      otpVerified: Boolean(verified),
      consentNotice: await this.consentNotice(),
      infoRequests: readApplicationInfoRequests(application.infoRequests),
      journey: null,
      statusOnly: false,
    };
  }

  /**
   * AN EXPIRED LINK STILL SAYS HOW THE CANDIDATE IS GETTING ON (owner, 2026-09-24: "status-only after
   * expiry").
   *
   * The link lives 72 hours from when it was sent or HR last asked for more, and joining takes longer
   * than that — so the steps after approval were, for most people, behind "this link has expired".
   * Past its expiry the link now answers one question: where have I got to, and is anything asked
   * of me. Nothing else. No name, no contact details, no answers, no scans, no consent text — a
   * forwarded or leaked link says at most that somebody is at a step and which papers HR wants
   * again. And no way to change anything: every write still goes through `findByRawToken`, which
   * refuses the expired link exactly as before, and this writes nothing either.
   *
   * Only for a form that was sent. An expired link to an unsent draft has no progress to show,
   * and is refused as it always was.
   */
  private async statusOnlyView(application: AssayerApplicationEntity) {
    return {
      application: { id: application.id, status: application.status } as unknown as AssayerApplicationEntity,
      documents: [] as AssayerApplicationDocumentEntity[],
      documentsRequested: [] as readonly OnboardingDocument[],
      otpVerified: false,
      consentNotice: null as unknown as ConsentNotice & { grievanceContact: string },
      // What HR asked for when it sent the form back — so they know what to ask HR for a new link to fix.
      infoRequests: application.status === ApplicationStatus.AWAITING_INFO
        ? readApplicationInfoRequests(application.infoRequests)
        : [],
      journey: await this.approvedJourney(application),
      statusOnly: true,
    };
  }

  /**
   * WHAT THE LINK MAY SAY ABOUT SOMEBODY AFTER THEY ARE HIRED.
   *
   * The candidate's page used to stop at "Approved" while four more steps lay ahead — documents,
   * background check, final approval, training if needed — and HR could ask for a document again
   * with nothing on the page to say so. This is that, and only that.
   *
   * The link is unauthenticated, so what it may carry is decided here, field by field:
   *  - the step, mapped by `candidateJourneyStage` — never the lifecycle value itself, and never the
   *    unavailable reason, so a failed background check and a refused approval read identically as
   *    "paused"; no verdict, finding, agency, approver or comment is read at all;
   *  - the documents HR has sent back (`evaluateSelfDocumentChange` via `selfDocumentGates`, the same
   *    rule the phone app is told), limited to `CANDIDATE_RESENDABLE_DOCUMENTS`, each with its name
   *    and the sentence written FOR the candidate — HR's own "Ask to re-upload" note, or the
   *    send-back guidance the rejection notice already sent them. Nothing else about the file.
   * A paused person is asked for nothing here: HR will be talking to them anyway.
   *
   * Read-only by design. Answering an ask stays behind the assayer's own sign-in, in the app; this
   * adds no way to change the record through a link.
   *
   * Best effort: the page still says "Approved" if this cannot be read, which is better than a
   * status page that fails to open over a decoration.
   */
  private async approvedJourney(application: AssayerApplicationEntity): Promise<CandidateJourneyProgress | null> {
    if (application.status !== ApplicationStatus.APPROVED || !application.promotedAssayerId) return null;
    try {
      const person = await this.assayers.findOne({
        where: { id: application.promotedAssayerId },
        select: { id: true, lifecycleStatus: true },
      });
      if (!person) return null;
      const { stage, paused } = candidateJourneyStage(person.lifecycleStatus);
      if (paused) return { stage: null, paused: true, asks: [] };
      const gates = await this.rosterRecords.selfDocumentGates(person.id, CANDIDATE_RESENDABLE_DOCUMENTS);
      const asks = gates
        .filter((gate) => gate.mode === 'reopened')
        .map((gate) => ({
          requirement: gate.requirement,
          label: ONBOARDING_DOCUMENT_LABELS[gate.requirement as OnboardingDocument] ?? gate.requirement,
          note: gate.hrNote?.trim() || null,
        }));
      return { stage, paused: false, asks };
    } catch (err) {
      this.logger.warn(`Application ${application.id}: the journey after approval could not be read: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  // ── OTP ──────────────────────────────────────────────────────────────────

  /**
   * Send the candidate a verification code: by text to the mobile number they typed when SMS is set
   * up, by email otherwise — the owner's decision.
   *
   * A texted code is what makes this a real check of the number: only the person holding that phone
   * can read it back, so a code proven here means the mobile on the record is theirs. Email is the
   * fallback (SMS not configured, or the gateway refused this one) because an SMS-only code meant
   * nobody could finish registering while SMS was unconfigured. What the fallback costs, stated
   * plainly: the invite link already arrived in that mailbox, so an emailed code proves the person
   * holding the link is the person invited, and the number is then taken on trust — still bound to
   * the code below, so the record gets it, but not proven.
   *
   * Answers which channel carried the code and a masked destination, so the page can say "texted to
   * ••••• 4455" or "emailed to r•••@example.com" rather than guess.
   */
  async requestOtp(rawToken: string, phone: string): Promise<RegistrationOtpDelivery> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    // A code is a message to a real phone number: nothing is sent before they have agreed.
    this.assertConsented(application);
    // Asked once, so the "no email" refusal and the send below agree about whether SMS is there.
    const textsAvailable = this.sms.isEnabled();
    if (!textsAvailable && !application.email) {
      throw new BadRequestException(
        'There is no email address on this application to send a code to. Ask HR to add one and resend your link.',
      );
    }
    const conflict = await this.checkMobileConflict(phone, application.organizationId, application.id, application.promotedAssayerId);
    if (conflict) {
      throw new ConflictException(conflict.message);
    }
    const tokenHash = hashCode(rawToken);

    const sendCounterKey = `regotp:sent:${tokenHash}`;
    const sent = (await this.cache.getJson<{ count: number }>(sendCounterKey))?.count ?? 0;
    if (sent >= OTP_SEND_MAX_PER_WINDOW) {
      throw new BadRequestException(
        'Too many verification codes have been requested for this link. Try again later, or ask HR for help.',
      );
    }

    const normPhone = normalisePhone(phone) ?? phone.replace(/\D/g, '');
    const phoneSendCounterKey = `regotp:phonesent:${normPhone}`;
    const phoneSent = (await this.cache.getJson<{ count: number }>(phoneSendCounterKey))?.count ?? 0;
    if (phoneSent >= OTP_SEND_MAX_PER_WINDOW) {
      throw new BadRequestException(
        'Too many verification codes have been requested for this mobile number. Try again later, or ask HR for help.',
      );
    }

    const cooldownSeconds = await this.settings.getNumber('registration.otpResendCooldownSeconds', 60);
    const lastSentKey = `regotp:lastsent:${tokenHash}`;
    const lastSentAt = await this.cache.getJson<number>(lastSentKey);
    if (lastSentAt) {
      const elapsed = (Date.now() - lastSentAt) / 1000;
      if (elapsed < cooldownSeconds) {
        const remaining = Math.max(1, Math.ceil(cooldownSeconds - elapsed));
        throw new BadRequestException(
          `Please wait ${remaining} second${remaining === 1 ? '' : 's'} before requesting another code.`,
        );
      }
    }

    const phoneLastSentKey = `regotp:phonelastsent:${normPhone}`;
    const phoneLastSentAt = await this.cache.getJson<number>(phoneLastSentKey);
    if (phoneLastSentAt) {
      const elapsed = (Date.now() - phoneLastSentAt) / 1000;
      if (elapsed < cooldownSeconds) {
        const remaining = Math.max(1, Math.ceil(cooldownSeconds - elapsed));
        throw new BadRequestException(
          `Please wait ${remaining} second${remaining === 1 ? '' : 's'} before requesting another code.`,
        );
      }
    }

    const code = numericCode(6);
    await this.cache.del(`regotp:fail:${tokenHash}`);
    await this.cache.setJson(`regotp:code:${tokenHash}`, { hash: hashCode(code), phone }, OTP_TTL_SECONDS);
    await this.cache.setJson(sendCounterKey, { count: sent + 1 }, OTP_SEND_WINDOW_SECONDS);
    await this.cache.setJson(phoneSendCounterKey, { count: phoneSent + 1 }, OTP_SEND_WINDOW_SECONDS);
    const now = Date.now();
    await this.cache.setJson(lastSentKey, now, OTP_SEND_WINDOW_SECONDS);
    await this.cache.setJson(phoneLastSentKey, now, OTP_SEND_WINDOW_SECONDS);
    const validMinutes = String(Math.round(OTP_TTL_SECONDS / 60));

    /**
     * Both sends happen now, not queued: the candidate is on the page waiting for it, and the answer
     * to this request is whether it went. The code travels only as template data; `sendNow` records
     * each send without its body, and no log line below names the code or the full destination.
     *
     * `sendNow` answers `{ sent: false }` — it does not throw — when a transport is off or refuses.
     * This route once logged that and returned success, so the candidate read that a code was on its
     * way and waited for a message nobody had sent. A text that did not go falls through to email.
     */
    if (textsAvailable) {
      try {
        const texted = await this.sms.sendNow({
          kind: 'REGISTRATION_OTP',
          to: phone,
          recipientName: application.fullName,
          content: { template: 'registration-otp', data: { code, validMinutes } },
          entityType: 'ASSAYER_APPLICATION',
          entityId: application.id,
        });
        if (texted?.sent) {
          return {
            channel: 'SMS',
            sentTo: maskedMobile(phone),
            cooldownSeconds,
            expiresInSeconds: OTP_TTL_SECONDS,
          };
        }
        this.logger.warn(
          `Registration OTP text to ${maskedMobile(phone)} failed for token ${tokenHash.slice(0, 8)}…: `
          + `${texted?.error ?? 'SMS gateway reported no success'}`,
        );
      } catch (err) {
        this.logger.warn(`Registration OTP text for token ${tokenHash.slice(0, 8)}… threw: ${(err as Error)?.message ?? err}`);
      }
    }

    if (application.email) {
      const result = await this.emails.sendNow({
        kind: 'REGISTRATION_OTP',
        to: application.email,
        content: {
          template: 'otp-verification',
          data: {
            otpCode: code,
            validMinutes,
            logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
            supportEmail: 'recruitment@sumeruglobal.com',
            companyName: 'Sumeru Global',
          },
        },
        entityType: 'ASSAYER_APPLICATION',
        entityId: application.id,
      });
      if (result?.sent) {
        return {
          channel: 'EMAIL',
          sentTo: maskedEmail(application.email),
          cooldownSeconds,
          expiresInSeconds: OTP_TTL_SECONDS,
        };
      }
      this.logger.warn(
        `Registration OTP email to ${maskedEmail(application.email)} failed for token ${tokenHash.slice(0, 8)}…: `
        + `${result?.error ?? 'email transport reported no success'}`,
      );
    }

    /** A code that was never sent is a dead end, so clean up and say so instead of answering "sent". */
    await this.cache.del(`regotp:code:${tokenHash}`, lastSentKey, phoneLastSentKey);
    await this.cache.setJson(sendCounterKey, { count: sent }, OTP_SEND_WINDOW_SECONDS);
    await this.cache.setJson(phoneSendCounterKey, { count: phoneSent }, OTP_SEND_WINDOW_SECONDS);
    throw new BadRequestException(
      'We could not send you a verification code just now. Contact HR — they can help you finish registering.',
    );
  }

  async verifyOtp(rawToken: string, phone: string, code: string): Promise<void> {
    const tokenHash = hashCode(rawToken);
    const codeKey = `regotp:code:${tokenHash}`;
    const failKey = `regotp:fail:${tokenHash}`;

    const pending = await this.cache.getJson<{ hash: string; phone: string }>(codeKey);
    if (!pending) {
      throw new BadRequestException('That code has expired or has not been requested.');
    }

    if (pending.phone !== phone || !hashesEqual(pending.hash, hashCode(code))) {
      const fails = ((await this.cache.getJson<{ count: number }>(failKey))?.count ?? 0) + 1;
      if (fails >= OTP_MAX_VERIFY_ATTEMPTS) {
        await this.cache.del(codeKey, failKey);
        throw new BadRequestException(
          'Too many incorrect attempts. This code has been invalidated. Please request a new code.',
        );
      }
      await this.cache.setJson(failKey, { count: fails }, OTP_TTL_SECONDS);
      const remaining = OTP_MAX_VERIFY_ATTEMPTS - fails;
      throw new BadRequestException(
        `That code is incorrect. You have ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      );
    }

    // Success: invalidate code and fail counter immediately so code cannot be verified twice
    await this.cache.del(codeKey, failKey);
    await this.cache.setJson(`regotp:verified:${tokenHash}`, { phone }, OTP_VERIFIED_TTL_SECONDS);

    /**
     * The number the candidate confirmed becomes the number on the application.
     *
     * Both forms have always rendered "Your mobile number", and the answer was used to key a cache
     * entry and then thrown away: `mobile` was not editable on the draft, so the number promoted
     * onto the record stayed whatever HR typed at the interview — for the FIRST critical field on
     * the record (`assayer-record.ts:28`, "Calling and phone-channel dispatch"). The person in the
     * field is the one who knows their own number.
     *
     * Written here rather than on every keystroke because this is the moment it is confirmed. What
     * HR typed is not lost: the interview row keeps it, and the review screen shows both so a
     * mismatch is somebody's decision rather than a silent overwrite.
     */
    const application = await this.findByRawToken(rawToken);
    const conflict = await this.checkMobileConflict(phone, application.organizationId, application.id, application.promotedAssayerId);
    if (conflict) {
      throw new ConflictException(conflict.message);
    }
    if (applicationIsEditableByCandidate(application.status) && application.mobile !== phone) {
      application.mobile = phone;
      await this.applications.save(application);
    }
  }

  private async assertOtpVerified(rawToken: string): Promise<void> {
    const verified = await this.cache.getJson(`regotp:verified:${hashCode(rawToken)}`);
    if (!verified) {
      throw new ForbiddenException('Verify your mobile number before continuing.');
    }
  }

  // ── Lookups (pincode → address, IFSC → bank) ─────────────────────────────

  /**
   * What a pincode actually is, for the candidate's own address form.
   *
   * The desk wizard reads this same directory from its own browser
   * (`resolvePincode` in `AssayerForms.tsx`); this page carries no session, so
   * it reads it through the invite token instead — one directory, two doors.
   * The token is validated (expiry enforced) because it is the only auth this
   * controller has; a miss is `null`, never an error, so the form degrades to
   * hand-typing rather than blocking.
   */
  async lookupPincode(rawToken: string, pin: string) {
    await this.findByRawToken(rawToken);
    const answer = await lookupPincodeDetailed(pin);
    // `{status}` always, and the place only when there is one: a null told the form nothing about
    // WHY, so it said "check the digits" whether the directory had answered no or nobody had
    // managed to ask.
    return answer.status === 'found' ? { status: answer.status, ...answer.place } : { status: answer.status };
  }

  /**
   * Which bank an IFSC code belongs to — the same `lookupIfsc` the
   * authenticated `GET /geo/ifsc/:code` route answers, minus the session.
   */
  async lookupIfsc(rawToken: string, code: string) {
    await this.findByRawToken(rawToken);
    return lookupIfsc(code);
  }

  // ── Draft ────────────────────────────────────────────────────────────────

  async updateDraft(rawToken: string, patch: UpdateApplicationDraftDto): Promise<AssayerApplicationEntity> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    // The first answer is the first collection — this is the line consent has to come before.
    this.assertConsented(application);
    if (patch.mobile && normalisePhone(patch.mobile) !== normalisePhone(application.mobile)) {
      const conflict = await this.checkMobileConflict(patch.mobile, application.organizationId, application.id, application.promotedAssayerId);
      if (conflict) {
        throw new ConflictException(conflict.message);
      }
    }
    this.applyDraftPatch(application, patch, 'CANDIDATE');
    const stored = await this.applications.save(application);
    /*
      The candidate gets their own answers back readable.

      `hydrate` already opens them and this response feeds the same form, so returning the stored
      value put "enc:v1:sJ9hA…" into the PAN box the moment the draft saved — and the next keystroke
      would have sent that back as the number. Found by probing the running system, not by a test.
    */
    return {
      ...stored,
      extendedProfile: openProfile(stored.extendedProfile as Record<string, unknown> | null),
    } as AssayerApplicationEntity;
  }

  /**
   * The patch half of a draft save, shared by the token door and the desk door.
   *
   * Extracted rather than copied. A desk-side draft was written once before as a verbatim copy of
   * this loop, and the duplication is most of why it was deleted again a day later: two places
   * deciding which fields an application may hold is two places to forget one.
   */
  private applyDraftPatch(
    application: AssayerApplicationEntity,
    patch: UpdateApplicationDraftDto,
    /** Whose door this came through — decides whether HR's source referral may be changed. */
    by: ReferralRecordedBy,
  ): void {
    // Snapshot what HR asked to have corrected BEFORE the patch lands, so an ask is dropped only
    // when its value actually changed — see `dropAnsweredFieldAsks` below.
    const fieldAsks = readApplicationInfoRequests(application.infoRequests).filter((i) => i.kind === 'field');
    const before = fieldAsks.length > 0 ? askedFieldValues(application, fieldAsks) : null;
    for (const key of EDITABLE_DRAFT_FIELDS) {
      const incoming = (patch as Record<string, unknown>)[key];
      if (incoming === undefined) continue;
      if (key === 'dateOfBirth') {
        if (typeof incoming === 'string' && incoming.trim() !== '') {
          const d = new Date(incoming);
          (application as unknown as Record<string, unknown>)[key] = Number.isNaN(d.getTime()) ? null : d;
        } else if (incoming instanceof Date) {
          (application as unknown as Record<string, unknown>)[key] = Number.isNaN(incoming.getTime()) ? null : incoming;
        } else {
          (application as unknown as Record<string, unknown>)[key] = null;
        }
      } else {
        (application as unknown as Record<string, unknown>)[key] = incoming;
      }
    }
    this.mergeRecordFields(application, patch.record);
    if (patch.references !== undefined) {
      const { references, error } = normalizeApplicationReferences(patch.references);
      if (error) throw new BadRequestException(error);
      const profile = ((application.extendedProfile ?? {}) as Record<string, unknown>);
      profile.references = references;
      application.extendedProfile = profile as never;
    }
    if (patch.sourceReferral !== undefined) {
      const profile = ((application.extendedProfile ?? {}) as Record<string, unknown>);
      const current = (profile.sourceReferral ?? null) as SourceReferral | null;
      // HR's entry is HR's: the candidate sees it on their form but does not change it.
      if (by === 'CANDIDATE' && !candidateMayEditSourceReferral(current)) {
        throw new BadRequestException('HR has recorded who referred you. Ask them if it needs changing.');
      }
      const { referral, error } = normalizeSourceReferral(patch.sourceReferral, by);
      if (error) throw new BadRequestException(error);
      if (referral) profile.sourceReferral = referral; else delete profile.sourceReferral;
      application.extendedProfile = profile as never;
    }
    if (before) dropAnsweredFieldAsks(application, fieldAsks, before);
  }

  /**
   * The desk filling a candidate's form in for them.
   *
   * The second typist, not a second pipeline: the application was still created by an interview
   * PASS, the candidate still verifies their own number and still accepts the declaration, and
   * `submit()` is still theirs to press. All this does is save somebody typing — the case where a
   * candidate is sitting at the desk, or has sent their papers in and cannot use a form.
   *
   * Gated on `applicationIsEditableByCandidate`, the SAME predicate the candidate's own door uses,
   * not merely on "not terminal". Once they submit, the desk stops being able to change what is
   * being reviewed — otherwise "approve what you read" is not true. `requestMoreInfo` is the way
   * back: it returns the application to AWAITING_INFO, which is editable again.
   */
  async updateStaffDraft(
    id: string,
    patch: StaffApplicationPatch,
    actorUserId: string,
  ): Promise<AssayerApplicationEntity> {
    const application = await this.applications.findOne({ where: tenantWhere<AssayerApplicationEntity>({ id }) });
    if (!application) throw new NotFoundException('Application not found.');
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException(
        'This application has already been submitted, so it is under review rather than being '
        + 'filled in. Use Request more information to send it back for a change.',
      );
    }

    this.stampDeskAuthorship(application, actorUserId);
    this.applyDraftPatch(application, patch, 'HR');

    /*
      The three groups only a desk decides, and the reason this method is worth having.

      `approve()` already knows how to apply all three — `applyExtendedProfile` replays them
      through the same guarded services the record page uses — and until now NO screen has ever
      sent one. So every candidate promoted through this pipeline arrived with no rate card and no
      client standing, which is to say unassignable, until somebody noticed and set them on the
      record afterwards.
    */
    const profile = (application.extendedProfile ?? {}) as Record<string, unknown>;
    if (patch.commercial !== undefined) profile.commercial = patch.commercial;
    if (patch.empanelments !== undefined) profile.empanelments = patch.empanelments;
    application.extendedProfile = profile as never;
    application.updatedBy = actorUserId;

    const saved = await this.applications.save(application);
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_DESK_EDITED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actorUserId,
      remarks: `Filled in at the HR desk for ${saved.fullName ?? saved.mobile}; approval must come from a different account.`,
    });
    return saved;
  }

  /**
   * Correct an application's registered mobile number from the HR desk.
   * Validates that the new number does not conflict with an active Assayer or active application.
   */
  async updateApplicationMobile(id: string, newMobile: string, actorUserId: string): Promise<AssayerApplicationEntity> {
    const application = await this.applications.findOne({ where: tenantWhere<AssayerApplicationEntity>({ id }) });
    if (!application) throw new NotFoundException('Application not found.');
    if (APPLICATION_TERMINAL_STATUSES.includes(application.status)) {
      throw new BadRequestException('This application has already been decided.');
    }
    const trimmed = (newMobile ?? '').trim();
    if (!trimmed) throw new BadRequestException('Mobile number is required.');

    const conflict = await this.checkMobileConflict(trimmed, application.organizationId, application.id, application.promotedAssayerId);
    if (conflict) {
      throw new ConflictException(conflict.detail);
    }

    const oldMobile = application.mobile;
    application.mobile = trimmed;
    application.updatedBy = actorUserId;
    const saved = await this.applications.save(application);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_MOBILE_UPDATED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actorUserId,
      remarks: `Mobile number updated from ${oldMobile} to ${trimmed} by HR.`,
    });

    return saved;
  }

  /**
   * Who typed the substance, recorded so approval can refuse them.
   *
   * `createInvite` leaves `createdBy` null — the interview creates the row, nobody has typed
   * anything into it yet — so the maker is stamped on the first desk touch rather than at
   * creation. It is never overwritten: a second clerk finishing somebody else's typing does not
   * take their place as the maker.
   *
   * `deskEditors` is the belt to that brace. With one `createdBy`, clerk A could type most of a
   * form, clerk B one box first, and A would then be free to approve their own work. Every desk
   * account that has touched it is refused approval. The list rides in `extendedProfile`, which
   * `applyExtendedProfile` reads by named group and therefore ignores.
   */
  private stampDeskAuthorship(application: AssayerApplicationEntity, actorUserId: string): void {
    const profile = (application.extendedProfile ?? {}) as Record<string, unknown>;
    const editors = new Set<string>(Array.isArray(profile.deskEditors) ? profile.deskEditors as string[] : []);
    editors.add(actorUserId);
    application.extendedProfile = { ...profile, deskEditors: [...editors] } as never;

    if (application.source === ApplicationSource.HR_DESK) return;
    application.source = ApplicationSource.HR_DESK;
    application.createdBy = actorUserId;
  }

  /**
   * Fold the record-shaped answers into `extendedProfile.fields`, one patch at a time.
   *
   * Merged rather than replaced, because both intake paths save as the person types: a candidate
   * fills identity on one screen and bank on the next, and a replace would drop whichever they
   * filled in first. Filtered on the way in, so the stored object can never hold a key promotion
   * would refuse — the application is not a back door into fields the desk cannot set itself.
   */
  private mergeRecordFields(
    application: AssayerApplicationEntity,
    incoming: Record<string, unknown> | undefined,
  ): void {
    const accepted = pickRegistrationRecordFields(incoming);
    if (Object.keys(accepted).length === 0) return;
    /**
     * Checked here, at the moment it is typed, rather than only when promotion applies it.
     *
     * The same three rules the record enforces — a mistyped PAN refused weeks later, on a screen
     * the candidate cannot see, is a gap nobody can close. Blank clears the field and is allowed:
     * a candidate correcting their own mistake must be able to empty the box.
     */
    /*
      A masked value must never be stored. Staff screens now receive the last four digits, so a form
      that sent back what it was shown would replace a real PAN with "••••234F" — and the number
      would be gone. The screens are built not to, and this is the guarantee that does not depend
      on them.
    */
    const masked = REGISTRATION_SECRET_FIELD_KEYS.filter(
      (key) => typeof accepted[key] === 'string' && looksMasked(accepted[key] as string),
    );
    if (masked.length > 0) {
      throw new BadRequestException(
        'That looks like the masked copy shown on screen rather than the number itself. Type the '
        + 'number in full, or leave the box alone to keep what is on file.',
      );
    }

    const invalid: string[] = [];
    const filled = (v: unknown) => v != null && String(v).trim() !== '';
    // Stored as its digits, so the record, the duplicate check and the passbook comparison all see
    // one spelling of one account. Normalised before judging, so a pasted "1234 5678 9012" passes.
    if (typeof accepted.bankAccountNumber === 'string' && filled(accepted.bankAccountNumber)) {
      accepted.bankAccountNumber = normaliseBankAccountNumber(accepted.bankAccountNumber);
    }
    if (filled(accepted.panNumber) && !isValidPan(accepted.panNumber)) invalid.push('PAN');
    if (filled(accepted.ifscCode) && !isValidIfsc(accepted.ifscCode)) invalid.push('IFSC');
    if (filled(accepted.aadhaarNumber) && !isValidAadhaar(accepted.aadhaarNumber)) invalid.push('Aadhaar');
    if (filled(accepted.bankAccountNumber) && !isBankAccountNumber(String(accepted.bankAccountNumber))) {
      throw new BadRequestException(BANK_ACCOUNT_NUMBER_RULE);
    }
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Check the ${invalid.join(' and ')} — ${invalid.length > 1 ? 'those do' : 'that does'} not look right.`,
      );
    }
    const profile = (application.extendedProfile ?? {}) as Record<string, unknown>;
    const fields = (profile.fields ?? {}) as Record<string, unknown>;
    application.extendedProfile = { ...profile, fields: sealSecretFields({ ...fields, ...accepted }) } as never;
  }

  /**
   * What this application is still missing, seen as the person it will become.
   *
   * Offered to every screen that shows an application so HR can chase a gap while the candidate is
   * still in the conversation, rather than discovering it weeks later when a payout refuses.
   */
  registrationGaps(application: AssayerApplicationEntity): Array<{ key: string; label: string; blocks: string }> {
    return missingRegistrationFields(mergedRegistrationView(application as never))
      .map((f) => ({ key: f.key, label: f.label, blocks: f.blocks }));
  }

  /**
   * The notice as this candidate should see it today.
   *
   * The wording is versioned in `@fapoms/shared`; the grievance contact is whoever holds the post
   * right now, which is a platform setting rather than a constant. If nobody has been named, the
   * notice says so plainly instead of printing a blank line — a data-protection notice that lists
   * no way to complain is worse than one that admits the gap, and the Settings screen flags it.
   */
  async consentNotice(): Promise<ConsentNotice & { grievanceContact: string }> {
    const [name, email, phone] = await Promise.all([
      this.settings.get<string>('dpdp.grievanceOfficerName').catch(() => ''),
      this.settings.get<string>('dpdp.grievanceOfficerEmail').catch(() => ''),
      this.settings.get<string>('dpdp.grievanceOfficerPhone').catch(() => ''),
    ]);
    const parts = [name, email, phone].map((p) => (p ?? '').trim()).filter(Boolean);
    return {
      ...CURRENT_CONSENT_NOTICE,
      grievanceContact: parts.length > 0
        ? parts.join(' · ')
        : 'A grievance officer has not been named yet — write to the office that sent you this link.',
    };
  }

  /**
   * NOTHING IS COLLECTED BEFORE THE PERSON HAS AGREED TO IT.
   *
   * Called by every candidate-facing write: the draft, the documents, the OTP. Consent used to be
   * the last step of the form, which meant the name, PAN, Aadhaar, bank account and every scan were
   * already saved by the time it was asked for — so the tick could not be a decision about whether
   * to hand any of it over. This is what makes the order real rather than a matter of which screen
   * the form happens to show first.
   */
  private assertConsented(application: AssayerApplicationEntity): void {
    if (application.consentWithdrawnAt) {
      throw new BadRequestException(
        'This application was withdrawn, so nothing further can be added to it. If that was a '
        + 'mistake, ask the office that invited you for a fresh link.',
      );
    }
    if (!application.consentAcceptedAt) {
      throw new BadRequestException(
        'Please read what we are asking for and agree to it before filling anything in.',
      );
    }
  }

  async acceptConsent(rawToken: string, consentVersion: string): Promise<AssayerApplicationEntity> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    if (application.consentWithdrawnAt) {
      throw new BadRequestException(
        'This application was withdrawn. Ask the office that invited you for a fresh link.',
      );
    }
    /*
      The version has to be one we actually published. A client that sent anything else — an old
      build still holding the hard-coded "v1", or a hand-made request — would otherwise leave a row
      claiming consent to wording nobody can produce.
    */
    if (consentVersion !== CURRENT_CONSENT_VERSION) {
      throw new BadRequestException(
        'This form is out of date. Reload the page to see the current notice before agreeing.',
      );
    }
    application.consentAcceptedAt = new Date();
    application.consentVersion = consentVersion;
    // The words they saw, kept beside the acceptance — see the column's note.
    application.consentNotice = await this.consentNotice() as unknown as Record<string, unknown>;
    return this.applications.save(application);
  }

  /**
   * TAKING IT BACK.
   *
   * The DPDP Act makes withdrawal as easy as giving consent, and means it: processing stops and
   * what was given is erased. So this deletes the answers and the scans — the files themselves, not
   * just the rows pointing at them — and leaves behind only the fact that somebody applied and
   * withdrew, which is the record that a request was honoured.
   *
   * Refuses once the person has been taken on: an approved candidate is an employee whose record
   * lives on the roster under its own retention rules, and pretending this link can erase that
   * would be a promise the system cannot keep.
   */
  async withdrawConsent(rawToken: string, reason?: string): Promise<AssayerApplicationEntity> {
    const application = await this.findByRawToken(rawToken);
    if (application.status === ApplicationStatus.APPROVED) {
      throw new BadRequestException(
        'This application has already been approved and your record now sits with the office. '
        + 'Write to the grievance officer named in the notice to ask for it to be erased.',
      );
    }
    if (application.consentWithdrawnAt) return application;

    const documents = await this.applicationDocuments.find({ where: { applicationId: application.id } });
    let filesDeleted = 0;
    let filesLeft = 0;
    for (const doc of documents) {
      for (const key of doc.filePaths ?? []) {
        try {
          await this.storage.deleteFile(key);
          filesDeleted++;
        } catch {
          // Storage may already have lost it, or be unreachable. The erasure of the rows still
          // stands, and the orphan sweep is what catches a file left behind.
          filesLeft++;
        }
      }
    }
    if (documents.length > 0) await this.applicationDocuments.remove(documents);

    application.status = ApplicationStatus.WITHDRAWN;
    application.consentWithdrawnAt = new Date();
    application.consentWithdrawalReason = (reason ?? '').trim() || null;
    application.extendedProfile = null;
    application.dateOfBirth = null;
    application.email = null;
    application.address = null;
    await this.applications.save(application);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'REGISTRATION_CONSENT_WITHDRAWN',
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      remarks: `Candidate withdrew consent; answers erased and ${filesDeleted} file(s) deleted`
        + `${filesLeft > 0 ? `, ${filesLeft} could not be deleted and are left to the orphan sweep` : ''}.`,
    });
    this.notificationDispatch.emitSafe({
      type: 'ASSAYER_APPLICATION_WITHDRAWN',
      payload: { applicationId: application.id, candidateName: application.fullName },
    } as never);
    return application;
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /**
   * The candidate attaching a scan on their link.
   *
   * `replace` is the "Replace" button: the new file takes the place of every file already on the
   * requirement, instead of sitting beside them. It used to append whatever the button said, so a
   * candidate fixing a blurred PAN card left the blurred one on the application too and HR read
   * "(2 files)" with no way to know which was meant. Without `replace` it still appends — that is
   * the "add a page" case, both sides of a card or a two-page statement.
   *
   * The files it displaces are deleted from storage once the row no longer points at them — the
   * same order `withdrawConsent` keeps: a failed delete leaves an unreferenced object for the
   * orphan sweep, never a row pointing at nothing.
   */
  async uploadDocument(
    rawToken: string,
    requirement: OnboardingDocument,
    file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
    options: { replace?: boolean } = {},
  ): Promise<AssayerApplicationDocumentEntity> {
    const application = await this.candidateEditableApplication(rawToken);
    if (!Object.values(OnboardingDocument).includes(requirement)) {
      throw new BadRequestException('That is not a recognised document type.');
    }
    assertUploadAllowed({
      contentType: file.mimetype,
      fileName: file.originalname,
      size: file.size,
      allowed: SCAN_UPLOAD_TYPES,
      hint: 'Photograph the document in better light rather than at higher resolution.',
    });
    const { row, displacedKeys } = await this.attachDocumentRow(
      application, requirement, file, options.replace ? 'replace' : 'append',
    );
    await this.clearResubmittedFlag(application, row);
    if (displacedKeys.length > 0) {
      const notDeleted = await this.deleteStoredObjects(displacedKeys);
      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'ASSAYER_APPLICATION_DOCUMENT_REPLACED',
        entityType: 'ASSAYER_APPLICATION',
        entityId: application.id,
        remarks: `${requirement} replaced by the candidate on the registration link: `
          + `${displacedKeys.length} earlier file(s) removed`
          + `${notDeleted > 0 ? `, ${notDeleted} could not be deleted from storage and are left to the orphan sweep` : ''}.`,
        metadata: { requirement, filesReplaced: displacedKeys.length, storageDeleteFailures: notDeleted },
      });
    }
    return row;
  }

  /**
   * The candidate taking one file off a requirement — the wrong photo, a page that should not be
   * there. Until this existed a mistaken upload was permanent from the candidate's side: the only
   * remedy was to ask HR, who could not remove it either.
   *
   * Same gates as the upload (the link, an editable application, consent), because removing is
   * editing. The row is kept even when it empties: it may carry HR's send-back reason, and the
   * candidate still needs to see what was asked for. Answers the row as it now stands.
   */
  async removeDocumentFile(
    rawToken: string,
    requirement: OnboardingDocument,
    index: number,
  ): Promise<AssayerApplicationDocumentEntity> {
    const application = await this.candidateEditableApplication(rawToken);
    if (!Object.values(OnboardingDocument).includes(requirement)) {
      throw new NotFoundException('That document has not been attached.');
    }
    const row = await this.applicationDocuments.findOne({
      where: { applicationId: application.id, requirement },
    });
    const files = row?.filePaths ?? [];
    if (!row || !Number.isInteger(index) || index < 0 || index >= files.length) {
      throw new NotFoundException('That file is not attached, so there is nothing to remove.');
    }
    const key = files[index];
    row.filePaths = files.filter((_, i) => i !== index);
    // The approval was of the set HR saw; with a file gone it no longer describes what is attached.
    if (row.reviewStatus === ApplicationDocumentReviewStatus.APPROVED) {
      row.reviewStatus = ApplicationDocumentReviewStatus.PENDING;
      row.reviewedBy = null;
      row.reviewedAt = null;
    }
    const saved = await this.applicationDocuments.save(row);
    const notDeleted = await this.deleteStoredObjects([key]);
    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_APPLICATION_DOCUMENT_REMOVED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      remarks: `${requirement}: the candidate removed file ${index + 1} of ${files.length} on the registration link`
        + `${notDeleted > 0 ? '; it could not be deleted from storage and is left to the orphan sweep' : ''}.`,
      metadata: { requirement, index, filesRemaining: saved.filePaths?.length ?? 0, storageDeleteFailures: notDeleted },
    });
    return saved;
  }

  /**
   * The gate every candidate write to their documents passes: a live link, an application still in
   * their hands, and the consent the scans are collected under. One place, so upload, replace and
   * remove cannot drift apart on who may change the application.
   */
  private async candidateEditableApplication(rawToken: string): Promise<AssayerApplicationEntity> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    // A scan is the most personal thing this form asks for; it waits for the same agreement.
    this.assertConsented(application);
    return application;
  }

  /**
   * Best-effort deletion of objects no row points at any more. Answers how many could not be
   * deleted: storage may already have lost them or be unreachable, and the orphan sweep is what
   * catches a file left behind — the pattern `withdrawConsent` set.
   */
  private async deleteStoredObjects(keys: string[]): Promise<number> {
    let failed = 0;
    for (const key of keys) {
      try {
        await this.storage.deleteFile(key);
      } catch {
        failed++;
      }
    }
    return failed;
  }

  /**
   * The desk attaching a scan on the candidate's behalf.
   *
   * Same gate, same allow-list, same row as the candidate's own upload — only the key differs:
   * a session instead of a token. Stamps desk authorship for the same reason the draft save does,
   * because attaching somebody's PAN card for them is typing on their behalf.
   */
  async uploadDocumentAsStaff(
    id: string,
    requirement: OnboardingDocument,
    file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
    actorUserId: string,
  ): Promise<AssayerApplicationDocumentEntity> {
    const application = await this.applications.findOne({ where: tenantWhere<AssayerApplicationEntity>({ id }) });
    if (!application) throw new NotFoundException('Application not found.');
    if (application.status === ApplicationStatus.APPROVED || application.status === ApplicationStatus.REJECTED) {
      throw new BadRequestException('This application has already been decided.');
    }
    if (!Object.values(OnboardingDocument).includes(requirement)) {
      throw new BadRequestException('That is not a recognised document type.');
    }
    assertUploadAllowed({
      contentType: file.mimetype,
      fileName: file.originalname,
      size: file.size,
      allowed: SCAN_UPLOAD_TYPES,
      hint: 'Photograph the document in better light rather than at higher resolution.',
    });
    this.stampDeskAuthorship(application, actorUserId);
    await this.applications.save(application);
    const { row } = await this.attachDocumentRow(application, requirement, file, 'append');
    await this.clearResubmittedFlag(application, row);
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_DOCUMENT_ATTACHED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      userId: actorUserId,
      remarks: `${requirement} attached at the HR desk.`,
    });
    return row;
  }

  /**
   * One of a candidate's scans, for the reviewer to actually look at.
   *
   * Nothing could read these bytes. The review screen listed "3 files" and offered no way to open
   * one, so HR approved scans sight unseen — and `approve()` hard-refuses an application with no
   * PHOTOGRAPH, a rule nobody could check the substance of: any file attached under that
   * requirement satisfied it. The desk uploading documents itself makes that worse, not better.
   *
   * Returns the storage key and its type; the controller streams it. Indexed because
   * `filePaths` is an array — a requirement can carry both sides of an Aadhaar card.
   */
  async documentFileKey(
    id: string,
    requirement: OnboardingDocument,
    index: number,
  ): Promise<{ key: string; fileName: string }> {
    const application = await this.applications.findOne({ where: tenantWhere<AssayerApplicationEntity>({ id }) });
    if (!application) throw new NotFoundException('Application not found.');
    const row = await this.applicationDocuments.findOne({ where: { applicationId: id, requirement } });
    const key = row?.filePaths?.[index];
    if (!key) throw new NotFoundException('That document has not been attached.');
    return { key, fileName: key.split('/').pop() ?? `${requirement}-${index}` };
  }

  /**
   * The candidate reading a scan attached to their own application.
   *
   * Token-authorised, so unscoped by tenant: the token proves ownership of the application,
   * matching `uploadDocument` and `findByRawToken`.
   */
  async documentFileKeyForToken(
    rawToken: string,
    requirement: OnboardingDocument,
    index: number,
  ): Promise<{ key: string; fileName: string }> {
    const application = await this.findByRawToken(rawToken);
    // The scans behind a submitted application are the desk's to open, through its own logged-in
    // routes — not anybody's who still holds the link. See `hydrate`.
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new ForbiddenException(
        'This application has been submitted, so its documents can no longer be opened from the '
        + 'registration link. Contact HR if something needs changing.',
      );
    }
    const row = await this.applicationDocuments.findOne({ where: { applicationId: application.id, requirement } });
    const key = row?.filePaths?.[index];
    if (!key) throw new NotFoundException('That document has not been attached.');
    return { key, fileName: key.split('/').pop() ?? `${requirement}-${index}` };
  }

  /** The bytes behind a key from `documentFileKey`. Separated so the controller streams, not this. */
  async openDocumentStream(key: string): Promise<Readable> {
    return this.storage.getFileStream(key);
  }

  /**
   * The storage-and-row half of a document upload, shared by the candidate door (token) and the
   * staff door (session). One implementation, so the two doors cannot drift on what "attached"
   * means — the exact drift that produced four disagreeing upload paths elsewhere.
   *
   * `replace` puts the new file in place of every earlier one and answers the displaced keys, for
   * the caller to delete once this save has landed — never before, or a failed save would leave
   * the row pointing at deleted objects.
   */
  private async attachDocumentRow(
    application: AssayerApplicationEntity,
    requirement: OnboardingDocument,
    file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
    mode: 'append' | 'replace',
  ): Promise<{ row: AssayerApplicationDocumentEntity; displacedKeys: string[] }> {
    const key = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype, file.size);
    const existing = await this.applicationDocuments.findOne({
      where: { applicationId: application.id, requirement },
    });
    const row = existing ?? this.applicationDocuments.create({ applicationId: application.id, requirement, filePaths: [] });
    const earlier = row.filePaths ?? [];
    row.filePaths = mode === 'replace' ? [key] : [...earlier, key];
    const saved = await this.applicationDocuments.save(row);
    return { row: saved, displacedKeys: mode === 'replace' ? earlier.filter((k) => k !== key) : [] };
  }

  /**
   * A fresh scan answers its own send-back: the requirement stops being flagged the moment new
   * bytes land — whether the candidate uploaded them on their link or the desk attached them —
   * and the matching ask leaves the candidate's to-do list. Without this a resubmission would
   * inherit its own rejection and HR's queue would keep demanding what already arrived.
   */
  private async clearResubmittedFlag(
    application: AssayerApplicationEntity,
    row: AssayerApplicationDocumentEntity,
  ): Promise<void> {
    // An approval covers the files HR looked at. New bytes on an approved requirement — possible
    // once an application is sent back for more information and the link reopens — are files HR
    // has not seen, so the requirement goes back to pending rather than keeping a tick it never earned.
    if (
      row.reviewStatus === ApplicationDocumentReviewStatus.NEEDS_RESUBMIT
      || row.reviewStatus === ApplicationDocumentReviewStatus.APPROVED
    ) {
      row.reviewStatus = ApplicationDocumentReviewStatus.PENDING;
      row.rejectionReason = null;
      row.rejectionNote = null;
      row.reviewedBy = null;
      row.reviewedAt = null;
      await this.applicationDocuments.save(row);
    }
    await this.dropInfoRequestItem(application, 'document', row.requirement);
  }

  // ── Submit ───────────────────────────────────────────────────────────────

  /**
   * Where the verification code is actually required, and the only place.
   *
   * It gated every candidate action — typing a name, ticking consent, attaching a scan. That made
   * the code a prerequisite for the form rather than a check on the person submitting it, and it
   * had a consequence nobody intended: on a deployment whose email was switched off, a candidate
   * holding a valid link could not enter a single character. The code is delivered by email to the
   * same mailbox the link arrived in, so gating the typing proved nothing the link had not already
   * proved, while making an undelivered code a total block instead of a last-step block.
   *
   * The link is still the authorisation for everything before this. Nothing is filed, reviewed or
   * promoted until the code confirms the person at the other end.
   */

  /**
   * WHAT THE ROSTER SWEEP WOULD HAVE SAID, SAID NOW.
   *
   * `data-integrity.service.ts` files findings for an impossible age and for a PAN, Aadhaar, bank
   * account or email that already belongs to somebody — but it runs over rows that exist, so the
   * candidate had already registered, been approved and joined the roster before anybody saw it.
   * The same questions are cheap to ask here, at the one moment the answer can still change what
   * happens: the identifiers are fingerprinted columns, and the age is arithmetic.
   *
   * Candidate-safe wording throughout: a clash names no one — whose PAN it is belongs to them.
   */
  private async assertRegistrationIsAcceptable(application: AssayerApplicationEntity): Promise<void> {
    // Opened: the duplicate check fingerprints the NUMBER, so it needs the number.
    const fields = openSecretFields(((application.extendedProfile ?? {}) as Record<string, any>).fields ?? {});

    const dobProblem = dateOfBirthProblem((application.dateOfBirth ?? fields.dateOfBirth) as string | null);
    if (dobProblem) throw new BadRequestException(dobProblem);

    if (!this.assayers || typeof this.assayers.findOne !== 'function') return;
    const where = (extra: Record<string, unknown>) => ({
      isActive: true,
      ...(application.organizationId ? { organizationId: application.organizationId } : {}),
      ...extra,
    }) as never;

    /** Already held by somebody on the roster — except by the record this application itself made. */
    const heldBySomebodyElse = async (clause: Record<string, unknown>): Promise<boolean> => {
      const match = await this.assayers.findOne({ where: where(clause) });
      return !!match && match.id !== application.promotedAssayerId;
    };

    const checks: Array<{ value: unknown; clause: (fp: string) => Record<string, unknown>; label: string }> = [
      { value: fields.panNumber, clause: (fp) => ({ panFingerprint: fp }), label: 'PAN' },
      { value: fields.aadhaarNumber, clause: (fp) => ({ aadhaarFingerprint: fp }), label: 'Aadhaar number' },
    ];
    for (const check of checks) {
      const fingerprint = fieldFingerprint(typeof check.value === 'string' ? check.value : null);
      if (!fingerprint) continue;
      if (await heldBySomebodyElse(check.clause(fingerprint))) {
        throw new ConflictException(
          `That ${check.label} is already registered to somebody on our roster. If it is yours, `
          + 'contact the office — they can sort it out.',
        );
      }
    }

    const email = (application.email ?? '').trim().toLowerCase();
    if (email && await heldBySomebodyElse({ email })) {
      throw new ConflictException(
        'That email address is already registered to somebody on our roster. If it is yours, '
        + 'contact the office — they can sort it out.',
      );
    }
  }

  async submit(rawToken: string): Promise<AssayerApplicationEntity> {
    await this.assertOtpVerified(rawToken);
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application has already been submitted.');
    }
    const conflict = await this.checkMobileConflict(application.mobile, application.organizationId, application.id, application.promotedAssayerId);
    if (conflict) {
      throw new ConflictException(conflict.message);
    }
    if (!application.fullName?.trim()) {
      throw new BadRequestException('Your full name is required before submitting.');
    }
    if (!application.employmentCategory) {
      throw new BadRequestException('Choose Freelancer or Proprietor before submitting.');
    }
    if (!application.consentAcceptedAt) {
      throw new BadRequestException('You must accept the declaration and consent before submitting.');
    }
    // At least one person who can vouch for them, reachable by phone. Checked here rather than
    // at approval because the candidate is the one who knows these people — HR chasing referees
    // the candidate never named is the delay this rule exists to prevent.
    const storedReferences = ((application.extendedProfile ?? {}) as Record<string, unknown>).references;
    const referencesProblem = referenceSubmitProblem(
      Array.isArray(storedReferences) ? storedReferences as never : [],
    );
    if (referencesProblem) {
      throw new BadRequestException(referencesProblem);
    }
    /*
      The documents nobody may file without — the passbook, today. Checked against what is actually
      attached (a row with a file on it), not against the form's own tick, because the form can be
      resumed, reloaded or filled by the desk.
    */
    const attached = await this.applicationDocuments.find({ where: { applicationId: application.id } });
    const missingDocs = REGISTRATION_REQUIRED_DOCUMENTS.filter(
      (req) => !attached.some((d) => d.requirement === req && (d.filePaths?.length ?? 0) > 0),
    );
    if (missingDocs.length > 0) {
      throw new BadRequestException(
        `Upload ${missingDocs.map((d) => ONBOARDING_DOCUMENT_LABELS[d as OnboardingDocument] ?? d).join(' and ')} `
        + 'before submitting — the page showing your name, account number and IFSC. A cancelled '
        + 'cheque or the first page of a bank statement is fine if you have no passbook.',
      );
    }
    /*
      The photograph, which both forms already refuse to submit without. Approval refuses an
      application with no face on it (the ID card cannot be issued), so letting it be filed without
      one only moved the refusal onto HR — who then had to chase the candidate for it. Same test as
      the passbook's: a row with a file on it.
    */
    const hasPhotograph = attached.some(
      (d) => d.requirement === OnboardingDocument.PHOTOGRAPH && (d.filePaths?.length ?? 0) > 0,
    );
    if (!hasPhotograph) {
      throw new BadRequestException(
        `Upload ${ONBOARDING_DOCUMENT_LABELS[OnboardingDocument.PHOTOGRAPH] ?? 'your photograph'} `
        + 'before submitting — a clear photo of your face, for your ID card. A selfie against a '
        + 'plain wall is fine.',
      );
    }
    // The checks that used to arrive as review-queue findings days later.
    await this.assertRegistrationIsAcceptable(application);

    const wasAwaitingInfo = application.status === ApplicationStatus.AWAITING_INFO;
    application.status = ApplicationStatus.PENDING_VALIDATION;
    /*
      Resubmitting settles every field ask: the candidate has had the form in front of them and
      handed it back, and HR now reads the whole thing again — a field they left as it was is their
      answer to that ask, not an item still owed. A document ask stays while its scan is still the
      one that was sent back, because that genuinely is outstanding and HR should see it at once.
    */
    const remainingAsks = readApplicationInfoRequests(application.infoRequests).filter((i) => i.kind === 'document');
    application.infoRequests = (remainingAsks.length > 0 ? remainingAsks : null) as never;
    const saved = await this.applications.save(application);

    const interview = saved.interviewId
      ? await this.interviews.findOne({ where: { id: saved.interviewId } })
      : null;
    const effectiveOrgId = saved.organizationId || interview?.organizationId || null;

    if (!saved.organizationId && effectiveOrgId) {
      saved.organizationId = effectiveOrgId;
      await this.applications.update(saved.id, { organizationId: effectiveOrgId });
    }

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: wasAwaitingInfo ? 'ASSAYER_APPLICATION_RESUBMITTED' : 'ASSAYER_APPLICATION_SUBMITTED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      remarks: `Registration application submitted by ${saved.fullName ?? saved.mobile}.`,
    });

    this.notificationDispatch.emitSafe({
      type: 'ASSAYER_APPLICATION_SUBMITTED',
      payload: {
        applicantName: saved.fullName ?? saved.mobile,
        applicationId: saved.id,
        mobile: saved.mobile,
        email: saved.email ?? undefined,
      },
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      organizationId: effectiveOrgId ?? undefined,
      ownerUserId: interview?.interviewedByUserId ?? undefined,
    });

    if (saved.email) {
      this.emails.queue({
        kind: 'REGISTRATION_SUBMITTED',
        to: saved.email,
        recipientName: saved.fullName || 'Candidate',
        content: {
          layout: {
            title: 'Application Submitted Successfully',
            subtitle: 'Sumeru Global Appraiser Registration',
            badge: { text: 'Application Received', tone: 'emerald' },
            bodyLines: [
              `Hello ${saved.fullName || 'Candidate'},`,
              'Thank you for completing your registration details and uploading your documents.',
              'Your application has been received and is now undergoing review by our operations and HR team.',
              'You will receive an update once your profile and documents have been verified.',
            ],
            securityNotice: 'If you have any questions, please contact your Sumeru Global representative.',
          },
          subject: 'Application Received — Sumeru Global Appraiser Registration',
        },
        entityType: 'ASSAYER_APPLICATION',
        entityId: saved.id,
      }).catch((err) => this.logger.warn(`Could not queue candidate submission confirmation: ${err?.message}`));
    }

    return saved;
  }

  // ── HR review ────────────────────────────────────────────────────────────

  /**
   * `tenantWhere` because this list had no organisation predicate at all: an OPERATIONS user in
   * one organisation was served every other organisation's candidates — names, mobile numbers and
   * email addresses of people who have not been hired anywhere. The rows carry `organizationId`
   * and always did; nothing read it. ADMIN and DEVELOPER still read across by design, which is
   * what `tenantWhere` returning the clause unchanged means for them.
   */
  async listApplications(status?: ApplicationStatus): Promise<AssayerApplicationEntity[]> {
    const rows = await this.applications.find({
      where: tenantWhere<AssayerApplicationEntity>(status ? { status } : {}),
      order: { createdAt: 'DESC' },
    });
    // Masked: a queue of candidates is not a reason to hand out everybody's PAN and bank account.
    return rows.map((row) => maskApplication(row));
  }

  /**
   * Everything the reviewer needs in front of them to decide.
   *
   * It used to return the application row and its documents, and the row type on the screen did
   * not even carry `extendedProfile` — so the person approving could not see the PAN, the bank
   * details or the emergency contact they were approving. `gaps` was computed by a method with no
   * callers whose own docblock claimed it was "offered to every screen that shows an application".
   *
   * `invitedMobile` is the number HR typed at the interview, shown beside the number the candidate
   * confirmed. The candidate's answer wins — they know their own number — but a mismatch should be
   * somebody's decision rather than a silent overwrite.
   */
  async getApplication(id: string): Promise<{
    application: AssayerApplicationEntity;
    documents: AssayerApplicationDocumentEntity[];
    gaps: Array<{ key: string; label: string; blocks: string }>;
    invitedMobile: string | null;
    /**
     * Which scans this candidate is asked for, given the employment category they chose. The
     * candidate's own door has always been handed this by `hydrate`; the desk needs the same list
     * to fill the form in for them, and the reviewer needs it to see what is still outstanding.
     */
    documentsRequested: OnboardingDocument[];
    phoneConflict: { message: string; assayerCode?: string; displayName?: string } | null;
    /**
     * Lifted out of `extendedProfile` because this return is a projection, not the row.
     *
     * `listApplications` returns entities, so the queue already sees the stamp; a reviewer opening
     * one saw only `interviewId: null`, which reads as a data gap rather than as a decision
     * somebody made and signed. Null for every candidate who came through an interview.
     */
    openedWithoutInterview: OpenedWithoutInterviewStamp | null;
    /**
     * What happened at the interview, for the person deciding the application.
     *
     * The interviewer's notes were written down every time and shown on no screen: this method
     * already loaded the interview row, and read one field off it — the mobile. A reviewer
     * approving somebody could not see that the interviewer had written "could not tell 22K from
     * 18K on the touchstone", and had to go and ask. Null when nobody interviewed them.
     */
    interview: InterviewSummary | null;
    /**
     * Exactly what HR ticked the last time they asked for more — one entry per document or
     * field, each with its own instruction. The review drawer renders this as the outstanding
     * checklist, so a second reviewer sees what was already asked instead of asking it again.
     */
    infoRequests: ApplicationInfoRequestItem[];
  }> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    const documents = await this.applicationDocuments.find({ where: { applicationId: id } });

    let invitedMobile: string | null = null;
    let interviewSummary: InterviewSummary | null = null;
    if (application.interviewId) {
      const interview = await this.interviews.findOne({ where: { id: application.interviewId } });
      invitedMobile = interview?.mobile ?? null;
      if (interview) {
        // The attempt before, when they passed only on being interviewed again — the reviewer
        // should know the first one did not go their way, and be able to read why.
        const earlier = interview.previousInterviewId
          ? await this.interviews.findOne({ where: { id: interview.previousInterviewId } })
          : null;
        interviewSummary = {
          id: interview.id,
          outcome: interview.outcome,
          notes: interview.notes ?? null,
          interviewedAt: interview.interviewedAt,
          interviewedByName: interview.interviewedByName ?? null,
          attachments: interview.attachments ?? [],
          earlier: earlier
            ? {
              id: earlier.id, outcome: earlier.outcome, notes: earlier.notes ?? null,
              interviewedAt: earlier.interviewedAt, interviewedByName: earlier.interviewedByName ?? null,
              attachments: earlier.attachments ?? [],
            }
            : null,
        };
      }
    }

    const conflict = await this.checkMobileConflict(application.mobile, application.organizationId, application.id, application.promotedAssayerId);

    return {
      // Masked: the reviewer needs to see WHICH numbers are on file and that they are well-formed,
      // not the numbers themselves. The record's own audited reveal exists for the rare case.
      application: maskApplication(application),
      documents,
      gaps: this.registrationGaps(application),
      invitedMobile: invitedMobile === application.mobile ? null : invitedMobile,
      interview: interviewSummary,
      documentsRequested: [...documentsRequestedFor(application.employmentCategory)],
      phoneConflict: conflict
        // The desk's copy names the person: a clerk cannot act on "somebody else".
        ? { message: conflict.detail, assayerCode: conflict.assayerCode, displayName: conflict.displayName }
        : null,
      openedWithoutInterview: readOpenedWithoutInterview(application),
      infoRequests: readApplicationInfoRequests(application.infoRequests),
    };
  }

  private async mustBeReviewable(id: string): Promise<AssayerApplicationEntity> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    if (APPLICATION_TERMINAL_STATUSES.includes(application.status)) {
      throw new BadRequestException('This application has already been decided.');
    }
    return application;
  }

  async reject(id: string, actorUserId: string, reason: string): Promise<AssayerApplicationEntity> {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to reject an application.');
    }
    const application = await this.mustBeReviewable(id);
    application.status = ApplicationStatus.REJECTED;
    application.reviewedBy = actorUserId;
    application.reviewedAt = new Date();
    application.reviewNotes = reason.trim();
    const saved = await this.applications.save(application);

    if (saved.email) {
      await this.emails.queue({
        kind: 'APPLICATION_REJECTED',
        to: saved.email,
        content: {
          template: 'application-rejected',
          data: {
            fullName: saved.fullName || 'Candidate',
            // For the built-in letter: a plain "Hello," when there is no name, not "Hello Candidate,".
            greeting: saved.fullName ? `Hello ${saved.fullName},` : 'Hello,',
            reviewNotes: saved.reviewNotes || 'Does not meet minimum criteria at this time.',
            supportEmail: 'recruitment@sumeruglobal.com',
            logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
            companyName: 'Sumeru Global',
          },
        },
        entityType: 'ASSAYER_APPLICATION',
        entityId: saved.id,
        requestedBy: actorUserId,
      });
    }
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_REJECTED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actorUserId,
      remarks: saved.reviewNotes ?? undefined,
    });
    return saved;
  }

  /**
   * Keep the candidate's SAME link usable: extend its expiry rather than minting a new token.
   *
   * Rotating the token on every request-for-info is what broke resubmission — the link the
   * candidate already holds (or has open in a tab) stopped working at exactly the moment they
   * were asked to use it. The token stays a bearer credential with an expiry; this just gives
   * it a fresh window from the moment HR asks for more.
   */
  private async ensureInviteUsable(application: AssayerApplicationEntity): Promise<void> {
    const expiryHours = await this.settings.getNumber('registration.inviteExpiryHours', 72);
    const freshUntil = Date.now() + expiryHours * 60 * 60 * 1000;
    if (!application.tokenExpiresAt || application.tokenExpiresAt.getTime() < freshUntil) {
      application.tokenExpiresAt = new Date(freshUntil);
    }
  }

  /**
   * Tell the candidate exactly what HR ticked — one line per document or field — without any
   * link in it. The candidate reopens the link they already hold; there is no raw token left
   * to embed (only its hash was ever stored), and minting a new one would kill the old link.
   */
  private async sendInfoRequestedEmail(
    application: AssayerApplicationEntity,
    items: ApplicationInfoRequestItem[],
    overallNote: string | null,
    actorUserId: string,
  ): Promise<void> {
    if (!application.email) return;
    const lines = items.map((item) => `• ${item.label}: ${item.message}`);
    if (overallNote) lines.push(`Note from HR: ${overallNote}`);
    await this.emails.queue({
      kind: 'APPLICATION_INFO_REQUESTED',
      to: application.email,
      content: {
        template: 'application-info-requested',
        data: {
          fullName: application.fullName || 'Candidate',
          greeting: application.fullName ? `Hello ${application.fullName},` : 'Hello,',
          itemsText: lines.join('\n'),
          supportEmail: 'recruitment@sumeruglobal.com',
          logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
          companyName: 'Sumeru Global',
        },
      },
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      requestedBy: actorUserId,
    });
  }

  /** Drop one resolved ask from the stored to-do list (a doc re-uploaded, a field corrected). */
  private async dropInfoRequestItem(
    application: AssayerApplicationEntity,
    kind: 'document' | 'field',
    key: string,
  ): Promise<void> {
    const existing = readApplicationInfoRequests(application.infoRequests);
    if (!existing.some((item) => item.kind === kind && item.key === key)) return;
    application.infoRequests = existing.filter(
      (item) => !(item.kind === kind && item.key === key),
    ) as unknown as Array<Record<string, unknown>>;
    await this.applications.save(application);
  }

  /**
   * HR's verdict on ONE document requirement inside a hiring application.
   *
   * Approving records that the scans were actually looked at. Sending back flags the requirement
   * (`NEEDS_RESUBMIT` with a structured reason) and reopens the candidate's SAME link as
   * `AWAITING_INFO` with that item on their to-do list — one blurry scan no longer costs a whole
   * application rejection, and a missing requirement can be asked for the same way (a row with no
   * scans yet is created to carry the verdict).
   */
  async reviewApplicationDocument(
    id: string,
    requirement: OnboardingDocument,
    decision: 'APPROVED' | 'NEEDS_RESUBMIT',
    opts: { reason?: string; note?: string },
    actorUserId: string,
  ): Promise<AssayerApplicationDocumentEntity> {
    const application = await this.mustBeReviewable(id);
    if (!Object.values(OnboardingDocument).includes(requirement)) {
      throw new BadRequestException('That is not a recognised document type.');
    }
    if (decision !== 'APPROVED' && decision !== 'NEEDS_RESUBMIT') {
      throw new BadRequestException('Decision must be APPROVED or NEEDS_RESUBMIT.');
    }
    let row = await this.applicationDocuments.findOne({ where: { applicationId: id, requirement } });
    if (decision === 'APPROVED') {
      if (!row || (row.filePaths ?? []).length === 0) {
        throw new BadRequestException('There is no scan to approve for this document yet.');
      }
      row.reviewStatus = ApplicationDocumentReviewStatus.APPROVED;
      row.rejectionReason = null;
      row.rejectionNote = null;
      row.reviewedBy = actorUserId;
      row.reviewedAt = new Date();
      const saved = await this.applicationDocuments.save(row);
      await this.dropInfoRequestItem(application, 'document', requirement);
      await this.auditService.recordEventSafe({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_APPLICATION_DOCUMENT_APPROVED',
        entityType: 'ASSAYER_APPLICATION',
        entityId: application.id,
        userId: actorUserId,
        remarks: `${requirement} scans approved.`,
      });
      return saved;
    }

    const reason = opts.reason?.trim() || null;
    if (reason && !isValidRejectionReason(reason)) {
      throw new BadRequestException('That is not a recognised send-back reason.');
    }
    const note = opts.note?.trim() || '';
    if (note.length > 1000) {
      throw new BadRequestException('Keep the send-back note under 1000 characters.');
    }
    const guidance = reason ? DOCUMENT_REJECTION_GUIDANCE[reason as DocumentRejectionReason] : '';
    const message = note || guidance || 'Please re-upload a clear scan of this document.';
    row ??= this.applicationDocuments.create({ applicationId: id, requirement, filePaths: [] });
    row.reviewStatus = ApplicationDocumentReviewStatus.NEEDS_RESUBMIT;
    row.rejectionReason = reason;
    row.rejectionNote = note || null;
    row.reviewedBy = actorUserId;
    row.reviewedAt = new Date();
    const saved = await this.applicationDocuments.save(row);

    const item: ApplicationInfoRequestItem = {
      kind: 'document',
      key: requirement,
      label: ONBOARDING_DOCUMENT_LABELS[requirement] ?? requirement,
      message,
      reason,
    };
    application.status = ApplicationStatus.AWAITING_INFO;
    application.reviewedBy = actorUserId;
    application.reviewedAt = new Date();
    application.infoRequests = mergeInfoRequestItems(
      readApplicationInfoRequests(application.infoRequests), [item],
    ) as unknown as Array<Record<string, unknown>>;
    await this.ensureInviteUsable(application);
    await this.applications.save(application);

    await this.sendInfoRequestedEmail(application, [item], null, actorUserId);
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_DOCUMENT_SENT_BACK',
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      userId: actorUserId,
      remarks: `${item.label} sent back: ${message}`,
    });
    return saved;
  }

  /**
   * Ask the candidate for exactly what is needed — ticked documents and fields, each with its
   * own instruction — on the SAME link they already hold.
   *
   * Accepts the old plain-string call as `{notes}`. At least one of an overall note, a document
   * or a field is required; a request that names nothing real is refused by `buildInfoRequestItems`
   * rather than reopening the link with an empty checklist.
   */
  async requestMoreInfo(
    id: string,
    actorUserId: string,
    notesOrInput: string | StructuredInfoRequestInput,
  ): Promise<AssayerApplicationEntity> {
    const input: StructuredInfoRequestInput =
      typeof notesOrInput === 'string' ? { notes: notesOrInput } : (notesOrInput ?? {});
    const overallNote = input.notes?.trim() || '';
    const items = buildInfoRequestItems(input);
    if (!overallNote && items.length === 0) {
      throw new BadRequestException('Say what is needed from the candidate before requesting more information.');
    }
    const application = await this.mustBeReviewable(id);
    application.status = ApplicationStatus.AWAITING_INFO;
    application.reviewedBy = actorUserId;
    application.reviewedAt = new Date();
    application.reviewNotes = overallNote || items.map((item) => `${item.label}: ${item.message}`).join('\n');
    application.infoRequests = mergeInfoRequestItems(
      readApplicationInfoRequests(application.infoRequests), items,
    ) as unknown as Array<Record<string, unknown>>;

    for (const item of items) {
      if (item.kind !== 'document') continue;
      const requirement = item.key as OnboardingDocument;
      const existing = await this.applicationDocuments.findOne({ where: { applicationId: id, requirement } });
      const row = existing
        ?? this.applicationDocuments.create({ applicationId: id, requirement, filePaths: [] });
      row.reviewStatus = ApplicationDocumentReviewStatus.NEEDS_RESUBMIT;
      row.rejectionReason = item.reason ?? null;
      row.rejectionNote = null;
      row.reviewedBy = actorUserId;
      row.reviewedAt = new Date();
      await this.applicationDocuments.save(row);
    }

    // The SAME link, given a fresh window — see `ensureInviteUsable` for why no new token.
    await this.ensureInviteUsable(application);
    const saved = await this.applications.save(application);

    await this.sendInfoRequestedEmail(saved, items, overallNote || null, actorUserId);
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_INFO_REQUESTED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actorUserId,
      remarks: saved.reviewNotes ?? undefined,
    });
    return saved;
  }

  /**
   * Apply what the wizard collected beyond the application's own columns, AFTER the person is
   * real — through the same guarded services the wizard used to call directly, so nothing here
   * invents a second write path.
   *
   * Deliberately per-group and forgiving: the approval already happened, the person exists, and
   * a bank field the roster rejects must not undo their promotion. Each failure becomes a named
   * gap in the approval's audit remarks — visible, actionable on the record, and nothing lost.
   */
  private async applyExtendedProfile(
    assayerId: string,
    application: AssayerApplicationEntity,
    actorUserId: string,
  ): Promise<{ gaps: string[]; failedGroups: string[] }> {
    // Opened: the record's own columns encrypt these again on the way in. Promotion is one of the
    // three places the plaintext is genuinely needed — see `sealSecretFields`.
    const profile = openProfile(application.extendedProfile as Record<string, unknown> | null) as {
      fields?: Record<string, unknown>;
      commercial?: Record<string, unknown>;
      references?: Array<Record<string, unknown>>;
      empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
      sourceReferral?: SourceReferral | null;
    } | null;
    if (!profile) return { gaps: [], failedGroups: [] };

    const gaps: string[] = [];
    /** Which groups did NOT land, so approval knows what it may clear from the application. */
    const failedGroups: string[] = [];

    if (profile.fields && Object.keys(profile.fields).length > 0) {
      const fields = { ...profile.fields };
      if (fields.latitude === '' || fields.latitude === null) delete fields.latitude;
      if (fields.longitude === '' || fields.longitude === null) delete fields.longitude;

      /*
        ONE REFUSAL USED TO EMPTY THE WHOLE RECORD.

        Every field went to a single `update`, which validates as it goes. A PAN already on
        somebody else, an IFSC that does not exist, a district that contradicts the pincode — any
        one of them threw, the catch below swallowed it into one line, and NOTHING landed: not the
        Aadhaar, not the bank account, not the emergency contact, not the qualification. Approval
        still completed, so the person arrived on the roster empty, and the onboarding drawer
        asked the desk for all of it again — data the candidate had already typed in.

        Applied a group at a time (`REGISTRATION_FIELD_GROUPS`, whose boundaries are the sets the
        update genuinely validates together), a refusal costs its own group and names it, and the
        rest of what they told us arrives.
      */
      for (const group of groupRegistrationRecordFields(fields)) {
        try {
          await this.assayerService.update(assayerId, group.values as never, actorUserId);
        } catch (err: any) {
          gaps.push(`${group.label} (${err?.message ?? 'refused'})`);
          failedGroups.push(group.name);
        }
      }
    }

    if (profile.commercial && Object.keys(profile.commercial).length > 0) {
      try {
        /**
         * `createCommercialProfile` requires an effective-start date — the wizard always sends
         * one, and `new Date(undefined)` is an Invalid Date that Postgres refuses as
         * "0NaN-NaN-NaN…". Found by this method's own gap-naming on its first live run. The
         * rates take effect on the day of approval unless the application said otherwise, which
         * is also the honest date: nothing was in force before the person existed.
         */
        const commercial = {
          effectiveStartDate: businessTodayDateKey(),
          ...(profile.commercial as Record<string, unknown>),
        };
        await this.assayerService.createCommercialProfile(assayerId, commercial as never, actorUserId);
      } catch (err: any) {
        gaps.push(`commercial rates (${err?.message ?? 'refused'})`);
      }
    }

    // Who referred them, kept as whoever recorded it — HR's entry stays HR's, the candidate's theirs.
    if (profile.sourceReferral) {
      try {
        await this.assayerService.setSourceReferral(
          assayerId, profile.sourceReferral, actorUserId, profile.sourceReferral.recordedBy ?? 'HR',
        );
      } catch (err: any) {
        gaps.push(`who referred them (${err?.message ?? 'refused'})`);
      }
    }

    for (const reference of profile.references ?? []) {
      try {
        await this.rosterRecords.saveReference(assayerId, reference as never, actorUserId);
      } catch (err: any) {
        // `fullName` — the key every door stores. This read `.name`, which no reference has ever
        // carried, so the desk was told "reference  (refused)" with the one useful word missing.
        gaps.push(`reference ${(reference as { fullName?: string }).fullName ?? ''} (${err?.message ?? 'refused'})`);
      }
    }

    for (const emp of profile.empanelments ?? []) {
      try {
        // A first standing on a fresh record — the guarded upsert path, no expectedVersion needed
        // for a row that does not exist yet.
        await this.rosterRecords.setEmpanelment(
          assayerId, emp.clientId,
          { status: emp.status as never, statusReason: emp.statusReason },
          actorUserId,
        );
      } catch (err: any) {
        gaps.push(`empanelment for client ${emp.clientId} (${err?.message ?? 'refused'})`);
      }
    }

    return { gaps, failedGroups };
  }

  /**
   * ONE APPROVAL OF AN APPLICATION AT A TIME.
   *
   * Promotion is a chain of separate commits — create the person, re-home each scan, apply the
   * profile a group at a time, set the terms, close the application — and nothing stopped two of
   * them running together: a second click after a slow first one, or the web client giving up at
   * 30 s and retrying while the first request was still working. `create` answered the second with
   * the same person (its idempotency key is the application id), but everything after it ran
   * twice: every scan filed again as a new document version, every profile group applied again.
   *
   * So the first thing an approval does is claim the application, and a caller that cannot claim
   * it is told so rather than queued behind it. The claim is a transaction-scoped advisory lock
   * keyed on the application id, held for the whole promotion:
   *  - only one caller can hold it, on any API instance, because Postgres arbitrates;
   *  - the transaction ending releases it, whether the promotion finished or threw part way, and
   *    so does the connection closing if the process dies — there is no stale claim for the desk
   *    to wait out and no marker column to clear;
   *  - it needs no new application status that every screen would have to learn.
   *
   * The application is read AFTER the claim is taken (`promote` does it), never before: a caller
   * that loaded it first could be holding a PENDING copy of a row the previous approval has just
   * closed.
   *
   * The lock's transaction writes nothing — the promotion's own writes commit as they always did.
   * Its cost is one pooled connection held for the promotion's length, which is part of why the
   * geocoding that made this take seconds now happens afterwards. Should that connection be reaped
   * anyway (`idle_in_transaction_session_timeout`) the claim lapses early, and the idempotent
   * create and scan attach are the backstop; a promotion that did finish is not then reported as a
   * failure merely because the empty transaction could not commit.
   */
  async approve(
    id: string,
    actorUserId: string,
    actorRoles: string[] | undefined,
    organizationId?: string | null,
    input?: ApproveApplicationInput,
  ): Promise<{ assayer: AssayerEntity; gaps: string[] }> {
    let promoted = null as { assayer: AssayerEntity; gaps: string[] } | null;
    try {
      await this.uow.run(async (manager) => {
        const rows: Array<{ claimed: boolean }> = await manager.query(
          'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS claimed',
          [APPROVAL_CLAIM_NAMESPACE, id],
        );
        if (!rows?.[0]?.claimed) {
          throw new ConflictException(
            'This application is already being approved — somebody pressed Approve on it a moment '
            + 'ago and it is still going through. Wait a few seconds and reopen it rather than '
            + 'approving it again.',
          );
        }
        promoted = await this.promote(id, actorUserId, actorRoles, organizationId, input);
      });
    } catch (err) {
      if (!promoted) throw err;
      this.logger.warn(
        `Application ${id} was approved, but its approval claim did not release cleanly: ${(err as Error)?.message ?? err}`,
      );
    }
    return promoted as { assayer: AssayerEntity; gaps: string[] };
  }

  /**
   * Approving is the moment the person is hired, so it is the moment the terms are set.
   *
   * The reviewer could previously add NOTHING. The drawer was read-only, the call carried no body,
   * and this method took no patch — so a `joiningDate`, which is a critical record field, was
   * collected by no form anywhere and every promoted person landed with it blank. The reviewer had
   * to remember to open the new record afterwards and fill in the half the candidate could not
   * supply, and nothing told them to.
   *
   * Three kinds of thing arrive here, and they are kept apart on purpose:
   *  - `corrections` — record fields the candidate answered and got wrong. Filtered by the same
   *    registration allow-list their own form is filtered by.
   *  - `terms` — what only the desk decides. A separate list, so a candidate cannot set their own
   *    joining date by putting one in their form.
   *  - `commercial` / `empanelments` — the rate card and the first client standings. These feed
   *    branches `applyExtendedProfile` has always had and nothing could reach.
   *
   * Called only by `approve`, while it holds the application's claim.
   */
  private async promote(
    id: string,
    actorUserId: string,
    actorRoles: string[] | undefined,
    organizationId?: string | null,
    input?: ApproveApplicationInput,
  ): Promise<{ assayer: AssayerEntity; gaps: string[] }> {
    const application = await this.mustBeReviewable(id);

    /**
     * A candidate who has not filed cannot be hired.
     *
     * `mustBeReviewable` refuses only a DECIDED application, so a DRAFT — somebody mid-form, who
     * has not accepted the declaration and has not confirmed the code — could be approved straight
     * out of the queue. Found by running the journey against the live server: an application the
     * candidate had never submitted promoted cleanly to `AS0122`. That routes around both of
     * `submit()`'s checks at once, and the consent is the one with a compliance life of its own.
     *
     * `AWAITING_INFO` stays approvable: HR asked for more, and deciding to proceed without it is a
     * judgement they are allowed to make. `DRAFT` is not a judgement, it is an unfinished form.
     */
    if (application.status === ApplicationStatus.DRAFT) {
      throw new BadRequestException(
        'This candidate has not submitted their application yet — they have not accepted the '
        + 'declaration or confirmed their code. Ask them to finish it, or use Request info to '
        + 'prompt them.',
      );
    }
    /*
      A withdrawn application cannot be approved into a person. They took their consent back, we
      erased what they gave us, and promoting the empty shell that remains would both contradict
      the request and create a roster record with nothing in it.
    */
    if (application.status === ApplicationStatus.WITHDRAWN) {
      throw new BadRequestException(
        'This candidate withdrew their application and their details were erased. If they want to '
        + 'go ahead after all, invite them again with a fresh link.',
      );
    }

    /**
     * Maker–checker, before anything is read or merged.
     *
     * Deliberately the first thing after the DRAFT check and before `mergeRecordFields` below,
     * which mutates the entity in place and can itself throw on a bad PAN. A reviewer who may not
     * act at all should be told that, not handed a validation error about the correction they were
     * making while doing something they were never allowed to do.
     *
     * Only a desk-typed application has a maker: a candidate's own work has none on staff, so the
     * HR user who sent the invite reviews it freely. `createdBy` is null on every application the
     * interview created, which is why it is tested rather than assumed.
     *
     * `deskEditors` catches the case a single `createdBy` cannot: two clerks sharing the typing,
     * where whoever touched the form second would otherwise be free to approve the first one's
     * work.
     */
    const deskEditors = Array.isArray((application.extendedProfile as Record<string, unknown> | null)?.deskEditors)
      ? ((application.extendedProfile as Record<string, unknown>).deskEditors as string[])
      : [];
    if (application.source === ApplicationSource.HR_DESK
      && (application.createdBy === actorUserId || deskEditors.includes(actorUserId))) {
      await this.auditService.recordEventSafe({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_APPLICATION_APPROVAL_REFUSED',
        entityType: 'ASSAYER_APPLICATION',
        entityId: application.id,
        userId: actorUserId,
        remarks: 'Maker–checker: the account that entered this application tried to approve it.',
      });
      throw withCode(
        new ForbiddenException(
          'You filled this application in, so somebody else has to approve it. Ask another '
          + 'authorised HR user to review it — the same rule that keeps one person from booking '
          + 'and approving the same payment.',
        ),
        ASSAYER_ERROR_CODES.APPLICATION_MAKER_CHECKER,
      );
    }

    // Folded into the application BEFORE promotion so the existing applier handles them, rather
    // than a second write path that would have to be kept in step with the first.
    this.mergeRecordFields(application, input?.corrections);
    if (input?.corrections) {
      const correctedMobile = (input.corrections.mobile || input.corrections.phone) as string | undefined;
      if (typeof correctedMobile === 'string' && correctedMobile.trim()) {
        application.mobile = correctedMobile.trim();
      }
    }
    if (input?.commercial || input?.empanelments) {
      const profile = (application.extendedProfile ?? {}) as Record<string, unknown>;
      if (input.commercial) profile.commercial = input.commercial;
      if (input.empanelments) profile.empanelments = input.empanelments;
      application.extendedProfile = profile as never;
    }

    const documents = await this.applicationDocuments.find({ where: { applicationId: id } });

    /**
     * The one refusal at approval.
     *
     * Everything else about an incomplete application is promoted and chased afterwards — the
     * owner's decision, and the right one: a person who cannot yet be paid can still be trained
     * and vetted. A photograph is different because the artefact it feeds is an identity card
     * shown at a bank's security desk, and one with no face on it is not an identity card. The
     * card printed "Photo unavailable" for everyone who joined this way.
     */
    const hasPhotograph = documents.some(
      (d) => d.requirement === OnboardingDocument.PHOTOGRAPH && (d.filePaths?.length ?? 0) > 0,
    );
    if (!hasPhotograph) {
      throw new BadRequestException(
        'This application has no photograph. Ask the candidate for one — their ID card cannot be '
        + 'issued without it, and a field card with no face on it is not an identity card.',
      );
    }

    const notesParts = [
      application.expertise ? `Expertise: ${application.expertise}.` : null,
      application.availability ? `Availability: ${application.availability}.` : null,
    ].filter((v): v is string => Boolean(v));

    const profile = (application.extendedProfile ?? null) as {
      fields?: Record<string, unknown>;
      commercial?: Record<string, unknown>;
      references?: Array<Record<string, unknown>>;
      empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
    } | null;

    const latRaw = profile?.fields?.latitude;
    const lngRaw = profile?.fields?.longitude;
    const suppliedLat = latRaw != null && latRaw !== '' ? Number(latRaw) : undefined;
    const suppliedLng = lngRaw != null && lngRaw !== '' ? Number(lngRaw) : undefined;
    const district = (profile?.fields?.district as string | undefined) ?? undefined;

    const createDto: CreateAssayerDto = {
      /**
       * The application id IS the idempotency key.
       *
       * Approval is four steps — create the person, re-home their scans, apply the profile and the
       * terms, then mark the application approved — and only the last one closes it. A failure in
       * the middle left a real assayer on the roster with a consumed code and an application still
       * pending, so the reviewer pressed Approve again and got a SECOND person, or a hard refusal
       * naming a duplicate they had never knowingly created. `AssayerService.create` has carried
       * an idempotency path for exactly this since it was written, and nothing passed it a key.
       */
      clientRequestId: `application:${application.id}`,
      fullName: application.fullName ?? undefined,
      phone: application.mobile,
      email: application.email ?? undefined,
      address: application.address ?? undefined,
      // `state` is the one geography field CreateAssayerDto requires — the profile form makes it
      // mandatory before submit for exactly this reason, but a defensive fallback here means an
      // application that somehow lacks it does not crash the promotion.
      state: application.state || 'Unknown',
      district,
      city: application.city ?? undefined,
      pincode: application.pincode ?? undefined,
      latitude: Number.isFinite(suppliedLat) ? suppliedLat : undefined,
      longitude: Number.isFinite(suppliedLng) ? suppliedLng : undefined,
      // `dateOfBirth` on a `type: 'date'` column round-trips as a plain 'YYYY-MM-DD' string from
      // the driver, not a `Date` — same duality `AssayerEntity.dateOfBirth` has. Handle both
      // rather than assume one, since `CreateAssayerDto.dateOfBirth` wants the ISO string form.
      dateOfBirth: application.dateOfBirth
        ? (application.dateOfBirth instanceof Date
          ? businessDateKey(application.dateOfBirth)
          : String(application.dateOfBirth))
        : undefined,
      gender: application.gender ?? undefined,
      currentEmployer: application.currentEmployer ?? undefined,
      employmentCategory: application.employmentCategory ?? undefined,
      experienceYears: application.experienceYears ?? undefined,
      notes: notesParts.length ? notesParts.join(' ') : undefined,
      allowSharedContact: input?.allowSharedContact,
      sharedContactReason: input?.sharedContactReason,
    };

    // The same, ungated `create()` the HR-desk wizard uses — allocates the assayer code, runs the
    // duplicate checks, opens the record at INVITED. It does not touch documents or the
    // photograph write-through; that is the explicit re-homing loop just below.
    const assayer = await this.assayerService.create(createDto, actorUserId, application.organizationId ?? organizationId, actorRoles);

    /**
     * A hired candidate skips INVITED and starts at document verification.
     *
     * INVITED means "on the roster, nothing reviewed yet" — true for somebody the desk typed in
     * directly, but not for a candidate HR just reviewed, asked, and approved through the hiring
     * queue (including per-document send-backs). Landing them at INVITED asked the desk to verify
     * the same scans twice: once implicitly to leave INVITED, once at document verification.
     * The hop is guarded rather than assumed so a retried promotion (same idempotency key, person
     * already moved on) does not fail on a transition that already happened.
     */
    if (assayer.lifecycleStatus === AssayerLifecycleStatus.INVITED) {
      await this.assayerService.verifyDocuments(assayer.id, actorUserId);
    }

    /**
     * The declaration follows the person.
     *
     * Submitting is refused without it, and it was then left behind on a row whose purpose ends at
     * approval — so the one artefact with a compliance life of its own did not survive the
     * boundary. Written directly rather than through `update()` because it is not something a
     * human may edit: it records what this candidate agreed to and when, and correcting it later
     * would be rewriting the agreement.
     */
    if (application.consentAcceptedAt) {
      await this.assayers.update(assayer.id, {
        consentAcceptedAt: application.consentAcceptedAt,
        consentVersion: application.consentVersion ?? null,
      } as never);
    }

    for (const doc of documents) {
      for (const key of doc.filePaths ?? []) {
        await this.rosterRecords.attachFile(assayer.id, doc.requirement, key, actorUserId);
      }
    }

    const { gaps: profileGaps, failedGroups } = await this.applyExtendedProfile(assayer.id, application, actorUserId);

    /**
     * The desk's own half, applied through the same guarded update the record screen uses.
     *
     * Separate from the extended profile because these are not the candidate's answers and must
     * not travel on the list their form is filtered by. A failure is a NAMED gap rather than a
     * failed approval: the person is hired either way, and a missing joining date is chased on the
     * record, not by refusing to create them.
     */
    const terms = pickEmploymentTermFields(input?.terms);
    if (Object.keys(terms).length > 0) {
      try {
        await this.assayerService.update(assayer.id, terms as never, actorUserId);
      } catch (err: any) {
        profileGaps.push(`employment terms (${err?.message ?? 'refused'})`);
      }
    }

    application.status = ApplicationStatus.APPROVED;
    application.reviewedBy = actorUserId;
    application.reviewedAt = new Date();
    application.promotedAssayerId = assayer.id;
    /*
      THE APPLICATION STOPS BEING A SECOND COPY OF THEIR IDENTITY.

      Once the record holds a number, the application has no further use for it: nothing reads these
      keys after promotion, and an approved application kept them for ever — three of them were
      still sitting in the live database. Only what actually landed is cleared; a group the record
      refused (a duplicate PAN, say) stays here, because otherwise the number would be gone from
      both places and the desk would have to ask the person for it again.
    */
    clearAppliedSecrets(application, failedGroups);
    // The to-do list died with the decision: every ask was either answered or judged.
    application.infoRequests = null;
    await this.applications.save(application);

    /**
     * Their home is placed now, off this request.
     *
     * `create` no longer walks the free geocoders inline (see the note there), so a person with no
     * pin arrives unplaced and is handed to the precision worker — which only ever improves a
     * coordinate and never touches a hand-placed one. Handed over here, after every write above,
     * rather than straight after `create`: the worker saves the whole row, and running it while the
     * profile groups were still landing could put back the empty values they had just replaced.
     *
     * Not awaited, as the roster import does not await it: the call swallows its own failures, but
     * a queue add against a Redis that is down can sit waiting for the reconnect, and an approval
     * must not wait with it. The nightly assayer sweep picks the person up if the hand-off is lost.
     */
    if (needsBetterFix(assayer.geoSource ?? null, assayer.geoAccuracyMeters ?? null)) {
      void this.geoPrecision.enqueueBackfill('assayer', [assayer.id], `application ${application.id} approved`);
    }

    /**
     * THE MOMENT THEY ARE HIRED IS THE MOMENT THEY GET A KEY.
     *
     * Approval used to mint nobody anything. It created the person at `INVITED` — a stage that is
     * deliberately allowed to sign in, confined to finishing their own registration — and then
     * emailed them a button reading "Sign in to FAPOMS". The account behind that button had
     * `passwordHash = NULL`, so `AuthService.login` answered with the same bare `Invalid
     * credentials` a mistyped password gets. The candidate had no way to tell the two apart, would
     * reasonably keep trying, and after five attempts tripped the account alert. Nothing anywhere
     * told HR that a person was sitting there waiting for a credential that no step produced.
     *
     * The same `issueAndDeliverAppAccess` the bulk tool drives: the password is generated, hashed,
     * stored with `mustChangePassword`, audited, and queued to whichever of their email and phone
     * is on file. Not a separate copy of any of that.
     *
     * Failures here never fail the approval. The person is hired either way, and a mail server
     * being down is not a reason to refuse a hiring decision — so an empty `channels` is written
     * to the audit trail as a named follow-up instead.
     */
    let accessChannels: ('EMAIL' | 'SMS')[] = [];
    try {
      const delivery = await this.assayerService.issueAndDeliverAppAccess(assayer, actorUserId);
      accessChannels = delivery.channels;
    } catch (err) {
      this.logger.warn(
        `Application ${application.id} was approved but app access could not be issued: ${(err as Error)?.message ?? err}`,
      );
    }
    if (accessChannels.length === 0) {
      profileGaps.push('app access (nothing could be sent — issue it from their record)');
    }

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_APPROVED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: application.id,
      userId: actorUserId,
      remarks: profileGaps.length === 0
        ? `Promoted to assayer ${assayer.assayerCode}.`
        : `Promoted to assayer ${assayer.assayerCode}. Profile partially applied — fix on the record: ${profileGaps.join('; ')}.`,
    });
    this.notificationDispatch.emitSafe({
      type: 'ASSAYER_CODE_ISSUED',
      payload: { assayerName: assayer.displayName, assayerCode: assayer.assayerCode },
      assayerId: assayer.id,
      entityType: 'ASSAYER',
      entityId: assayer.id,
    });

    if (application.email) {
      const name = application.fullName || assayer.displayName || 'Appraiser';
      /*
        Queued, not sent here: approving was the one step a reviewer waited on the mail server for.

        This letter no longer points at the web login. An appraiser has no surface there at all —
        their work is the phone app — so the button is the app download, and the letter says their
        sign-in details are following separately rather than inviting them to sign in with a
        credential this message does not carry.

        The profile gaps are NOT in this letter. They are the record's own refusal messages (an
        empanelment "for client <id>", say), written for the desk, which reads them on the audit row
        above. Neither the shipped HTML nor the built-in letter ever showed them to the candidate.
      */
      await this.emails.queue({
        kind: 'APPLICATION_APPROVED',
        to: application.email,
        content: {
          template: 'application-approved',
          data: {
            assayerCode: assayer.assayerCode,
            // The stable link Caddy serves at `/download/app.apk` — one address to hand a field
            // appraiser, which survives every rebuild of the APK behind it.
            appDownloadUrl: `${appPublicUrl()}/download/app.apk`,
            logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
            candidateName: name,
            // The shipped HTML greets and names the person by `fullName`.
            fullName: name,
            displayName: assayer.displayName || name,
            companyName: 'Sumeru Global',
          },
        },
        entityType: 'ASSAYER_APPLICATION',
        entityId: application.id,
        requestedBy: actorUserId,
      });
    }

    /**
     * The referees hear now — the moment they became references FOR somebody, which is when HR's
     * call to them becomes possible (the record's "Spoken to" lives here, not on the application).
     * After the approval letter, because the candidate should not learn their referees were
     * contacted before learning they were hired. Each referee's outcome is recorded on their own
     * row for the record to show; nothing here can refuse the hire.
     */
    try {
      await this.rosterRecords.notifyUntoldReferees(assayer.id, actorUserId);
    } catch (err) {
      this.logger.warn(`Application ${application.id} approved, but its referees could not be told: ${(err as Error)?.message ?? err}`);
    }

    return { assayer, gaps: profileGaps };
  }
}

/**
 * What the audit trail says about an invite's delivery at the moment it is queued.
 *
 * It cannot say "emailed" any more — the send happens after this row is written — and it must not
 * pretend to. The outbound email's own row records whether it went, and its id is on the event.
 */
function inviteDeliveryRemark(email: OutboundMessageReceipt | null, address: string | null | undefined): string {
  if (!address) return 'there is no email address on this application, so the link was handed to the desk.';
  if (!email || email.status === 'NOT_QUEUED') {
    return `the invite email to ${address} could not be queued, so the link was handed to the desk.`;
  }
  return `the invite email to ${address} was queued, and the link was also handed to the desk.`;
}

/** An interview as the application review shows it: the verdict, the notes and the test papers. */
export interface InterviewSummary {
  id: string;
  outcome: string;
  notes: string | null;
  interviewedAt: Date;
  interviewedByName: string | null;
  attachments: InterviewAttachment[];
  /** The interview that did not pass before this one, when there was one. */
  earlier?: Omit<InterviewSummary, 'earlier'> | null;
}
