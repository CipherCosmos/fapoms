import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * A Data Principal's rights request under the DPDP Act — the register a bank-vendor Data Fiduciary
 * must keep to show it honours the rights the law grants: access to their data, correction,
 * erasure, grievance redressal, and nomination.
 *
 * Two industry-standard decisions are baked in here, both driven by this being a REGULATED entity:
 *   - Every request runs against an SLA (default 30 days, configurable) so grievances and rights
 *     requests cannot quietly age out — the register computes the deadline and flags overdue.
 *   - ERASURE is a review, not an automatic delete. A bank vendor is under retention obligations
 *     (audit evidence, RBI/contract), so "erase my data" is reconciled against a legal-retention
 *     hold: what is not under a retention duty is erased, what is must be kept, and the decision is
 *     recorded (`legalHoldApplied` + `resolutionNotes`). Auto-deleting on request would breach the
 *     retention duties the rest of this compliance work exists to satisfy.
 *
 * Fulfilling a request (actually exporting or erasing data) stays a reviewed human action; this
 * table is the accountable record that it was received, tracked and answered in time.
 */
@Entity('data_rights_requests')
@Index('IDX_data_rights_status', ['status'])
@Index('IDX_data_rights_received', ['receivedAt'])
export class DataRightsRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'request_type',
    type: 'varchar',
    length: 24,
    comment: 'ACCESS | CORRECTION | ERASURE | GRIEVANCE | NOMINATION',
  })
  requestType: string;

  @Column({
    name: 'subject_type',
    type: 'varchar',
    length: 16,
    default: 'ASSAYER',
    comment: 'The Data Principal category: ASSAYER | USER | OTHER.',
  })
  subjectType: string;

  /** The identifier the requester supplied (assayer code / email / phone). */
  @Column({ name: 'subject_ref', type: 'varchar', length: 160, nullable: true })
  subjectRef: string | null;

  /** The resolved principal id, once matched to a record. */
  @Column({ name: 'subject_id', type: 'uuid', nullable: true })
  subjectId: string | null;

  @Column({ name: 'requester_name', type: 'varchar', length: 160, nullable: true })
  requesterName: string | null;

  @Column({ name: 'requester_contact', type: 'varchar', length: 200, nullable: true })
  requesterContact: string | null;

  @Column({ type: 'text', nullable: true })
  details: string | null;

  @Column({
    type: 'varchar',
    length: 24,
    default: 'RECEIVED',
    comment: 'RECEIVED | IN_PROGRESS | AWAITING_INFO | COMPLETED | REJECTED',
  })
  status: string;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  /** For erasure: true when a retention duty prevented full erasure of some or all of the data. */
  @Column({ name: 'legal_hold_applied', type: 'boolean', default: false })
  legalHoldApplied: boolean;

  @Column({ name: 'resolution_notes', type: 'text', nullable: true })
  resolutionNotes: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
