import {
  Injectable, Inject, Logger, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import {
  EventCategory,
  ApplicationStatus,
  APPLICATION_TERMINAL_STATUSES,
  applicationIsEditableByCandidate,
  EmploymentCategory,
  OnboardingDocument,
  ApplicationSource,
  ASSAYER_ERROR_CODES,
  pickRegistrationRecordFields,
  groupRegistrationRecordFields,
  REGISTRATION_SECRET_FIELD_KEYS,
  CURRENT_CONSENT_NOTICE,
  CURRENT_CONSENT_VERSION,
  consentNoticeFor,
  type ConsentNotice,
  REGISTRATION_FIELD_GROUPS,
  maskRegistrationFields,
  looksMasked,
  pickEmploymentTermFields,
  mergedRegistrationView,
  missingRegistrationFields,
  isValidPan,
  isValidIfsc,
  isValidAadhaar,
  normalisePhone,
  dateOfBirthProblem,
  maskTail,
} from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { AssayerApplicationEntity } from './assayer-application.entity';
import { AssayerApplicationDocumentEntity } from './assayer-application-document.entity';
import { AssayerInterviewEntity } from './assayer-interview.entity';
import { AssayerEntity } from './assayer.entity';
import { AssayerService, CreateAssayerDto } from './assayer.service';
import { RosterRecordsService } from './roster-records.service';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EmailProvider, appPublicUrl, renderEmailHtml } from '../../infrastructure/notifications/email-provider';
import { EmailTemplateRenderer } from '../../infrastructure/notifications/email-template-renderer';
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

/**
 * The floor on the reason for admitting a candidate no interview ever saw.
 *
 * Matched by `OpenWithoutInterviewDto`'s `@MinLength(10)` so a caller that skips the controller
 * meets the same bar. Ten characters is not a judgement of quality — nothing can be — it is the
 * length at which "ok", "walk in" and a stray keypress stop qualifying as a recorded decision.
 */
