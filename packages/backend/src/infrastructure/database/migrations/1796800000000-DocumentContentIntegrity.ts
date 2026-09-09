import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RECORD WHAT EACH DOCUMENT ACTUALLY IS, computed from the bytes that arrived.
 *
 * ## Why this exists
 *
 * `documents` carried two integrity fields and neither was an observation of the file. `file_size`
 * was multer's count, which is real but says nothing about content. `mime_type` was the
 * `Content-Type` the uploading client wrote into its own multipart header — a claim, stored
 * verbatim, never checked against a single byte of the file. There was no content hash of any
 * kind, so nothing on the row could answer the one question that matters about audit evidence:
 * is the file on disk today the file that was uploaded?
 *
 * That gap is what these columns close. `content_sha256` is computed here from the received
 * buffer, so a later re-hash either matches or the document has changed. `sniffed_mime_type` is
 * read from the file's own leading bytes. `declared_mime_type` keeps the uploader's claim as a
 * claim, and `mime_type_mismatch` marks where the two disagree — a renamed executable announcing
 * itself as a PDF produces a row that says so, instead of a row that agrees with it.
 *
 * ## Backfill
 *
 * Deliberately none. A hash can only be derived from bytes, and these columns exist precisely
 * because nothing trustworthy about the existing rows' content was ever recorded — computing a
 * hash today would record what the file is *now* and silently present it as what was uploaded,
 * which is the same category of false confidence this migration exists to end. Pre-existing rows
 * keep `content_sha256 IS NULL`, and null here means exactly "uploaded before integrity was
 * recorded" rather than "verified empty". A separate, explicit re-hashing job can fill them in
 * and stamp its own timestamp if the business wants a baseline from today.
 *
 * The index on `content_sha256` is what makes duplicate detection possible — the same scan
 * uploaded twice against two assessments is now findable — and is partial so the null backfill
 * rows cost nothing.
 */
export class DocumentContentIntegrity1796800000000 implements MigrationInterface {
  name = 'DocumentContentIntegrity1796800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS content_sha256 char(64),
        ADD COLUMN IF NOT EXISTS sniffed_mime_type varchar(255),
        ADD COLUMN IF NOT EXISTS declared_mime_type varchar(255),
        ADD COLUMN IF NOT EXISTS mime_type_mismatch boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS integrity_recorded_at timestamptz
    `);

    // Lower-case hex, or nothing. A mixed-case or truncated digest compares unequal to a correctly
    // computed one, which would turn an integrity check into a false alarm.
    await queryRunner.query(`
      ALTER TABLE documents
      ADD CONSTRAINT chk_documents_content_sha256
      CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_content_sha256
      ON documents (content_sha256) WHERE content_sha256 IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_documents_content_sha256`);
    await queryRunner.query(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS chk_documents_content_sha256`);
    await queryRunner.query(`
      ALTER TABLE documents
        DROP COLUMN IF EXISTS content_sha256,
        DROP COLUMN IF EXISTS sniffed_mime_type,
        DROP COLUMN IF EXISTS declared_mime_type,
        DROP COLUMN IF EXISTS mime_type_mismatch,
        DROP COLUMN IF EXISTS integrity_recorded_at
    `);
  }
}
