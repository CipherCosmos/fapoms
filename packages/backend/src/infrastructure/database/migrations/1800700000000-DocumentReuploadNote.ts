import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HR'S NOTE WHEN THEY ASK FOR A DOCUMENT AGAIN.
 *
 * "Ask to re-upload" (`RosterRecordsService.requestReupload`) sends a verified document — or the
 * locked photograph — back to the assayer with HR's own sentence. That sentence went into the
 * notification and was appended to `remarks`, where any later edit could bury it, so the field app
 * had nothing reliable to show beside the reopened document. It now has its own column, read back
 * as `hrNote` by `GET /assayers/me/capabilities`, and cleared when review gives the document a new
 * verdict. Nullable and additive; existing rows keep no note (the app falls back to the rejection
 * reason's guidance), nothing is backfilled from `remarks`.
 */
export class DocumentReuploadNote1800700000000 implements MigrationInterface {
  name = 'DocumentReuploadNote1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_documents" ADD COLUMN IF NOT EXISTS "reupload_note" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_documents" DROP COLUMN IF EXISTS "reupload_note"`);
  }
}
