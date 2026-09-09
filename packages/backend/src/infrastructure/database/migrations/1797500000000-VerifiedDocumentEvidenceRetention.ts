import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A VERIFIED IDENTITY DOCUMENT MAY NOT LOSE THE OBJECT IT WAS CHECKED AGAINST.
 *
 * `DELETE /assayers/document/:id/file/:index` removed a key from `assayer_documents.file_paths`
 * and the controller then destroyed the stored object. Nothing consulted the OTHER table that
 * references that same object: `assayer_document_versions` rows carry their own `file_path`, and
 * a row reading `verification_status = 'VERIFIED'` is a person's signature saying they held that
 * scan beside the original and the two agreed. Certification reproduced it — v1 VERIFIED,
 * `file_path = uploads/1788968609538-kyc_probe.pdf`, and no such object in the bucket. The row
 * went on asserting that somebody checked a PAN card that no longer exists.
 *
 * The object's lifetime was decided by one of its two references. This makes the decision
 * structural instead.
 *
 * ## `evidence_released_at`
 *
 * The moment the stored object this row cites was destroyed. Null means it was not — either it is
 * still attached to the parent record, or it was detached and deliberately KEPT because this row
 * still attests to it. Writing it is what authorises the destroy, and the destroy happens after
 * the write, never before: a crash between the two leaves an unreferenced object in the bucket,
 * which is harmless, rather than a signature pointing at nothing, which is the defect.
 *
 * ## The CHECK
 *
 * `verification_status <> 'VERIFIED' OR evidence_released_at IS NULL`.
 *
 * Two rules in one line, both of which the service also enforces and neither of which it can be
 * trusted to enforce alone:
 *
 *  - Evidence under a verification cannot be released. Postgres refuses the bookkeeping, so the
 *    destroy never gets its authorisation.
 *  - A version whose evidence has been released can never become VERIFIED. There is nothing left
 *    to check it against, and `verifyDocument` already refuses to verify a document with no scan
 *    on file for exactly that reason — this stops the same claim arriving through the version row.
 *
 * ## Existing rows
 *
 * Nothing is backfilled and nothing is rewritten. Every row starts with `evidence_released_at`
 * null, so the constraint validates against the whole table as it stands. Rows already in the
 * dangling state cannot be identified from SQL — whether an object is present in the bucket is
 * not a fact this database holds — but the population at risk is exactly "VERIFIED, and the key
 * it cites is no longer among its parent's `file_paths`", so that is counted and reported. It is
 * deliberately NOT corrected: downgrading a historical attestation would be rewriting somebody's
 * signature, and inventing a release timestamp for a deletion nobody recorded would be worse than
 * the gap it papers over.
 */
export class VerifiedDocumentEvidenceRetention1797500000000 implements MigrationInterface {
  name = 'VerifiedDocumentEvidenceRetention1797500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assayer_document_versions
      ADD COLUMN IF NOT EXISTS evidence_released_at timestamptz NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN assayer_document_versions.evidence_released_at IS
      'When the stored object this version cites was destroyed. Null while it still exists — including when it was detached from the parent record but kept because this row attests to it. Writing this authorises the destroy; the CHECK below refuses to write it on a VERIFIED row.'
    `);

    // Reported, not repaired. See the class comment.
    const stranded: Array<{ n: string }> = await queryRunner.query(`
      SELECT count(*)::text AS n
      FROM assayer_document_versions v
      JOIN assayer_documents d ON d.id = v.document_id
      WHERE v.verification_status = 'VERIFIED'
        AND NOT (COALESCE(d.file_paths, '[]'::jsonb) ? v.file_path)
    `);
    const count = Number(stranded[0]?.n ?? 0);
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[VerifiedDocumentEvidenceRetention] ${count} verified document version(s) cite a scan `
        + 'that is no longer attached to their record. Their stored objects may already have been '
        + 'destroyed by the delete path this migration closes. Left exactly as they are — an '
        + 'attestation is not ours to rewrite — and reported so it can be re-collected.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE assayer_document_versions
      ADD CONSTRAINT chk_assayer_document_versions_verified_keeps_evidence
      CHECK (verification_status <> 'VERIFIED' OR evidence_released_at IS NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assayer_document_versions
      DROP CONSTRAINT IF EXISTS chk_assayer_document_versions_verified_keeps_evidence
    `);
    await queryRunner.query(`
      ALTER TABLE assayer_document_versions
      DROP COLUMN IF EXISTS evidence_released_at
    `);
  }
}
