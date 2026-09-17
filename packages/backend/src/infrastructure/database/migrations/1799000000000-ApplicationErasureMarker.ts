import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WHEN A CLOSED APPLICATION'S PERSONAL DATA WAS ERASED.
 *
 * The retention sweep needs to tell "not due yet" from "already done": without a marker it would
 * re-select the same rejected applications on every hourly pass for ever, since nothing else about
 * them changes once they are closed. It is also the answer to "when did you delete it?", which is
 * the question a data-protection complaint actually asks.
 */
export class ApplicationErasureMarker1799000000000 implements MigrationInterface {
  name = 'ApplicationErasureMarker1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        ADD COLUMN IF NOT EXISTS "personal_data_erased_at" timestamptz
    `);
    // The sweep asks "closed, old enough, not yet erased" — this is the index for that question.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_applications_pending_erasure"
        ON "assayer_applications" ("status", "updated_at")
        WHERE "personal_data_erased_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_applications_pending_erasure"`);
    await queryRunner.query(`ALTER TABLE "assayer_applications" DROP COLUMN IF EXISTS "personal_data_erased_at"`);
  }
}
