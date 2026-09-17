import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ApplicationStatus, EmploymentCategory } from '@fapoms/shared';

/**
 * A candidate's self-registration submission, before it is a real assayer.
 *
 * This is the pre-account layer the Appraiser Recruitment spec's registration/profile-creation/
 * validation modules describe (Submit → Pending Validation → Awaiting Info → Rejected/Approved).
 * It exists as its own table, not a status on `AssayerEntity`, so that the live, guarded
 * `AssayerLifecycleStatus` enum never has to carry a pre-account state — see `assayer-application.ts`
 * in shared for the full reasoning.
 *
 * On approval, `AssayerService.create()` is called to promote this into a real assayer (a normal,
 * ungated create — the same one the HR-desk wizard uses), and `promotedAssayerId` is set. That
 * promotion is a named, explicit step (re-homing each `AssayerApplicationDocumentEntity` row onto
 * the new assayer) — never an implicit side effect of `create()`, which does not touch documents.
 */
@Entity('assayer_applications')
@Index(['organizationId'])
@Index(['status'])
@Index(['tokenHash'])
export class AssayerApplicationEntity extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'interview_id', type: 'uuid', nullable: true })
  interviewId: string | null;

  // ── Candidate identity ────────────────────────────────────────────────
  @Column({ name: 'full_name', type: 'varchar', length: 200, nullable: true })
  fullName: string | null;

  @Column({ type: 'varchar', length: 20 })
  mobile: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  // ── Personal details ──────────────────────────────────────────────────
  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: Date | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  gender: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  state: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  pincode: string | null;

  // ── Professional details ──────────────────────────────────────────────
  @Column({ name: 'experience_years', type: 'int', nullable: true })
  experienceYears: number | null;

  @Column({ name: 'current_employer', type: 'varchar', length: 200, nullable: true })
  currentEmployer: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  expertise: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  availability: string | null;

  /** Decides which extra documents (Phase 1's five new `OnboardingDocument` values) this candidate is asked for. */
  @Column({ name: 'employment_category', type: 'varchar', length: 20, nullable: true })
  employmentCategory: EmploymentCategory | null;

  // ── Declaration & consent ──────────────────────────────────────────────
  @Column({ name: 'consent_accepted_at', type: 'timestamptz', nullable: true })
  consentAcceptedAt: Date | null;

  @Column({ name: 'consent_version', type: 'varchar', length: 20, nullable: true })
  consentVersion: string | null;

  /**
   * The exact notice this person was shown, kept beside their acceptance.
   *
   * The wording is versioned in code, so the version alone would usually be enough — but what has
   * to be produced later is what THIS candidate actually saw, including the grievance contact that
   * was current that day. Storing the text means a notice can never be quietly rewritten under an
   * acceptance that already happened.
   */
  @Column({ name: 'consent_notice', type: 'jsonb', nullable: true })
  consentNotice: Record<string, unknown> | null;

  /** When they took it back. Set together with status WITHDRAWN; see `withdrawConsent`. */
  @Column({ name: 'consent_withdrawn_at', type: 'timestamptz', nullable: true })
  consentWithdrawnAt: Date | null;

  /** Their words, if they gave a reason. Never required — withdrawal is not something to justify. */
  @Column({ name: 'consent_withdrawal_reason', type: 'text', nullable: true })
  consentWithdrawalReason: string | null;

  /**
   * When the retention sweep erased this person's answers and deleted their scans.
   *
   * The row survives as a record that an application existed and how it ended; everything that
   * identified the person is gone. Null means "still holding their data" — either because it is
   * not due yet, or because the application is still live.
   */
  @Column({ name: 'personal_data_erased_at', type: 'timestamptz', nullable: true })
  personalDataErasedAt: Date | null;

  // ── Review workflow ────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 20, default: ApplicationStatus.DRAFT })
  status: ApplicationStatus;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'review_notes', type: 'text', nullable: true })
  reviewNotes: string | null;

  /** Set once, on approval. The application stays around as the record of how the candidate applied. */
  @Column({ name: 'promoted_assayer_id', type: 'uuid', nullable: true })
  promotedAssayerId: string | null;

  /** See ApplicationSource in @fapoms/shared — SELF_SERVICE (candidate is the maker) or HR_DESK. */
  @Column({ type: 'varchar', length: 20, default: 'SELF_SERVICE' })
  source: string;

  /**
   * The wizard's payload beyond the application's own columns — bank and identity details,
   * commercial rates, per-client standings — held as a document until approval and applied by
   * `applyExtendedProfile` afterwards. Nothing in it becomes live roster data for a person who
   * may yet be rejected.
   */
  @Column({ name: 'extended_profile', type: 'jsonb', nullable: true })
  extendedProfile: Record<string, unknown> | null;

  // ── Invite / access token ──────────────────────────────────────────────
  // Only the hash is ever stored — see `document-access-token.service.ts` for the same discipline
  // elsewhere in this codebase. The raw token lives only in the emailed link and the candidate's
  // browser/app.
  @Column({ name: 'token_hash', type: 'varchar', length: 128, nullable: true })
  tokenHash: string | null;

  @Column({ name: 'token_expires_at', type: 'timestamptz', nullable: true })
  tokenExpiresAt: Date | null;

  /**
   * Set the first time the link is opened — NOT what blocks reuse (expiry does).
   *
   * It is the only record of whether an invited candidate ever arrived, which is the difference
   * between "still filling it in" and "never received the email" — two very different people who
   * otherwise both just sit in `DRAFT`.
   */
  @Column({ name: 'token_consumed_at', type: 'timestamptz', nullable: true })
  tokenConsumedAt: Date | null;
}
