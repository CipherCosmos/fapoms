import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { InterviewOutcome } from '@fapoms/shared';

/**
 * The Appraiser Recruitment spec's Module 1: HR's own pre-registration gate.
 *
 * Deliberately not a stage of `AssayerLifecycleStatus` — nobody has a roster record yet, and this
 * table's only job is to decide whether an `AssayerApplicationEntity` (and an invite link) gets
 * created at all. See `assayer-application.ts` in shared for why the two layers are separate.
 */
@Entity('assayer_interviews')
@Index(['organizationId'])
export class AssayerInterviewEntity extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'candidate_name', type: 'varchar', length: 200 })
  candidateName: string;

  @Column({ type: 'varchar', length: 20 })
  mobile: string;

  /**
   * Not in the spec's own field list for this form, but the invite link this outcome spawns
   * (`RegistrationApplicationService.createInvite`) is delivered by email — HR supplies it here
   * when known, so the candidate the interview just passed actually receives something.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 10 })
  outcome: InterviewOutcome;

  @Column({ name: 'interviewed_by_user_id', type: 'uuid', nullable: true })
  interviewedByUserId: string | null;

  @Column({ name: 'interviewed_by_name', type: 'varchar', length: 200, nullable: true })
  interviewedByName: string | null;

  @Column({ name: 'interviewed_at', type: 'timestamptz' })
  interviewedAt: Date;

  /** Set right after a PASS spawns the application — never written any other way. */
  @Column({ name: 'spawned_application_id', type: 'uuid', nullable: true })
  spawnedApplicationId: string | null;
}
