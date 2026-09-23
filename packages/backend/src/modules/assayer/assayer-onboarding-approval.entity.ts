import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { OnboardingApprovalStatus, type OnboardingApprovalEvent } from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';

/**
 * One round of the approval before training — see `onboarding-approval.ts` in shared.
 *
 * `events` is the round's conversation, appended to and never rewritten: submitted, asked,
 * answered, decided. Every entry is also on the audit trail; this is where the screen reads it.
 */
@Entity('assayer_onboarding_approvals')
@Index(['assayerId'])
@Unique('UQ_assayer_onboarding_approvals_round', ['assayerId', 'round'])
export class AssayerOnboardingApprovalEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  /** 1 for the first time they were put up, 2 after a rejection was re-opened, and so on. */
  @Column({ type: 'int' })
  round: number;

  @Column({ type: 'varchar', length: 20 })
  status: OnboardingApprovalStatus;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  events: OnboardingApprovalEvent[];

  @Column({ name: 'submitted_by', type: 'uuid', nullable: true })
  submittedBy: string | null;

  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;
}
