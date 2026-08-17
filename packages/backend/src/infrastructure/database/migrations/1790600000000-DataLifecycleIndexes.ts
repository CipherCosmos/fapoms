import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two indexes without which retention cannot run — and the reasoning for why the append
 * tables are NOT being converted to partitioned tables in this migration.
 *
 * ## Why this migration exists
 *
 * `1790300000000-RestoreScaleIndexes` restored every index the *read* paths need. It did not add
 * any for the *delete* paths, because until now nothing in FAPOMS ever deleted a row. The audit
 * of 2026-08-16 found exactly one DELETE in the whole service layer — `LocationTrailService
 * .purgeOlderThanRetention` — and it was dormant (`locationTrail.retentionDays` defaults to null),
 * so its query plan had never been looked at.
 *
 * It is a full sequential scan plus a top-N heapsort, per tick.
 *
 * Measured 2026-08-17 on a scratch clone of the live schema loaded with 3,000,000 pings (871 MB),
 * running the exact statement the purge issues — `DELETE … WHERE id IN (SELECT id FROM
 * assayer_location_pings WHERE recorded_at < $1 ORDER BY recorded_at LIMIT 5000)`:
 *
 *   | index set                        | buffers read to select 5,000 rows |
 *   |----------------------------------|-----------------------------------|
 *   | as shipped today                 | 66,670  (521 MB — Seq Scan + top-N heapsort) |
 *   | with `idx_location_pings_recorded_at` | **128** (1 MB — Index Scan, no sort)  |
 *
 * A 520× reduction, and — the part that actually matters — a *bounded* one: the index scan reads
 * 5,000 entries whatever the table's size or physical layout, while the sequential scan grows with
 * the table. The SLA scanner runs the purge up to ten times per tick, every fifteen minutes. At the
 * projected size of this table (≈480 fixes per audit; 9 GB/year at 200 audits/day, 93 GB/year at
 * 2,000/day) the version without the index reads tens of gigabytes an hour to delete 50,000 rows.
 *
 * The same measurement for the read-notification purge on 2,000,000 notifications, 80% read:
 * 77,000 buffers (600 MB Seq Scan + top-N heapsort) → **138 buffers** with the partial index.
 *
 * ## What is deliberately NOT here
 *
 * **`outbox_events` and `refresh_tokens` need nothing.** Verified on the same scratch clone with
 * 2,000,000 outbox rows and 1,000,000 refresh tokens: the existing `IDX_e58bf63cc50ef5e4503d6836df
 * (dispatched_at, occurred_at)` already serves `WHERE dispatched_at < $1 ORDER BY dispatched_at
 * LIMIT 5000` as a 110-buffer index scan, and `IDX_ba3bd69c8ad1e799c0256e9e50 (expires_at)` serves
 * the refresh-token sweep in 131 buffers. Adding indexes for those would be write cost for nothing.
 * `RetentionService` is written to issue precisely the statements those two indexes already cover.
 *
 * **No BRIN.** BRIN was the obvious candidate for `assayer_location_pings.recorded_at`: 88 kB
 * against the btree's 64 MB (at 3M rows), on the highest-insert-rate table in the schema. It was
 * measured and rejected, for a reason that only shows up once retention is actually running:
 *
 *   - BRIN cannot serve `ORDER BY recorded_at`, so with BRIN the purge has to drop the ordering
 *     and rely on the oldest rows being physically first. That is true of a pristine append-only
 *     table and false of one retention has been deleting from — VACUUM returns the freed early
 *     pages to the free-space map and new fixes land in them.
 *   - Simulated exactly that (delete the oldest 500k, VACUUM, insert 500k fresh): the correlation
 *     of `recorded_at` to physical order fell from 1.0 to **0.158**, and the unordered LIMIT-5000
 *     selection went from 127 buffers to **11,126** — it had to skip 490,640 recent rows to find
 *     5,000 old ones. Degrading with age is the worst possible property for a cleanup job.
 *   - The btree, with the `ORDER BY` kept, was 128 buffers on the *same* recycled table.
 *
 * 64 MB of index per 3M rows (≈21 bytes/row, 7% of the table) is the price of a purge whose cost
 * does not depend on how long the purge has been running. It is worth paying.
 *
 * **No partitioning.** Monthly range partitioning of `audit_events` (by `occurred_at`) and
 * `assayer_location_pings` (by `recorded_at`) is the right long-term shape for both — dropping a
 * month becomes a `DROP TABLE` instead of millions of row deletes, and no VACUUM is needed after.
 * It is not done here, and the blocker is not nerve:
 *
 *   1. **Postgres requires the partition key in every UNIQUE/PRIMARY KEY constraint.** Both tables
 *      have `PRIMARY KEY (id)`, which would have to become `(id, occurred_at)` / `(id,
 *      recorded_at)`.
 *   2. **The entities declare a single-column `@PrimaryGeneratedColumn`.** Changing the database
 *      without changing `audit-event.entity.ts` and the ping entity leaves the schema and the
 *      entity model permanently disagreeing — `migration:generate` would emit a "fix" that reverts
 *      the partitioning, and a `DB_SYNCHRONIZE=true` environment would try to apply it. That is a
 *      loaded gun pointed at the audit table.
 *   3. **Converting in place is a full rewrite under an ACCESS EXCLUSIVE lock**, because the only
 *      safe conversion is create-partitioned → copy → swap. Doing that blind, in an automatic
 *      migration that runs at container start, against a table whose live size nobody has measured
 *      from this repository, is how deploys hang.
 *
 * And the numbers say it is not needed yet: `audit_events` on the live server is 2,564 rows /
 * 1.8 MB. Partitioning a 1.8 MB table buys nothing; the amplification fix in
 * `rule-bypass.service.ts` and the retention worker are what keep these tables in range.
 *
 * ### What partitioning would actually buy, measured
 *
 * Measured 2026-08-17 on `part_test`: two tables holding identical data — 20,000,000 pings over
 * 600 days (5.9 GB, 2.1 GB of it index), one a plain heap with the shipped indexes, one the same
 * shape RANGE-partitioned by month. Both loaded from one generated set so the only difference is
 * the shape.
 *
 *   | operation                                     | heap (as shipped)        | partitioned |
 *   |-----------------------------------------------|--------------------------|-------------|
 *   | one retention tick (10 × 5,000 rows)          | 7.84 s                   | n/a         |
 *   | remove one month (~1,033,333 rows)            | ~161 s of statements —   | 185 ms      |
 *   |                                               | and 21 hourly ticks, by  | (DROP TABLE)|
 *   |                                               | the MAX_BATCHES policy   |             |
 *   | dead tuples left behind                       | 50,000 per tick          | 0           |
 *   | space returned to the filesystem              | none until VACUUM        | immediate   |
 *   | one assayer's trail for one day (read)        | 11 buffers / 3.2 ms      | 10 buffers  |
 *
 * The last row is the one that should temper any enthusiasm: **partitioning does nothing for the
 * read path here.** `uq_location_pings_assayer_instant (assayer_id, recorded_at)` already prunes
 * as well as a partition key would, because every real query on this table names an assayer. The
 * entire case for partitioning these tables is deletion and vacuum, not query speed.
 *
 * ### When the trigger fires — which is sooner than "not needed yet" suggests
 *
 * Assumptions, stated rather than presented as fact: 480 location fixes per audit (this repo's own
 * measured amplification, quoted in `RetentionService`'s class comment), a 550-day window, and a
 * steady state where rows aging out per day equal rows written per day. The purge ceiling is
 * BATCH_SIZE × MAX_BATCHES × 24 = 1.2 M rows/day.
 *
 *   | audits/day        | pings/day | steady-state rows | % of purge ceiling | vs 50 M trigger |
 *   |-------------------|-----------|-------------------|--------------------|-----------------|
 *   | 200 (current)     |    96,000 |            52.8 M |                 8% | **already at it** |
 *   | 500               |   240,000 |             132 M |                20% | 2.6×            |
 *   | 2,000 (modelled)  |   960,000 |             528 M |                80% | 10.6×           |
 *   | 2,500             | 1,200,000 |             660 M | **100% — falls behind permanently** | 13× |
 *
 * So the honest reading of "the numbers say it is not needed yet" is: it is not needed yet *because
 * retention has only just been switched on and the window has not filled*. At the low projection
 * this repo already uses — 200 audits/day — the table settles at roughly the 50 M trigger. The
 * decision to defer is still right; the belief that it is years away is not.
 *
 * Note the two limits are independent and the row-count one binds far earlier. Time is never the
 * problem: 7.84 s of statements per hour is nothing. The binding constraint is the deliberate
 * 50,000-rows-per-tick policy ceiling, and above ~2,500 audits/day no ceiling setting works,
 * because the purge would have to run continuously just to break even.
 *
 * ### The partition plan, for when it IS needed
 *
 * Trigger: either table passing ~50 million rows, or a purge tick failing to keep up. The second
 * used to be unobservable — the pass logged a row total, and 50,000 removed looks identical
 * whether the last batch drained the table or ten million rows are still queued. It is now an
 * explicit signal: `RetentionService` returns which tables stopped on the ceiling rather than on
 * the data, logs a WARN naming the table, and increments `retention_batches_saturated_total{table}`.
 * Alert on that counter staying above zero. Then, as a *separate, scheduled, offline* change — not
 * an automatic migration:
 *
 *   1. Change the entity PKs to composite (`@PrimaryColumn` on id + the time column) in the same
 *      release, so entities and schema stay in agreement.
 *   2. `CREATE TABLE audit_events_p (LIKE audit_events INCLUDING ALL) PARTITION BY RANGE
 *      (occurred_at);` then create partitions for every month present plus twelve ahead.
 *   3. Copy in month-sized batches with the application running (both tables are append-only, so
 *      a copy of everything older than "now" is stable), then take a short maintenance window to
 *      copy the tail and `ALTER TABLE … RENAME` the swap.
 *   4. Add a monthly "create next partition" job to `RetentionService` — a missing future
 *      partition is an INSERT failure on the audit path, which is the one failure mode partitioning
 *      introduces and the one that must never be left to chance.
 *   5. Retention for `assayer_location_pings` then becomes `DROP TABLE …_yYYYYmMM`, and the batched
 *      DELETE in `RetentionService` becomes the fallback for the current (unpartitioned) month only.
 *
 * `audit_events` is not in the retention worker's purge list at all and never should be — it is the
 * compliance record. Partitioning it is about vacuum and query cost, never about deleting it.
 *
 * ## Locking
 *
 * Plain `CREATE INDEX` takes a SHARE lock: concurrent reads are unaffected, writes to that table
 * block for the build. On the live server today these tables are small enough that the build is
 * milliseconds. If this ever reaches a database where they have already grown, build them by hand
 * first and let the migration no-op on `IF NOT EXISTS`:
 *
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_location_pings_recorded_at"
 *     ON "assayer_location_pings" ("recorded_at");
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_notifications_read_created"
 *     ON "notifications" ("created_at") WHERE "is_read" = true;
 *
 * `CONCURRENTLY` cannot be used inside the migration itself: TypeORM runs each migration in a
 * transaction and Postgres forbids it there.
 *
 * ## Naming
 *
 * Lowercase `idx_`, matching this repository's convention for indexes that exist **only** in a
 * migration (`idx_assayers_location_geography`, `idx_location_pings_assignment`) as opposed to the
 * `IDX_` set that is also declared with `@Index` on an entity. Neither of these can be declared on
 * an entity from this change: the ping and notification entities are outside this work's remit.
 * `retention-indexes.spec.ts` is what stops a future baseline regeneration from dropping them —
 * the same failure that lost the scale indexes in the first place.
 */
export class DataLifecycleIndexes1790600000000 implements MigrationInterface {
  name = 'DataLifecycleIndexes1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * The location-ping purge: `WHERE recorded_at < $1 ORDER BY recorded_at LIMIT $2`.
     *
     * `uq_location_pings_assayer_instant (assayer_id, recorded_at)` cannot serve it — recorded_at
     * is the second column, so a time-range scan across all assayers still has to read everything.
     * This is the leading-column index that turns the purge into a 5,000-entry index walk.
     *
     * It also gives the operations side a cheap "what was anyone doing between 14:00 and 15:00"
     * scan, which today is a full table scan for the same reason.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_location_pings_recorded_at"
      ON "assayer_location_pings" ("recorded_at")
    `);

    /**
     * The read-notification purge: `WHERE is_read = true AND created_at < $1 ORDER BY created_at`.
     *
     * Partial on `is_read` rather than a plain composite, for two reasons. Unread notifications are
     * never purged, so indexing them is pure write cost on the notification fan-out path (measured
     * at 10 notifications per assignment). And the partial index is only over the rows the purge
     * can act on, so it stays proportional to the backlog rather than to the table — 34 MB across
     * the 1.6M read rows of the 2M-row scratch table.
     *
     * `IDX_0f57a0c3adbbfd460935b7b046 (user_id, is_read, created_at)` looks like it should cover
     * this and does not: the purge has no `user_id` predicate, so the leading column is unusable.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notifications_read_created"
      ON "notifications" ("created_at")
      WHERE "is_read" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notifications_read_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_location_pings_recorded_at"`);
  }
}
