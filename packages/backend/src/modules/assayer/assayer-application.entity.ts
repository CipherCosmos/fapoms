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

  // ── Invite / access token ──────────────────────────────────────────────
  // Only the hash is ever stored — see `document-access-token.service.ts` for the same discipline
  // elsewhere in this codebase. The raw token lives only in the emailed link and the candidate's
  // browser/app.
  @Column({ name: 'token_hash', type: 'varchar', length: 128, nullable: true })
  tokenHash: string | null;

  @Column({ name: 'token_expires_at', type: 'timestamptz', nullable: true })
  tokenExpiresAt: Date | null;

  /** Set the first time the link is opened — informational, and NOT what blocks reuse (expiry does). */
  @Column({ name: 'token_consumed_at', type: 'timestamptz', nullable: true })
  tokenConsumedAt: Date | null;

  @Column({ name: 'delivery_email', type: 'varchar', length: 255, nullable: true })
  deliveryEmail: string | null;
}
