import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PER-DOCUMENT SEND-BACK AND TARGETED INFO REQUESTS IN HIRING.
 *
 * HR could only reject a whole application or write one free-text "request info" note the
 * candidate had to decode. This adds the verdict columns on `assayer_application_documents`
 * (one requirement sent back at a time, with a structured reason) and the `info_requests`
 * to-do list on `assayer_applications` (exactly which documents and fields HR ticked, each
 * with its own instruction). The candidate's SAME link reopens as `AWAITING_INFO` with only
 * those items flagged — no whole-application rejection over one blurry scan.
 */
export class ApplicationPerDocumentReview1799700000000 implements MigrationInterface {
  name = 'ApplicationPerDocumentReview1799700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_application_documents"
        ADD COLUMN IF NOT EXISTS "review_status" varchar(20) NOT NULL DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS "rejection_reason" varchar(40),
        ADD COLUMN IF NOT EXISTS "rejection_note" text,
        ADD COLUMN IF NOT EXISTS "reviewed_by" uuid,
        ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        ADD COLUMN IF NOT EXISTS "info_requests" jsonb
    `);
    // The review queue asks "which requirements still need a resubmission" per application.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_application_documents_review_status"
        ON "assayer_application_documents" ("application_id", "review_status")
        WHERE "review_status" = 'NEEDS_RESUBMIT'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_application_documents_review_status"`);
    await queryRunner.query(`ALTER TABLE "assayer_applications" DROP COLUMN IF EXISTS "info_requests"`);
    await queryRunner.query(`
      ALTER TABLE "assayer_application_documents"
        DROP COLUMN IF EXISTS "reviewed_at",
        DROP COLUMN IF EXISTS "reviewed_by",
        DROP COLUMN IF EXISTS "rejection_note",
        DROP COLUMN IF EXISTS "rejection_reason",
        DROP COLUMN IF EXISTS "review_status"
    `);
  }
}
