import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record why a job was closed without anyone checking in.
 *
 * Completing an assignment books money: it raises the assayer's payable and the client's
 * billing line. The rule was therefore that only attended work completes, and attendance means
 * a check-in — a geofenced action that exists only in the field app.
 *
 * The desk cannot perform one. So an accepted job whose assayer never opened the app, or whose
 * phone died, or who stood in a branch with no signal, could not be closed by anybody: the
 * assayer was not allowed to complete it and the operations team was refused with "Invalid
 * transition path from 'ACCEPTED' to 'COMPLETED'". That is not a safeguard, it is a dead end,
 * and it is what operations ran into on every such job.
 *
 * The desk may now close it and must say why. This column holds that reason. It is null for
 * every job completed the ordinary way; a value in it means the money was booked on somebody's
 * word rather than on attendance evidence, which is exactly the thing worth being able to find
 * later.
 */
export class CompletionWithoutCheckIn1792200000000 implements MigrationInterface {
  name = 'CompletionWithoutCheckIn1792200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "completed_without_check_in_reason" text
    `);

    // Finding these later is the point of recording them, and an operations lead asking "which
    // jobs did we close without evidence" should not scan the table to do it. Partial, because
    // the answer is a small minority of rows and the index has no business covering the rest.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assignments_completed_without_check_in"
        ON "assignments" ("completion_date")
        WHERE "completed_without_check_in_reason" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_assignments_completed_without_check_in"`);
    await q.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "completed_without_check_in_reason"`);
  }
}
