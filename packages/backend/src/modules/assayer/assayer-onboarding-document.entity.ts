import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { OnboardingDocument } from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';

/**
 * One item of onboarding paperwork, and whether it has arrived.
 *
 * The roster asks this fifteen times across fifteen Yes/No columns — joining form, NDA, code of
 * conduct, appointment letter, ID card, photograph, both sides of the Aadhaar, PAN, passbook,
 * and so on. Every column is the same question about a different document.
 *
 * As columns they cannot be counted, cannot carry the date they arrived, and cannot grow
 * without a migration. As rows, "what is outstanding for this person" and "who has no NDA" are
 * the same query, and adding a sixteenth requirement is a row rather than a schema change.
 *
 * Soft and hard copies are tracked separately because the roster does: a scan can be on file
 * while the signed original is still in the post, and only the original satisfies an audit.
 */
@Entity('assayer_onboarding_documents')
@Index(['assayerId'])
@Index(['requirement'])
// One row per requirement per person: two would be two answers to whether it arrived.
@Unique('UQ_assayer_onboarding_document', ['assayerId', 'requirement'])
export class AssayerOnboardingDocumentEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ type: 'varchar', length: 40 })
  requirement: OnboardingDocument;

  /** The scan. `null` means nobody has recorded an answer, which is not the same as "no". */
  @Column({ name: 'soft_copy_received', type: 'boolean', nullable: true })
  softCopyReceived: boolean | null;

  /** The signed original. Only this satisfies an audit for the documents that need one. */
  @Column({ name: 'hard_copy_received', type: 'boolean', nullable: true })
  hardCopyReceived: boolean | null;

  /**
   * Where the hard copy is, when it is neither here nor absent.
   *
   * The roster's "NDA Hard copy status" column mixes a status with a place — "Sent to Bangalore
   * office", "Vasai Office" — because in-transit is the commonest state and had nowhere else to
   * go. Kept as written; the boolean above is what queries use.
   */
  @Column({ name: 'hard_copy_location', type: 'varchar', length: 120, nullable: true })
  hardCopyLocation: string | null;

  /** Courier and tracking, so a missing original can be chased rather than re-requested. */
  @Column({ name: 'courier_reference', type: 'varchar', length: 200, nullable: true })
  courierReference: string | null;

  @Column({ name: 'received_at', type: 'date', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
