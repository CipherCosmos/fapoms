import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The three list screens that page by keyset had nothing to page along.
 *
 * `assignments` already carries `idx_assignments_recent_page` — `(created_at DESC, id) WHERE
 * is_active` — for exactly this shape. The roster, the document list and the validation queue
 * order by the same kind of key and had no index covering it, so every page was a full scan of
 * the table plus a top-N sort, at any depth.
 *
 * Measured on a 200,000-row copy of the real `assayers` definition, with its twenty real indexes
 * present, before and after:
 *
 *   first page        30.6 ms, 6,878 buffers   ->   0.027 ms, 4 buffers
 *   deep keyset page  38.7 ms, 6,818 buffers   ->   0.500 ms, 4 buffers
 *
 * The second row is the one that matters. Keyset pagination exists so that page 5,000 costs what
 * page 1 costs; without a covering index it degrades to a full scan on every page and the cursor
 * buys nothing. With the index the cost is four buffers regardless of depth, which is the property
 * the cursor was written to provide.
 *
 * The roster is the screen most likely to be exhausted: its limit ceiling is 1,000 where every
 * other list caps at 200.
 *
 * Each index is partial on `is_active`, matching both the queries and the `assignments` precedent —
 * the lists never show archived rows, so indexing them would pay for entries no query reads.
 */
export class KeysetPageIndexes1798100000000 implements MigrationInterface {
  name = 'KeysetPageIndexes1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_recent_page"
        ON "assayers" ("created_at" DESC, "id" DESC) WHERE "is_active" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_documents_recent_page"
        ON "documents" ("created_at" DESC, "id" DESC) WHERE "is_active" = true
    `);
    /**
     * The validation queue leads on the SLA clock, not on arrival — `sla_due_date ASC NULLS LAST,
     * created_at DESC, id DESC`. NULLS LAST is part of the key, not a detail: a query ordered
     * NULLS LAST cannot use an index built NULLS FIRST, which is the default for ASC.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_validation_queries_sla_page"
        ON "validation_queries" ("sla_due_date" ASC NULLS LAST, "created_at" DESC, "id" DESC)
        WHERE "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_validation_queries_sla_page"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_documents_recent_page"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_recent_page"`);
  }
}
