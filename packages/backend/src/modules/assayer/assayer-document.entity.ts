import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { OnboardingDocument, DocumentVerification } from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';

/**
 * One document the company holds about an appraiser, whatever it is for.
 *
 * There were three tables answering parts of "have we got their PAN?": a checklist of joining
 * paperwork, an identity register with numbers and expiries and files, and a versioned file
 * store. Only the checklist was ever used — 11,021 rows against nothing in either of the others,
 * in any environment — while HR had three screens to check for one answer, and the two
 * vocabularies had already begun to collide. See the OneDocumentRecord migration.
 *
 * The shape below is the checklist widened by what the register could say and it could not.
 *
 * **Soft and hard copies stay separate** because the roster distinguishes them: a scan can be on
 * file while the signed original is still in the post, and only the original satisfies an audit.
 *
 * **Only identity documents carry a number, an expiry and a verification.** `IDENTITY_DOCUMENTS`
 * in the shared vocabulary decides which; the rest are papers that either arrived or did not,
 * and a code-of-conduct letter reading "Pending verification" for ever is an alarm nobody can
 * clear. That is why `verificationStatus` is nullable here and was NOT NULL in the register.
 */
@Entity('assayer_documents')
@Index(['assayerId'])
@Index(['requirement'])
// One row per requirement per person: two would be two answers to whether it arrived.
@Unique('UQ_assayer_document_requirement', ['assayerId', 'requirement'])
export class AssayerDocumentEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ type: 'varchar', length: 40 })
  requirement: OnboardingDocument;

  @Column({ name: 'soft_copy_received', type: 'boolean', nullable: true })
  softCopyReceived: boolean | null;

  @Column({ name: 'hard_copy_received', type: 'boolean', nullable: true })
  hardCopyReceived: boolean | null;

  /** Where the signed original physically is. "Sent to Bangalore office" is a real value. */
  @Column({ name: 'hard_copy_location', type: 'varchar', length: 120, nullable: true })
  hardCopyLocation: string | null;

  @Column({ name: 'courier_reference', type: 'varchar', length: 200, nullable: true })
  courierReference: string | null;

  @Column({ name: 'received_at', type: 'date', nullable: true })
  receivedAt: Date | null;

  // ── Identity documents only ───────────────────────────────────────────

  /** The number on the document. Kept beside it, not on the person: a record has one PAN card. */
  @Column({ name: 'document_number', type: 'text', nullable: true })
  documentNumber: string | null;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate: Date | null;

  /** Null for anything that is not an identity document — see the class comment. */
  @Column({ name: 'verification_status', type: 'varchar', length: 20, nullable: true })
  verificationStatus: DocumentVerification | null;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'verified_by', type: 'uuid', nullable: true })
  verifiedBy: string | null;

  /** Scans of the document. An array because both sides of a card are one document. */
  @Column({ name: 'file_paths', type: 'jsonb', default: () => "'[]'::jsonb" })
  filePaths: string[];

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
