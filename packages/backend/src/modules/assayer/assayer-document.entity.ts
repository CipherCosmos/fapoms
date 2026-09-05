import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { encryptedColumn } from '../../infrastructure/security/field-encryption';
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
  /**
   * Encrypted from day one, unlike the three assayer columns that spent months as plaintext.
   *
   * This is where a PAN or Aadhaar number lands a SECOND time — typed against the scanned card so
   * `verifyDocument` has something to attest against — and it was a bare `text` column. Not one
   * row has ever held a value (11,160 of them arrived with the roster import), which is exactly
   * the moment to add the transformer: there is nothing to backfill, and the first value ever
   * written arrives as `enc:v1:` ciphertext. Check the claim as
   * `WHERE document_number IS NOT NULL`, not by row count — the table grows by a few rows every
   * time somebody walks the onboarding wizard, so the total drifts while the invariant does not.
   */
  @Column({ name: 'document_number', type: 'text', nullable: true, transformer: encryptedColumn })
  documentNumber: string | null;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate: Date | null;

  /**
   * What the card actually says, typed by the reviewer who is holding it.
   *
   * These are the point of the whole verification step. Before them the record's name could not be
   * compared with the document's name, because the document's name was never written down — and a
   * verification that compares nothing is a signature on a blank page.
   *
   * Per document rather than per person, because a person has both an Aadhaar row and a PAN row
   * and the two are allowed to disagree; that disagreement is a finding, and one set of columns on
   * `assayers` would have nowhere to keep the second card's version.
   *
   * Plaintext: `assayers.display_name` and `assayers.address` already are, so encrypting the same
   * facts here would protect nothing while making them uncomparable. They are still identity data
   * and are stripped by role in `assayer-visibility.ts`.
   */
  @Column({ name: 'holder_name', type: 'varchar', length: 200, nullable: true })
  holderName: string | null;

  @Column({ name: 'holder_date_of_birth', type: 'date', nullable: true })
  holderDateOfBirth: Date | null;

  @Column({ name: 'holder_gender', type: 'varchar', length: 20, nullable: true })
  holderGender: string | null;

  /** Father's or guardian's name — what a PAN card prints, and the usual disambiguator. */
  @Column({ name: 'holder_guardian_name', type: 'varchar', length: 200, nullable: true })
  holderGuardianName: string | null;

  /** The address as printed, which an Aadhaar carries and the roster's own address may contradict. */
  @Column({ name: 'holder_address', type: 'text', nullable: true })
  holderAddress: string | null;

  /**
   * How well `holderName` agreed with the person's name at the moment somebody verified this.
   *
   * Stored rather than recomputed, because it is evidence: it records that a human was shown the
   * disagreement and went ahead anyway. Recomputing it later would answer a different question,
   * since the record's name may have been corrected since.
   */
  @Column({ name: 'name_match_grade', type: 'varchar', length: 10, nullable: true })
  nameMatchGrade: string | null;

  /** Why the reviewer accepted a name that did not agree. Required when they override. */
  @Column({ name: 'name_match_note', type: 'text', nullable: true })
  nameMatchNote: string | null;

  /**
   * Why the scan was sent back.
   *
   * Structured, not free text, because this sentence travels to the appraiser's phone in their own
   * language and tells them whether to photograph the same card again or find a different one. A
   * database CHECK requires it whenever the status is REJECTED — a rejection with no reason is a
   * dead end for the person who has to act on it.
   */
  @Column({ name: 'rejection_reason', type: 'varchar', length: 40, nullable: true })
  rejectionReason: string | null;

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
