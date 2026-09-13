import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
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
  pickEmploymentTermFields,
  mergedRegistrationView,
  missingRegistrationFields,
  isValidPan,
  isValidIfsc,
  isValidAadhaar,
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
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { hashCode, numericCode, hashesEqual } from '../auth/otp-codes';
import { assertUploadAllowed, SCAN_UPLOAD_TYPES } from '../document/upload-validation';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { tenantWhere } from '../../infrastructure/tenancy/ambient-tenant-context';
import type { Readable } from 'stream';

const TOKEN_BYTES = 32;
const OTP_TTL_SECONDS = 300;
const OTP_VERIFIED_TTL_SECONDS = 24 * 60 * 60;
const OTP_SEND_WINDOW_SECONDS = 60 * 60;
const OTP_SEND_MAX_PER_WINDOW = 5;

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
    const result = await this.emailProvider.send({
      to: application.email,
      subject: 'Your Appraiser registration link',
      text: `${greeting}\n\n${intro}\n\n${link}`,
      html: renderEmailHtml({
        title: 'Complete your registration',
        bodyLines: [greeting, intro],
        linkUrl: link,
        linkLabel: 'Continue registration',
      }),
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
  }> {
    const application = await this.findByRawToken(rawToken);
    if (!application.tokenConsumedAt) {
      application.tokenConsumedAt = new Date();
      await this.applications.save(application);
    }
    const documents = await this.applicationDocuments.find({ where: { applicationId: application.id } });
    return { application, documents, documentsRequested: documentsRequestedFor(application.employmentCategory) };
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
    if (!application.email) {
      throw new BadRequestException(
        'There is no email address on this application to send a code to. Ask HR to add one and resend your link.',
      );
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

    const result = await this.emailProvider.send({
      to: application.email,
      subject: 'Your Appraiser registration code',
      text: `Your Appraiser registration verification code is ${code}. It expires in 5 minutes.`,
      html: renderEmailHtml({
        title: 'Your registration code',
        bodyLines: [
          `Your verification code is ${code}.`,
          'It expires in 5 minutes. If you did not ask for it, you can ignore this message.',
        ],
      }),
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

  // ── Draft ────────────────────────────────────────────────────────────────

  async updateDraft(rawToken: string, patch: UpdateApplicationDraftDto): Promise<AssayerApplicationEntity> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    this.applyDraftPatch(application, patch);
    return this.applications.save(application);
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
      (application as unknown as Record<string, unknown>)[key] =
        key === 'dateOfBirth' && typeof incoming === 'string' ? new Date(incoming) : incoming;
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
    application.extendedProfile = { ...profile, fields: { ...fields, ...accepted } } as never;
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

  async acceptConsent(rawToken: string, consentVersion: string): Promise<AssayerApplicationEntity> {
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    application.consentAcceptedAt = new Date();
    application.consentVersion = consentVersion;
    return this.applications.save(application);
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
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException(
        'This application has already been submitted. Use Request more information to ask for a '
        + 'different document.',
      );
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
  async submit(rawToken: string): Promise<AssayerApplicationEntity> {
    await this.assertOtpVerified(rawToken);
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application has already been submitted.');
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
    return this.applications.find({
      where: tenantWhere<AssayerApplicationEntity>(status ? { status } : {}),
      order: { createdAt: 'DESC' },
    });
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
  }> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    const documents = await this.applicationDocuments.find({ where: { applicationId: id } });

    let invitedMobile: string | null = null;
    if (application.interviewId) {
      const interview = await this.interviews.findOne({ where: { id: application.interviewId } });
      invitedMobile = interview?.mobile ?? null;
    }

    return {
      application,
      documents,
      gaps: this.registrationGaps(application),
      invitedMobile: invitedMobile === application.mobile ? null : invitedMobile,
      documentsRequested: [...documentsRequestedFor(application.employmentCategory)],
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
      await this.emailProvider.send({
        to: saved.email,
        subject: 'Your Appraiser application',
        text: `${greeting}\n\nAfter review, we are unable to proceed with your application at this time.\n\nReason: ${saved.reviewNotes}`,
        html: renderEmailHtml({
          title: 'Your application decision',
          bodyLines: [
            greeting,
            'After review, we are unable to proceed with your application at this time.',
            `Reason: ${saved.reviewNotes}`,
          ],
        }),
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
  ): Promise<string[]> {
    const profile = (application.extendedProfile ?? null) as {
      fields?: Record<string, unknown>;
      commercial?: Record<string, unknown>;
      references?: Array<Record<string, unknown>>;
      empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
    } | null;
    if (!profile) return [];

    const gaps: string[] = [];

    if (profile.fields && Object.keys(profile.fields).length > 0) {
      try {
        await this.assayerService.update(assayerId, profile.fields as never, actorUserId);
      } catch (err: any) {
        gaps.push(`profile fields (${err?.message ?? 'refused'})`);
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

    return gaps;
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
      city: application.city ?? undefined,
      pincode: application.pincode ?? undefined,
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

    const profileGaps = await this.applyExtendedProfile(assayer.id, application, actorUserId);

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
      await this.emailProvider.send({
        to: application.email,
        subject: 'Your Appraiser application has been approved',
        text: `${greeting}\n\nYour application has been approved. Your Appraiser code is ${assayer.assayerCode}. HR will be in touch about next steps.`,
        html: renderEmailHtml({
          title: 'Application approved',
          bodyLines: [
            greeting,
            'Your application has been approved.',
            `Your Appraiser code is ${assayer.assayerCode}.`,
            'HR will be in touch about next steps.',
          ],
        }),
      });
    }

    return { assayer, gaps: profileGaps };
  }
}
