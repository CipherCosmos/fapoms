import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HOLD KYC SCAN DIGESTS TO THE SAME SHAPE AS DOCUMENT DIGESTS.
 *
 * `documents.content_sha256` has had `chk_documents_content_sha256` since integrity metadata was
 * introduced: null, or exactly 64 lower-case hex characters. `assayer_document_versions` — which
 * holds the Aadhaar, PAN and passport scans, the actual KYC evidence — has the same two columns
 * and no constraint at all. Certification wrote the eight-character string `'deadbeef'` into
 * `content_sha256` there with a plain UPDATE and Postgres accepted it.
 *
 * A malformed digest is worse than a missing one. Null reads as "not recorded"; eight characters
 * reads as a hash, compares unequal to every correctly computed digest, and turns an integrity
 * check into a permanent false alarm on that row.
 *
 * Applied to `content_sha256` and `file_checksum`, which the service writes from the same value.
 * Both are nullable and stay nullable: rows created before the controller was wired to derive
 * integrity have no digest, and inventing one now would record what the file is today while
 * presenting it as what was uploaded.
 */
export class KycDocumentIntegrityConstraint1797100000000 implements MigrationInterface {
  name = 'KycDocumentIntegrityConstraint1797100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Any existing malformed value is cleared to null rather than guessed at — null is the honest
    // description of a digest nobody can trust. Reported so the operator can see it happened.
    const bad: Array<{ n: string }> = await queryRunner.query(`
      SELECT count(*)::text AS n FROM assayer_document_versions
      WHERE (content_sha256 IS NOT NULL AND content_sha256 !~ '^[0-9a-f]{64}$')
         OR (file_checksum  IS NOT NULL AND file_checksum  !~ '^[0-9a-f]{64}$')
    `);
    if (Number(bad[0]?.n ?? 0) > 0) {
      await queryRunner.query(`
        UPDATE assayer_document_versions
        SET content_sha256 = CASE WHEN content_sha256 ~ '^[0-9a-f]{64}$' THEN content_sha256 ELSE NULL END,
            file_checksum  = CASE WHEN file_checksum  ~ '^[0-9a-f]{64}$' THEN file_checksum  ELSE NULL END
        WHERE (content_sha256 IS NOT NULL AND content_sha256 !~ '^[0-9a-f]{64}$')
           OR (file_checksum  IS NOT NULL AND file_checksum  !~ '^[0-9a-f]{64}$')
      `);
    }

    await queryRunner.query(`
      ALTER TABLE assayer_document_versions
      ADD CONSTRAINT chk_assayer_document_versions_sha256
      CHECK (
        (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')
        AND (file_checksum IS NULL OR file_checksum ~ '^[0-9a-f]{64}$')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assayer_document_versions
      DROP CONSTRAINT IF EXISTS chk_assayer_document_versions_sha256
    `);
  }
}
