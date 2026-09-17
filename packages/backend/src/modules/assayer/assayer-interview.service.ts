import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationStatus, EventCategory, InterviewOutcome } from '@fapoms/shared';
import { AssayerInterviewEntity } from './assayer-interview.entity';
import { AssayerApplicationEntity } from './assayer-application.entity';
import { RegistrationApplicationService } from './registration-application.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { tenantWhere } from '../../infrastructure/tenancy/ambient-tenant-context';
import { AuditService } from '../../core/audit/audit.service';

export interface RecordInterviewDto {
  candidateName: string;
  mobile: string;
  email?: string;
  notes?: string;
  outcome: InterviewOutcome;
}

/** What may be corrected on a record that has already been written. See `amend`. */
export interface AmendInterviewDto {
  candidateName?: string;
  mobile?: string;
  email?: string | null;
  notes?: string | null;
}

/**
 * The Appraiser Recruitment spec's Module 1: HR's pre-registration interview gate.
 *
 * A PASS spawns an `AssayerApplicationEntity` and its invite link (`RegistrationApplicationService
 * .createInviteRecord`) — this service owns none of that logic itself, only the record of the
 * interview and the decision to spawn one.
 *
 * It is also the front door. Nothing else in the product creates an application, so this is where
 * every person on the roster began, and the reason it is recorded by hand is that at this moment
 * there is no application, no assayer and no user account — nothing in the database to hang the
 * record on, and nothing that could trigger it.
 */
@Injectable()
export class AssayerInterviewService {
  constructor(
    @InjectRepository(AssayerInterviewEntity)
    private readonly interviews: Repository<AssayerInterviewEntity>,
    private readonly registrationApplications: RegistrationApplicationService,
    private readonly unitOfWork: UnitOfWork,
    private readonly auditService: AuditService,
  ) {}

