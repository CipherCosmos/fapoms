import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record why a job was closed without anyone recording that they left the site.
 *
 * The sibling column `completed_without_check_in_reason` (migration 1792200000000) exists
 * because arrival is attendance evidence and the desk cannot manufacture one. Departure is the
 * other half of the same evidence, and until now the product's position on it was contradictory:
 * `operational-integrity.service.ts` called check-in and check-out "attendance evidence", while
 * completion never asked for a check-out and the web app never showed one. The ordinary way to
 * finish a job — uploading the audited return — takes CHECKED_IN → COMPLETED directly, so the
 * ordinary way to finish a job was the way that lost the record.
 *
 * For a bank collateral audit, time on site is attendance evidence and it must exist. So this
 * column holds the stated reason when a completed job has an arrival and no departure behind it.
 *
 * What this deliberately does NOT do is stamp `checked_out_at` for the rows that lack one. A
 * departure time nobody observed, written into the column that means "the assayer left the branch
 * at this moment", is a fiction presented as an observation — worse than an acknowledged gap,
 * because a gap is visible and a fiction is not. The existing rows keep their null departure and
 * are reported by `OperationalIntegrityService` as the known gap they are.
 */
export class CompletionWithoutCheckOut1798200000000 implements MigrationInterface {
  name = 'CompletionWithoutCheckOut1798200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "completed_without_check_out_reason" text
    `);

    // Same shape and same reason as the check-in index beside it: the answer is a small minority
    // of rows, and "which jobs closed without a departure on record" should not scan the table.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assignments_completed_without_check_out"
        ON "assignments" ("completion_date")
        WHERE "completed_without_check_out_reason" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_assignments_completed_without_check_out"`);
    await q.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "completed_without_check_out_reason"`);
  }
}
