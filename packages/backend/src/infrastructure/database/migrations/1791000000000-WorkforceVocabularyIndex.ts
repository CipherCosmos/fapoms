import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One index that makes `COUNT(DISTINCT assayer_id)` on `workforce_attributes` cheap.
 *
 * ## What was actually measured, and why this is the only change
 *
 * Phase 4 of the 2026-08-16 audit flagged every exact `COUNT(DISTINCT …)` on a hot path. Six of
 * the flagged sites were in `hr-workforce.service.ts` and two in `assayer.service.ts`. They were
 * measured before anything was touched, rather than rewritten on the strength of the pattern.
 *
 * The 200k-row fixture (`fapoms_scale2`) turned out to say nothing useful on its own: the scaling
 * work populated `assignments`, not the HR tables, so it carries 189 `workforce_attributes` rows
 * and ZERO document rows. Every flagged query runs in 0.2–1.4 ms there. So the measurement was
 * repeated on a scratch copy with those tables filled to match the fixture's 5,038-assayer roster
 * at the real per-person ratio observed in the dev database (~8 attributes each → 40,405 rows;
 * 15,081 government documents; 20,108 files). Warm, five runs, median:
 *
 *   site                                            today    at 5,038 profiled   with this index
 *   ──────────────────────────────────────────────────────────────────────────────────────────
 *   hr-workforce.ts:313  document coverage           1.0 ms      13.1 ms            13.1 ms
 *   hr-workforce.ts:414  capability by type          0.3 ms      80.1 ms            19.2 ms
 *   hr-workforce.ts:425  capability coverage         1.2 ms      18.6 ms            14.3 ms
 *   assayer.ts:385       attribute vocabulary        0.2 ms      75.6 ms             5.3 ms
 *
 * In every slow case the plan was identical in shape: a `GroupAggregate` over `(type, name)` that
 * cannot be hashed — Postgres has no hashed aggregation for `DISTINCT` aggregates — so it sorts
 * all 40k rows by `(type, name, assayer_id)` first. The scan itself costs 3–13 ms; the sort adds
 * ~70 ms, because `type` and `name` are `varchar` under a libc `en_US.utf8` collation and a
 * three-key string comparison at that collation is expensive. This index is exactly that sort
 * order, so the aggregate reads pre-sorted tuples straight out of an index-only scan.
 *
 * ## Why an index rather than rewriting the queries
 *
 * The obvious rewrite — pre-aggregate in a subquery so the planner can use `HashAggregate`,
 * `SELECT type, name, COUNT(*) FROM (SELECT DISTINCT type, name, assayer_id …) GROUP BY 1,2` —
 * was written and measured too. It helps, but far less, and it is actively counterproductive once
 * this index exists, because the hash path goes back to a sequential scan:
 *
 *   vocabulary, pre-aggregated, no index   26.4 ms   (vs 75.6 ms original — 2.9x)
 *   vocabulary, original, with this index   5.3 ms   (14.3x)
 *   vocabulary, pre-aggregated, with index  21.1 ms  (4x WORSE than leaving the SQL alone)
 *
 * So the queries are deliberately left exactly as they were. That also means the results cannot
 * have changed: the SQL text is untouched, and the full result sets were diffed with and without
 * the index on the scratch copy anyway — 201 lines, identical, including row order, which matters
 * because the vocabulary's `ORDER BY count DESC` is what ranks the picker's suggestions.
 *
 * ## What this index deliberately does NOT try to fix
 *
 * `hr-workforce.ts:313` (document coverage) is untouched by it — that one counts distinct
 * assayers in `assayer_government_documents` / `assayer_documents`, both of which already have an
 * `assayer_id` index, and its 13 ms is dominated by the unavoidable 5,026-row roster count beside
 * it, not by the distinct counts. It sits behind a 30 s server-side cache on an HR-only page, so
 * 13 ms twice a minute is not worth an index that would only shave part of it.
 *
 * ## Why partial, and why the existing `(type, name)` index stays
 *
 * Every call site filters `is_active = true`, so a partial index is both smaller and sufficient.
 * The pre-existing `IDX_20b3a9b5fc1907cbcaf7852e5c` on `(type, name)` is left in place: it covers
 * rows this one excludes, and dropping an index to save writes on a table that is written only
 * when an HR user saves a profile would be trading a real risk for an imaginary saving.
 *
 * Also declared as `@Index` on `WorkforceAttributeEntity`, per the rule established by
 * `1790300000000-RestoreScaleIndexes`: an index that exists only in a migration is an index that
 * a future entity-generated baseline will silently drop.
 */
export class WorkforceVocabularyIndex1791000000000 implements MigrationInterface {
  name = 'WorkforceVocabularyIndex1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Column order is the aggregate's required sort order, not a guess: `GROUP BY type, name`
    // with `COUNT(DISTINCT assayer_id)` needs input sorted by all three, in that sequence.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_workforce_attributes_vocabulary"
      ON "workforce_attributes" ("type", "name", "assayer_id")
      WHERE "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_workforce_attributes_vocabulary"`);
  }
}
