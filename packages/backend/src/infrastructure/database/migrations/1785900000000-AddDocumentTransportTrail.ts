import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the document transport audit trail required by spec §8.6:
 * "Every document carries its full history: uploaded → dispatched (auto/manual, by whom,
 * when) → received back → sent to data entry → sent to external OCR → finalized."
 *
 * `documents.status` recorded only where a document is *now*, never how or when it got
 * there, so the system could not answer "where is branch X's paperwork right now, and who
 * moved it" — the spec's stated single biggest gap.
 *
 * Purely additive: all columns nullable, no defaults, no data rewritten. Existing rows keep
 * null timestamps, which correctly reads as "we don't know when this happened" rather than
 * inventing a history for documents that predate the tracking.
 */
export class AddDocumentTransportTrail1785900000000 implements MigrationInterface {
  name = 'AddDocumentTransportTrail1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "dispatched_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "dispatch_method" character varying(20)`);
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "dispatched_by" uuid`);
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "sent_to_data_entry_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "sent_to_external_ocr_at" TIMESTAMP WITH TIME ZONE`);

    // Supports the Data Entry Head queue's "days pending" ordering (spec §8.5).
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_documents_received_at" ON "documents" ("received_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_documents_received_at"`);
    for (const col of [
      'sent_to_external_ocr_at',
      'sent_to_data_entry_at',
      'received_at',
      'dispatched_by',
      'dispatch_method',
      'dispatched_at',
    ]) {
      await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
