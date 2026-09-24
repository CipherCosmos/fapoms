import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THE INTERVIEW'S TEST PAPERS, AND A SECOND ATTEMPT THAT POINTS AT THE FIRST.
 *
 * An interview recorded "Passed" or "Did not pass" and a note, and nothing else — the test the
 * decision rested on was nowhere. `attachments` keeps the files with the interview (never removed:
 * they are the evidence for a decision somebody may question). `previous_interview_id` ties an
 * interview to the one that did not pass before it, so a candidate interviewed again carries the
 * whole story instead of two unrelated rows.
 */
export class InterviewFilesAndRetake1800200000000 implements MigrationInterface {
  name = 'InterviewFilesAndRetake1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayer_interviews" ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "assayer_interviews" ADD COLUMN IF NOT EXISTS "previous_interview_id" uuid`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "assayer_interviews" ADD CONSTRAINT "FK_assayer_interviews_previous"
          FOREIGN KEY ("previous_interview_id") REFERENCES "assayer_interviews"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    // One follow-up per interview that did not pass: a retake is a single next step, not a fork.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_interviews_previous" ON "assayer_interviews" ("previous_interview_id") WHERE "previous_interview_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_assayer_interviews_previous"`);
    await queryRunner.query(`ALTER TABLE "assayer_interviews" DROP CONSTRAINT IF EXISTS "FK_assayer_interviews_previous"`);
    await queryRunner.query(`ALTER TABLE "assayer_interviews" DROP COLUMN IF EXISTS "previous_interview_id"`);
    await queryRunner.query(`ALTER TABLE "assayer_interviews" DROP COLUMN IF EXISTS "attachments"`);
  }
}