const MIN_NO_INTERVIEW_REASON_LENGTH = 10;

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
    private readonly emailProvider: EmailProvider,
    private readonly cache: CacheService,
    private readonly settings: PlatformSettingsService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    @Optional() private readonly templateRenderer?: EmailTemplateRenderer,
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
   * Returns whether the link actually went out — callers must not assume it did.
   *
   * `EmailProvider.send` never throws; it answers `{ success: false }` when the transport is off
   * or the send failed. Discarding that answer is how the HR screen came to say "an invite has
   * been emailed to …" purely because an address existed, while a deployment with email switched
   * off sent nothing at all. An invite nobody receives is the whole flow stalled with no signal.
   */
  private async sendInviteEmail(
    application: AssayerApplicationEntity,
    rawToken: string,
    intro: string,
  ): Promise<boolean> {
    if (!application.email) return false;
    const link = this.inviteLink(rawToken);
    const greeting = application.fullName ? `Hello ${application.fullName},` : 'Hello,';
    let subject = 'Your Appraiser registration link';
    let text = `${greeting}\n\n${intro}\n\n${link}`;
    let html = renderEmailHtml({
      title: 'Complete Your Registration',
      bodyLines: [
        greeting,
        intro,
        'Click the button below to complete your profile and upload verification documents from your phone or computer.',
      ],
      linkUrl: link,
      linkLabel: 'Complete Registration',
      securityNotice: 'This registration link is personalized for you. Do not forward or share it.',
    });

    if (this.templateRenderer) {
      try {
        const rendered = await this.templateRenderer.render('registration-invite', {
          fullName: application.fullName || 'Candidate',
          inviteUrl: link,
          logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
          companyName: 'Sumeru Global',
        });
        subject = rendered.subject;
        text = rendered.text;
        html = rendered.html;
      } catch (err: any) {
        this.logger.warn(`Template render failed for registration-invite: ${err.message}`);
      }
    }

    const result = await this.emailProvider.send({
      to: application.email,
      subject,
      text,
      html,
    });
    if (!result?.success) {
      this.logger.warn(
        `Registration invite for application ${application.id} was NOT delivered to ${application.email}: `
        + `${result?.error ?? 'email transport reported no success'}`,
      );
    }
    return !!result?.success;
  }

  private static readonly INVITE_INTRO = 'Use the link below to complete your Appraiser '
    + 'registration — from your phone or any computer, no app required.';

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
      where: { mobile: trimmed, ...(organizationId ? { organizationId } : {}) },
      order: { createdAt: 'DESC' },
    });
    return found.find((a) => !APPLICATION_TERMINAL_STATUSES.includes(a.status)) ?? null;
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
            ...(organizationId ? { organizationId } : {}),
          } as any,
        });
        if (match && (!excludeApplicationId || match.id !== excludeApplicationId)
          && match.status !== ApplicationStatus.REJECTED) {
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
    });
    const rawToken = await this.mintToken(application);
    const saved = manager
      ? await manager.save(AssayerApplicationEntity, application)
      : await this.applications.save(application);
    return { application: saved, rawToken };
  }

  /**
   * Deliver a minted link, and say whether it actually went.
   *
   * Called after the transaction that created the row has committed. `emailed` is reported rather
   * than assumed, so the interview screen can say what happened instead of announcing a delivery
   * on the strength of an address being present.
   */
  async deliverInvite(
    application: AssayerApplicationEntity,
    rawToken: string,
  ): Promise<{ emailed: boolean; inviteLink: string }> {
    const emailed = await this.sendInviteEmail(application, rawToken, RegistrationApplicationService.INVITE_INTRO);
    return { emailed, inviteLink: this.inviteLink(rawToken) };
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
  }): Promise<{ application: AssayerApplicationEntity; emailed: boolean; inviteLink: string }> {
    const { application, rawToken } = await this.createInviteRecord(input);
    const { emailed, inviteLink } = await this.deliverInvite(application, rawToken);
    return { application, emailed, inviteLink };
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
    input: { fullName: string; mobile: string; email?: string | null; reason: string },
    actor: { id: string; name?: string | null; organizationId?: string | null },
  ): Promise<{ applicationId: string; emailed: boolean; inviteLink: string }> {
    const fullName = (input.fullName ?? '').trim();
    const mobile = (input.mobile ?? '').trim();
    const reason = (input.reason ?? '').trim();
    if (!fullName) throw new BadRequestException('Candidate name is required.');
    if (!mobile) throw new BadRequestException('Mobile number is required.');
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

    const { emailed, inviteLink } = await this.deliverInvite(saved, rawToken);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_OPENED_WITHOUT_INTERVIEW',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actor.id,
      remarks: `${fullName} was added to the hiring pipeline with no interview on record, by `
        + `${stamp.byName ?? actor.id}. Reason: ${reason} — the invite was `
        + `${emailed ? 'emailed' : 'minted and handed to the desk'}.`,
    });

    // `emailed` is reported rather than assumed, and the link comes back either way, so the desk
    // can read it out when the send did not happen — the same contract the interview path has.
    return { applicationId: saved.id, emailed, inviteLink };
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
   * It mints a new token rather than re-sending the old one, for the same reason `requestMoreInfo`
   * does: only the hash was ever stored, so the original raw token no longer exists anywhere.
   */
  async resendInvite(id: string, actorUserId: string): Promise<{ application: AssayerApplicationEntity; emailed: boolean; inviteLink: string }> {
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
    const emailed = await this.sendInviteEmail(
      saved,
      rawToken,
      'Here is a fresh link to complete your Appraiser registration. Any earlier link has stopped working.',
    );
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_APPLICATION_INVITE_RESENT',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      userId: actorUserId,
      remarks: emailed
        ? `Fresh link sent to ${saved.email}.`
        : saved.email
          ? `Fresh link generated but delivery to ${saved.email} failed — it was handed to the desk instead.`
          : 'Fresh link generated and handed to the desk; there is no email address on this application.',
    });
    return { application: saved, emailed, inviteLink: this.inviteLink(rawToken) };
  }

  // ── Token resolution ─────────────────────────────────────────────────────

  private async findByRawToken(rawToken: string): Promise<AssayerApplicationEntity> {
    const tokenHash = hashCode(rawToken);
    const application = await this.applications.findOne({ where: { tokenHash } });
    if (!application) {
      throw new NotFoundException('This registration link is not valid. Ask HR to resend it.');
    }
    if (!application.tokenExpiresAt || application.tokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This registration link has expired. Ask HR to resend it.');
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
  }> {
    const application = await this.findByRawToken(rawToken);
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
    };
  }

  // ── OTP ──────────────────────────────────────────────────────────────────

  /**
   * Send the candidate a verification code, by email.
   *
   * Email is the delivery channel for everything that reaches a candidate or an assayer here —
   * the owner's decision, and the only one that works: MSG91 is unconfigured
   * (`SMS_PROVIDER_API_KEY` is blank in `.env.production.example` and absent from `.env.docker`),
   * so an SMS-only code meant nobody could finish registering at all.
   *
   * What that costs, stated plainly because it is a real reduction: the invite link already
   * arrived in this mailbox, so a code sent to the same mailbox proves the same thing the link
   * did. It confirms the person holding the link is the person invited; it does NOT verify the
   * mobile number the way an SMS would. The number is still captured and still bound to the code
   * below, so the record gets it — but it is captured on trust, not proven. Wiring MSG91 is what
   * would make this a second factor again.
   */
  async requestOtp(rawToken: string, phone: string): Promise<void> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    // A code is a message to a real phone number: nothing is sent before they have agreed.
    this.assertConsented(application);
    if (!application.email) {
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

    const cooldownSeconds = await this.settings.getNumber('registration.otpResendCooldownSeconds', 60);
    const lastSentKey = `regotp:lastsent:${tokenHash}`;
    const lastSentAt = await this.cache.getJson<number>(lastSentKey);
    if (lastSentAt && Date.now() - lastSentAt < cooldownSeconds * 1000) {
      throw new BadRequestException('Please wait before requesting another code.');
    }

    const code = numericCode(6);
    await this.cache.setJson(`regotp:code:${tokenHash}`, { hash: hashCode(code), phone }, OTP_TTL_SECONDS);
    await this.cache.setJson(sendCounterKey, { count: sent + 1 }, OTP_SEND_WINDOW_SECONDS);
    await this.cache.setJson(lastSentKey, Date.now(), OTP_SEND_WINDOW_SECONDS);

    let subject = 'Your Appraiser registration code';
    let text = `Your Appraiser registration verification code is ${code}. It expires in 5 minutes.`;
    let html = renderEmailHtml({
      title: 'Verification Code',
      bodyLines: [
        'Please enter the 6-digit code below to verify your email address and continue your Sumeru Global appraiser registration.',
      ],
      otpCode: code,
      securityNotice: 'This code expires in 5 minutes. If you did not request this, you can safely ignore this email.',
    });

    if (this.templateRenderer) {
      try {
        const rendered = await this.templateRenderer.render('otp-verification', {
          otpCode: code,
          validMinutes: '5',
          logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
          supportEmail: 'recruitment@sumeruglobal.com',
          companyName: 'Sumeru Global',
        });
        subject = rendered.subject;
        text = rendered.text;
        html = rendered.html;
      } catch (err: any) {
        this.logger.warn(`Template render failed for otp-verification: ${err.message}`);
      }
    }

    const result = await this.emailProvider.send({
      to: application.email,
      subject,
      text,
      html,
    });
    /**
     * A code that was never sent is a dead end, so say so instead of answering "sent".
     *
     * `EmailProvider.send` answers `{ success: false }` — it does not throw — when the transport
     * is off or the send fails. This route used to log that and return success, so the candidate
     * read that a code was on its way and waited for a message nobody had sent.
     */
    if (!result?.success) {
      this.logger.warn(
        `Registration OTP email to ${application.email} failed for token ${tokenHash.slice(0, 8)}…: `
        + `${result?.error ?? 'email transport reported no success'}`,
      );
      throw new BadRequestException(
        'We could not email you a verification code just now. Contact HR — they can help you finish registering.',
      );
    }
  }

  async verifyOtp(rawToken: string, phone: string, code: string): Promise<void> {
    const tokenHash = hashCode(rawToken);
    const pending = await this.cache.getJson<{ hash: string; phone: string }>(`regotp:code:${tokenHash}`);
    if (!pending || pending.phone !== phone || !hashesEqual(pending.hash, hashCode(code))) {
      throw new BadRequestException('That code is incorrect or has expired.');
    }
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
    this.applyDraftPatch(application, patch);
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
  private applyDraftPatch(application: AssayerApplicationEntity, patch: UpdateApplicationDraftDto): void {
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
    this.applyDraftPatch(application, patch);

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
    if (patch.references !== undefined) profile.references = patch.references;
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
    if (filled(accepted.panNumber) && !isValidPan(accepted.panNumber)) invalid.push('PAN');
    if (filled(accepted.ifscCode) && !isValidIfsc(accepted.ifscCode)) invalid.push('IFSC');
    if (filled(accepted.aadhaarNumber) && !isValidAadhaar(accepted.aadhaarNumber)) invalid.push('Aadhaar');
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

  async uploadDocument(
    rawToken: string,
    requirement: OnboardingDocument,
    file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
  ): Promise<AssayerApplicationDocumentEntity> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    // A scan is the most personal thing this form asks for; it waits for the same agreement.
    this.assertConsented(application);
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
    return this.attachDocumentRow(application, requirement, file);
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
    const row = await this.attachDocumentRow(application, requirement, file);
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
   */
  private async attachDocumentRow(
    application: AssayerApplicationEntity,
    requirement: OnboardingDocument,
    file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
  ): Promise<AssayerApplicationDocumentEntity> {
    const key = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype, file.size);
    const existing = await this.applicationDocuments.findOne({
      where: { applicationId: application.id, requirement },
    });
    const row = existing ?? this.applicationDocuments.create({ applicationId: application.id, requirement, filePaths: [] });
    row.filePaths = [...(row.filePaths ?? []), key];
    return this.applicationDocuments.save(row);
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
    // The checks that used to arrive as review-queue findings days later.
    await this.assertRegistrationIsAcceptable(application);

    const wasAwaitingInfo = application.status === ApplicationStatus.AWAITING_INFO;
    application.status = ApplicationStatus.PENDING_VALIDATION;
    const saved = await this.applications.save(application);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: wasAwaitingInfo ? 'ASSAYER_APPLICATION_RESUBMITTED' : 'ASSAYER_APPLICATION_SUBMITTED',
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
      remarks: `Registration application submitted by ${saved.fullName ?? saved.mobile}.`,
    });
    this.notificationDispatch.emitSafe({
      type: 'ASSAYER_APPLICATION_SUBMITTED',
      payload: { applicantName: saved.fullName ?? saved.mobile },
      entityType: 'ASSAYER_APPLICATION',
      entityId: saved.id,
    });
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
    interview: {
      outcome: string;
      notes: string | null;
      interviewedAt: Date;
      interviewedByName: string | null;
    } | null;
  }> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    const documents = await this.applicationDocuments.find({ where: { applicationId: id } });

    let invitedMobile: string | null = null;
    let interviewSummary: {
      outcome: string; notes: string | null; interviewedAt: Date; interviewedByName: string | null;
    } | null = null;
    if (application.interviewId) {
      const interview = await this.interviews.findOne({ where: { id: application.interviewId } });
      invitedMobile = interview?.mobile ?? null;
      if (interview) {
        interviewSummary = {
          outcome: interview.outcome,
          notes: interview.notes ?? null,
          interviewedAt: interview.interviewedAt,
          interviewedByName: interview.interviewedByName ?? null,
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
      const greeting = saved.fullName ? `Hello ${saved.fullName},` : 'Hello,';
      let subject = 'Your Appraiser application';
      let text = `${greeting}\n\nAfter review, we are unable to proceed with your application at this time.\n\nReason: ${saved.reviewNotes}`;
      let html = renderEmailHtml({
        title: 'Application Status Update',
        bodyLines: [
          greeting,
          'Thank you for your interest in joining Sumeru Global. After reviewing your application dossier and submitted credentials, our verification committee is unable to proceed with your onboarding at this time.',
        ],
        callout: {
          title: 'Review Remarks',
          text: saved.reviewNotes || 'Does not meet minimum criteria at this time.',
          tone: 'crimson',
        },
        footer: 'Questions regarding this decision may be directed to recruitment@sumeruglobal.com.',
      });

      if (this.templateRenderer) {
        try {
          const rendered = await this.templateRenderer.render('application-rejected', {
            fullName: saved.fullName || 'Candidate',
            reviewNotes: saved.reviewNotes || 'Does not meet minimum criteria at this time.',
            supportEmail: 'recruitment@sumeruglobal.com',
            logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
            companyName: 'Sumeru Global',
          });
          subject = rendered.subject;
          text = rendered.text;
          html = rendered.html;
        } catch (err: any) {
          this.logger.warn(`Template render failed for application-rejected: ${err.message}`);
        }
      }

      await this.emailProvider.send({
        to: saved.email,
        subject,
        text,
        html,
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

  async requestMoreInfo(id: string, actorUserId: string, notes: string): Promise<AssayerApplicationEntity> {
    if (!notes?.trim()) {
      throw new BadRequestException('Say what is needed from the candidate before requesting more information.');
    }
    const application = await this.mustBeReviewable(id);
    application.status = ApplicationStatus.AWAITING_INFO;
    application.reviewedBy = actorUserId;
    application.reviewedAt = new Date();
    application.reviewNotes = notes.trim();
    // A fresh link, not a resend of the old one — only the token's hash was ever stored, and
    // rotating it on every request-for-info is the more secure choice anyway.
    const rawToken = await this.mintToken(application);
    const saved = await this.applications.save(application);

    await this.sendInviteEmail(
      saved,
      rawToken,
      `HR needs something more before your application can proceed: ${saved.reviewNotes}\n\nUse the link below to continue where you left off.`,
    );
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
          effectiveStartDate: new Date().toISOString().slice(0, 10),
          ...(profile.commercial as Record<string, unknown>),
        };
        await this.assayerService.createCommercialProfile(assayerId, commercial as never, actorUserId);
      } catch (err: any) {
        gaps.push(`commercial rates (${err?.message ?? 'refused'})`);
      }
    }

    for (const reference of profile.references ?? []) {
      try {
        await this.rosterRecords.saveReference(assayerId, reference as never, actorUserId);
      } catch (err: any) {
        gaps.push(`reference ${(reference as { name?: string }).name ?? ''} (${err?.message ?? 'refused'})`);
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
   */
  async approve(
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
          ? application.dateOfBirth.toISOString().slice(0, 10)
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
    await this.applications.save(application);

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
      const greeting = application.fullName ? `Hello ${application.fullName},` : 'Hello,';
      let subject = 'Your Appraiser application has been approved';
      let text = `${greeting}\n\nYour application has been approved. Your Appraiser code is ${assayer.assayerCode}. HR will be in touch about next steps.`;
      let html = renderEmailHtml({
        title: 'Application Approved — Welcome to Sumeru Global',
        bodyLines: [
          greeting,
          'Congratulations! Your application has been approved. You have been officially registered as an authorized Appraiser in our network.',
          'Our operations team will be in touch shortly regarding branch roster assignments and field audit schedules.',
        ],
        kvTable: [
          { label: 'Official Appraiser Code', value: assayer.assayerCode },
          { label: 'Registered Name', value: assayer.displayName || application.fullName || '—' },
          { label: 'Status', value: 'Active Roster Ready' },
        ],
        linkUrl: appPublicUrl(),
        linkLabel: 'Sign in to FAPOMS',
        securityNotice: `Keep your Appraiser code (${assayer.assayerCode}) confidential. It is required during bank branch audit verification.`,
      });

      if (this.templateRenderer) {
        try {
          const rendered = await this.templateRenderer.render('application-approved', {
            assayerCode: assayer.assayerCode,
            loginUrl: appPublicUrl(),
            logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
            candidateName: application.fullName || assayer.displayName || 'Appraiser',
            remarks: profileGaps.length ? `Note: ${profileGaps.join('; ')}` : '',
            companyName: 'Sumeru Global',
          });
          subject = rendered.subject;
          text = rendered.text;
          html = rendered.html;
        } catch (err: any) {
          this.logger.warn(`Template render failed for application-approved: ${err.message}`);
        }
      }

      await this.emailProvider.send({
        to: application.email,
        subject,
        text,
        html,
      });
    }

    return { assayer, gaps: profileGaps };
  }
}