  /**
   * `inviteEmailed` says whether the candidate was actually reached, not whether an address was
   * on file — the screen announces one of those and must not announce the other.
   *
   * ## Two writes and a send, in that order
   *
   * The record, the application it spawns and the link between them are one transaction, and the
   * email goes out after it commits. It used to be three sequential saves with the send in the
   * middle: a failure after the email left a candidate holding a working link to an application
   * the desk's own log did not know about, and a failure before it left a PASS that invited
   * nobody. An email cannot be recalled, so it is the thing that must happen last.
   */
  async record(
    dto: RecordInterviewDto,
    userId: string,
    userName: string | undefined,
    organizationId?: string | null,
  ): Promise<AssayerInterviewEntity & {
    inviteEmailed: boolean;
    inviteLink?: string;
    /** True when the PASS joined an application this candidate already had. See below. */
    joinedExistingApplication?: boolean;
  }> {
    if (!dto.candidateName?.trim()) throw new BadRequestException('Candidate name is required.');
    if (!dto.mobile?.trim()) throw new BadRequestException('Mobile number is required.');

    const mobile = dto.mobile.trim();
    const isPass = dto.outcome === InterviewOutcome.PASS;

    if (isPass && typeof this.registrationApplications.checkMobileConflict === 'function') {
      const conflict = await this.registrationApplications.checkMobileConflict(mobile, organizationId);
      if (conflict && conflict.target === 'ASSAYER') {
        // The interviewer is staff: name who holds the number, or they cannot tell a real
        // duplicate from a mistyped digit.
        throw new ConflictException(conflict.detail);
      }
    }

    /*
      Already partway in?

      Pressing Record twice — or interviewing somebody a second time — used to mint a second
      application and a second live token for one person, because nothing looked. There is no
      unique index on the mobile and no idempotency key, so both rows sat in the queue and
      whichever link the candidate happened to open became the real one.

      The interview is still recorded, because it happened. What is not repeated is the
      application: the new record links to the one they already have, and the desk is handed a
      fresh link to THAT application rather than a rival to it.
    */
    const existing = isPass
      ? await this.registrationApplications.openApplicationForMobile(mobile, organizationId)
      : null;

    const { interview, invite } = await this.unitOfWork.run(async (manager) => {
      const created = await manager.save(AssayerInterviewEntity, this.interviews.create({
        candidateName: dto.candidateName.trim(),
        mobile,
        email: dto.email?.trim() || null,
        notes: dto.notes?.trim() || null,
        outcome: dto.outcome,
        interviewedByUserId: userId,
        interviewedByName: userName ?? null,
        interviewedAt: new Date(),
        organizationId: organizationId ?? null,
      }));

      if (!isPass) return { interview: created, invite: null };

      if (existing) {
        created.spawnedApplicationId = existing.id;
        return { interview: await manager.save(AssayerInterviewEntity, created), invite: null };
      }

      const minted = await this.registrationApplications.createInviteRecord({
        interviewId: created.id,
        fullName: created.candidateName,
        mobile: created.mobile,
        email: created.email,
        organizationId,
      }, manager);
      created.spawnedApplicationId = minted.application.id;
      return { interview: await manager.save(AssayerInterviewEntity, created), invite: minted };
    });

    // ── After the commit ──────────────────────────────────────────────────
    let inviteEmailed = false;
    // Handed back to the interviewer on a PASS so the desk can deliver the link itself when the
    // email did not go — see `RegistrationApplicationService.inviteLink`.
    let inviteLink: string | undefined;
    if (invite) {
      const delivered = await this.registrationApplications.deliverInvite(invite.application, invite.rawToken);
      inviteEmailed = delivered.emailed;
      inviteLink = delivered.inviteLink;
    } else if (existing) {
      // The same link-handing the Applications screen offers, so a repeat PASS ends the way a
      // first one does: with something the desk can read out.
      const resent = await this.registrationApplications.resendInvite(existing.id, userId);
      inviteEmailed = resent.emailed;
      inviteLink = resent.inviteLink;
    }

    /*
      The one decision in this pipeline that wrote no audit row.

      `approve`, `reject`, `requestMoreInfo` and `resendInvite` all record one; a FAIL — which is a
      hiring rejection, and the outcome a candidate is most likely to question — recorded nothing
      at all. Both outcomes are written, because "we never interviewed them" and "we interviewed
      them and said no" are different claims and only one of them is checkable.
    */
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: isPass ? 'ASSAYER_INTERVIEW_PASSED' : 'ASSAYER_INTERVIEW_FAILED',
      entityType: 'ASSAYER_INTERVIEW',
      entityId: interview.id,
      userId,
      remarks: isPass
        ? existing
          ? `${interview.candidateName} passed; joined their open application rather than starting a second.`
          : `${interview.candidateName} passed; a registration invite was ${inviteEmailed ? 'emailed' : 'minted and handed to the desk'}.`
        : `${interview.candidateName} was not taken forward. No registration invite was created.`,
    });

    return Object.assign(interview, {
      inviteEmailed,
      inviteLink,
      joinedExistingApplication: Boolean(existing),
    });
  }

  /**
   * Correct what was typed, while correcting it is still harmless.
   *
   * This controller had `@Post()` and `@Get()` and nothing else, so a mistyped mobile number could
   * not be fixed — the only repair was recording a second interview, which sent a second invite to
   * the wrong number and left the log claiming the candidate had been interviewed twice.
   *
   * The window closes when the candidate opens their link (`tokenConsumedAt`). After that the
   * number on the application is theirs to correct, not the desk's: `verifyOtp` is what proves it,
   * and overwriting a confirmed number from here would undo that proof silently.
   */
  async amend(
    id: string,
    dto: AmendInterviewDto,
    userId: string,
  ): Promise<AssayerInterviewEntity> {
    const interview = await this.interviews.findOne({ where: tenantWhere<AssayerInterviewEntity>({ id }) });
    if (!interview) throw new NotFoundException('Interview not found.');

    let application: AssayerApplicationEntity | null = null;
    if (interview.spawnedApplicationId) {
      application = await this.registrationApplications.findApplicationForAmend(interview.spawnedApplicationId);
      if (application && (application.tokenConsumedAt || application.status !== ApplicationStatus.DRAFT)) {
        throw new BadRequestException(
          'This candidate has already opened their registration link, so their own details are now '
          + 'theirs to correct. Ask them to change it on the form, or use Request more information.',
        );
      }
    }

    const before = { candidateName: interview.candidateName, mobile: interview.mobile, email: interview.email };
    if (dto.candidateName?.trim()) interview.candidateName = dto.candidateName.trim();
    if (dto.mobile?.trim()) interview.mobile = dto.mobile.trim();
    if (dto.email !== undefined) interview.email = dto.email?.trim() || null;
    if (dto.notes !== undefined) interview.notes = dto.notes?.trim() || null;

    const saved = await this.unitOfWork.run(async (manager) => {
      const written = await manager.save(AssayerInterviewEntity, interview);
      if (application) {
        // The application carries the same three facts, and it is the one the candidate will see.
        application.fullName = written.candidateName;
        application.mobile = written.mobile;
        application.email = written.email;
        await manager.save(AssayerApplicationEntity, application);
      }
      return written;
    });

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_INTERVIEW_AMENDED',
      entityType: 'ASSAYER_INTERVIEW',
      entityId: saved.id,
      userId,
      remarks: `Corrected before the candidate opened their link: ${before.candidateName} / ${before.mobile}`
        + ` → ${saved.candidateName} / ${saved.mobile}.`,
    });
    return saved;
  }

  /**
   * `tenantWhere` because this had no organisation predicate: an OPERATIONS user in one
   * organisation was served every other organisation's interview log — candidate names, mobile
   * numbers and email addresses of people who work for nobody yet. `record()` has always stamped
   * `organizationId` and the table has always been indexed on it; nothing read it back.
   */
  async list(): Promise<AssayerInterviewEntity[]> {
    return this.interviews.find({
      where: tenantWhere<AssayerInterviewEntity>({}),
      order: { interviewedAt: 'DESC' },
    });
  }
}
