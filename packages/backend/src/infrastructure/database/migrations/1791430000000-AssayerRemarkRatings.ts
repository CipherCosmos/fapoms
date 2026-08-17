import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staff remarks on assayers become a scored, attributed signal.
 *
 * ## Why this alters `assayer_remarks` instead of creating a table
 *
 * A remarks table already existed — free text, an optional 0–5 `rating` that nothing on any
 * screen ever set, and two frontend readers. It held zero rows on this deployment. Building a
 * second `assayer_staff_remarks` beside it would have left the platform with two places to write
 * the same fact, two APIs, and two lists on the assayer drawer — precisely the parallel-layer
 * shape that was removed from this codebase once already. So the existing table is evolved in
 * place: the columns the recommendation engine needs are added, the rating is given the range
 * the scorer is defined over, and the index the scorer's query wants is created.
 *
 * ## The changes
 *
 *  - `rating` becomes SMALLINT in [-2, +2] (was NUMERIC(3,2), meant as 0–5). The remarks score
 *    is `50 + 25 × weighted-mean(rating)`, which is only bounded to 0–100 if every stored rating
 *    is inside that range, so the bound is enforced here rather than trusted to the API. Nullable
 *    stays: a NULL rating is a plain note and simply does not score.
 *  - `author_role` records which hat the author was wearing (OPERATIONS_EXECUTIVE, VALIDATOR, …)
 *    at the time. Roles change; the remark should still read the way it was meant.
 *  - `assignment_id` optionally ties the remark to the job it is about, ON DELETE SET NULL so a
 *    purged assignment leaves the remark standing as a general one.
 *  - `idx_assayer_remarks_assayer_recent (assayer_id, created_at DESC) WHERE is_active` — the
 *    scorer asks "this pool's remarks from the last 365 days, newest first" in one query, and
 *    the drawer lists them newest first. The old single-column `assayer_id` index cannot return
 *    rows in that order without a sort.
 *
 * ## Why the type change is safe
 *
 * The table is empty on every known deployment (verified 2026-08-17: 0 rows), and the only
 * writer that could have populated `rating` accepted it from a request body no client sent. The
 * `USING round(rating)` clause is there so a non-empty table still converts rather than fails;
 * a pre-existing 0–5 value outside [-2, 2] would then trip the CHECK, which is the correct
 * outcome — that number would be lying to the scorer, and the operator should decide what it
 * meant.
 */
export class AssayerRemarkRatings1791430000000 implements MigrationInterface {
  name = 'AssayerRemarkRatings1791430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_remarks"
        ALTER COLUMN "rating" TYPE smallint USING round("rating")::smallint
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_remarks"
        ADD CONSTRAINT "chk_assayer_remarks_rating_range"
        CHECK ("rating" IS NULL OR ("rating" >= -2 AND "rating" <= 2))
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_remarks"
        ADD COLUMN IF NOT EXISTS "author_role" character varying(50)
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_remarks"
        ADD COLUMN IF NOT EXISTS "assignment_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_remarks"
        ADD CONSTRAINT "fk_assayer_remarks_assignment"
        FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL
    `);
    // Cannot be CONCURRENTLY inside TypeORM's migration transaction; the table is tiny.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayer_remarks_assayer_recent"
        ON "assayer_remarks" ("assayer_id", "created_at" DESC)
        WHERE "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayer_remarks_assayer_recent"`);
    await queryRunner.query(`ALTER TABLE "assayer_remarks" DROP CONSTRAINT IF EXISTS "fk_assayer_remarks_assignment"`);
    await queryRunner.query(`ALTER TABLE "assayer_remarks" DROP COLUMN IF EXISTS "assignment_id"`);
    await queryRunner.query(`ALTER TABLE "assayer_remarks" DROP COLUMN IF EXISTS "author_role"`);
    await queryRunner.query(`ALTER TABLE "assayer_remarks" DROP CONSTRAINT IF EXISTS "chk_assayer_remarks_rating_range"`);
    await queryRunner.query(`
      ALTER TABLE "assayer_remarks"
        ALTER COLUMN "rating" TYPE numeric(3,2) USING "rating"::numeric(3,2)
    `);
  }
}
