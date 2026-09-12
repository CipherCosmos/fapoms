import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import {
  EventCategory,
  ApplicationStatus,
  APPLICATION_TERMINAL_STATUSES,
  applicationIsEditableByCandidate,
  EmploymentCategory,
  OnboardingDocument,
} from '@fapoms/shared';
import { AssayerApplicationEntity } from './assayer-application.entity';
import { AssayerApplicationDocumentEntity } from './assayer-application-document.entity';
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
] as const;

export interface UpdateApplicationDraftDto {
  fullName?: string;
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
    const link = `${appPublicUrl()}/register/${rawToken}`;
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

  /**
   * Called by `AssayerInterviewService` on a PASS outcome.
   *
   * `emailed` is reported rather than assumed, so the interview screen can say what actually
   * happened instead of announcing a delivery on the strength of an address being present.
   */
  async createInvite(input: {
    interviewId?: string | null;
    fullName?: string | null;
    mobile: string;
    email?: string | null;
    organizationId?: string | null;
  }): Promise<{ application: AssayerApplicationEntity; emailed: boolean }> {
    const application = this.applications.create({
      interviewId: input.interviewId ?? null,
      fullName: input.fullName ?? null,
      mobile: input.mobile,
      email: input.email ?? null,
      organizationId: input.organizationId ?? null,
      status: ApplicationStatus.DRAFT,
    });
    const rawToken = await this.mintToken(application);
    const saved = await this.applications.save(application);
    const emailed = await this.sendInviteEmail(
      saved,
      rawToken,
      'Use the link below to complete your Appraiser registration — from your phone or any computer, no app required.',
    );
    return { application: saved, emailed };
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
  async resendInvite(id: string, actorUserId: string): Promise<{ application: AssayerApplicationEntity; emailed: boolean }> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    if (APPLICATION_TERMINAL_STATUSES.includes(application.status)) {
      throw new BadRequestException('This application has already been decided — there is nothing left to complete.');
    }
    if (!application.email) {
      throw new BadRequestException('There is no email address on this application to send a link to.');
    }

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
      remarks: emailed ? `Fresh link sent to ${saved.email}.` : `Fresh link generated but delivery to ${saved.email} failed.`,
    });
    return { application: saved, emailed };
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
  }

  private async assertOtpVerified(rawToken: string): Promise<void> {
    const verified = await this.cache.getJson(`regotp:verified:${hashCode(rawToken)}`);
    if (!verified) {
      throw new ForbiddenException('Verify your mobile number before continuing.');
    }
  }

  // ── Draft ────────────────────────────────────────────────────────────────

  async updateDraft(rawToken: string, patch: UpdateApplicationDraftDto): Promise<AssayerApplicationEntity> {
    await this.assertOtpVerified(rawToken);
    const application = await this.findByRawToken(rawToken);
    if (!applicationIsEditableByCandidate(application.status)) {
      throw new BadRequestException('This application is no longer editable.');
    }
    for (const key of EDITABLE_DRAFT_FIELDS) {
      const incoming = (patch as Record<string, unknown>)[key];
      if (incoming === undefined) continue;
      (application as unknown as Record<string, unknown>)[key] =
        key === 'dateOfBirth' && typeof incoming === 'string' ? new Date(incoming) : incoming;
    }
    return this.applications.save(application);
  }

  async acceptConsent(rawToken: string, consentVersion: string): Promise<AssayerApplicationEntity> {
    await this.assertOtpVerified(rawToken);
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
    await this.assertOtpVerified(rawToken);
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
    const key = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype, file.size);
    const existing = await this.applicationDocuments.findOne({
      where: { applicationId: application.id, requirement },
    });
    const row = existing ?? this.applicationDocuments.create({ applicationId: application.id, requirement, filePaths: [] });
    row.filePaths = [...(row.filePaths ?? []), key];
    return this.applicationDocuments.save(row);
  }

  // ── Submit ───────────────────────────────────────────────────────────────

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

  async listApplications(status?: ApplicationStatus): Promise<AssayerApplicationEntity[]> {
    return this.applications.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async getApplication(id: string): Promise<{
    application: AssayerApplicationEntity;
    documents: AssayerApplicationDocumentEntity[];
  }> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('Application not found.');
    const documents = await this.applicationDocuments.find({ where: { applicationId: id } });
    return { application, documents };
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

  async approve(
    id: string,
    actorUserId: string,
    actorRoles: string[] | undefined,
    organizationId?: string | null,
  ): Promise<AssayerEntity> {
    const application = await this.mustBeReviewable(id);
    const documents = await this.applicationDocuments.find({ where: { applicationId: id } });

    const notesParts = [
      application.expertise ? `Expertise: ${application.expertise}.` : null,
      application.availability ? `Availability: ${application.availability}.` : null,
    ].filter((v): v is string => Boolean(v));

    const createDto: CreateAssayerDto = {
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

    for (const doc of documents) {
      for (const key of doc.filePaths ?? []) {
        await this.rosterRecords.attachFile(assayer.id, doc.requirement, key, actorUserId);
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
      remarks: `Promoted to assayer ${assayer.assayerCode}.`,
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

    return assayer;
  }
}
