import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `assayer_location_pings` from a plain heap to native monthly RANGE partitioning on
 * `recorded_at`.
 *
 * ## Why now
 *
 * `1790600000000-DataLifecycleIndexes` documented the partition plan and deliberately deferred it
 * — the table was 32 rows and partitioning a near-empty table buys nothing. The retention decision
 * has since been made explicitly: KEEP the 550-day window, but stop paying for it with batched
 * DELETEs and VACUUM once the table is large. Dropping a month becomes `DROP TABLE`, which is O(1)
 * and leaves no dead tuples behind — see the measured comparison in that migration's docblock
 * (185 ms partition drop vs ~161 s of batched deletes for the same month).
 *
 * ## Shape of the conversion
 *
 * Postgres cannot convert a heap table to partitioned in place — it requires create-partitioned →
 * copy → swap, done here as:
 *
 *   1. Rename the existing table out of the way (`_old` suffix). Cheap: a catalog rename, not a
 *      rewrite.
 *   2. Create the new partitioned parent under the original name, same columns.
 *   3. Attach a single DEFAULT partition, so every existing row — whatever it dates to — has
 *      somewhere to land without this migration having to enumerate however many months of
 *      history already exist. This is the "one initial catch-all partition" the retention decision
 *      calls out as acceptable; splitting pre-existing rows into real monthly partitions can happen
 *      later, online, with `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ... TO ...` plus
 *      `pg_partman`-style detach/reattach, and buys nothing today because there is no data to
 *      benefit from finer granularity yet.
 *   4. Create an explicit partition for the current month, so today's writes land in a real
 *      monthly partition rather than the default one from minute one.
 *   5. Copy every row across.
 *   6. Recreate the indexes and the FK on the parent — Postgres propagates both to every partition,
 *      present and future, automatically.
 *   7. Drop the old table.
 *
 * ## The primary key had to change
 *
 * Postgres requires every unique constraint on a partitioned table — the primary key included —
 * to contain the partition key. The old PK was `(id)` alone. Widening it to `(id, recorded_at)` is
 * safe here specifically because nothing in the schema foreign-keys to `assayer_location_pings.id`
 * (verified: no other table references this one). The composite PK still makes each row unique by
 * `id`, which is all any caller was ever relying on — `location-trail.service.ts` never looks a
 * ping up by `id` alone.
 *
 * `uq_location_pings_assayer_instant (assayer_id, recorded_at)` did not need to change: it already
 * carries the partition key as its second column, which is exactly why the task that ordered this
 * conversion called it out as the one to keep as-is.
 *
 * ## Table name stays the same
 *
 * The entity (`assayer-location-ping.entity.ts`) still says `@Entity('assayer_location_pings')`,
 * unchanged. TypeORM and Postgres both treat a partitioned parent as an ordinary table for DML —
 * `INSERT`, `SELECT`, `UPDATE`, `DELETE` all route to the right partition on their own — so no
 * application code needed to change for this migration to take effect.
 */
export class PartitionLocationPingsByMonth1794610000000 implements MigrationInterface {
  name = 'PartitionLocationPingsByMonth1794610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: old table out of the way. Rename, not drop — nothing is destroyed until the copy
    // and the row-count check below both succeed.
    await queryRunner.query(`ALTER TABLE "assayer_location_pings" RENAME TO "assayer_location_pings_old"`);
    await queryRunner.query(
      `ALTER INDEX "PK_0efc5719e251761d893ea8b7b63" RENAME TO "PK_0efc5719e251761d893ea8b7b63_old"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_location_pings_assignment" RENAME TO "idx_location_pings_assignment_old"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_location_pings_recorded_at" RENAME TO "idx_location_pings_recorded_at_old"`,
    );
    await queryRunner.query(
      `ALTER INDEX "uq_location_pings_assayer_instant" RENAME TO "uq_location_pings_assayer_instant_old"`,
    );

    // Step 2: the partitioned parent. Same columns as the baseline schema plus the migrations that
    // followed it; PRIMARY KEY widened to (id, recorded_at) for the reason in the class docblock.
    await queryRunner.query(`
      CREATE TABLE "assayer_location_pings" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by"      character varying,
        "created_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by"      character varying,
        "updated_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"         integer NOT NULL DEFAULT 1,
        "is_active"       boolean NOT NULL DEFAULT true,
        "assayer_id"      uuid NOT NULL,
        "assignment_id"   uuid,
        "latitude"        numeric(10,7) NOT NULL,
        "longitude"       numeric(10,7) NOT NULL,
        "location"        geometry(Point,4326),
        "accuracy_meters" integer,
        "speed_mps"       numeric(8,2),
        "recorded_at"     TIMESTAMP WITH TIME ZONE NOT NULL,
        "received_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "source"          character varying(20) NOT NULL DEFAULT 'APP_TRACKING',
        "is_mocked"       boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_0efc5719e251761d893ea8b7b63" PRIMARY KEY ("id", "recorded_at")
      ) PARTITION BY RANGE ("recorded_at")
    `);

    // Step 3: the catch-all. Every row that predates this migration, whatever month it falls in,
    // lands here. Splitting it into real monthly partitions is a later, online, optional step.
    await queryRunner.query(`
      CREATE TABLE "assayer_location_pings_default"
      PARTITION OF "assayer_location_pings" DEFAULT
    `);

    // Step 4: today's month gets a real partition from the start, so the default partition never
    // grows from live traffic — only from history. `partitionNameFor` in
    // `location-ping-partitions.ts` computes this same name; kept in sync by
    // `location-ping-partitions.spec.ts`.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const partitionName = `assayer_location_pings_y${monthStart.getUTCFullYear()}m${String(
      monthStart.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    await queryRunner.query(`
      CREATE TABLE "${partitionName}"
      PARTITION OF "assayer_location_pings"
      FOR VALUES FROM ('${monthStart.toISOString()}') TO ('${nextMonthStart.toISOString()}')
    `);

    // Step 5: copy every row across. Both tables are append-only and nothing writes to the old
    // name any more once the RENAME above executed, so this is a stable snapshot.
    await queryRunner.query(`
      INSERT INTO "assayer_location_pings"
        ("id", "created_by", "created_at", "updated_by", "updated_at", "version", "is_active",
         "assayer_id", "assignment_id", "latitude", "longitude", "location", "accuracy_meters",
         "speed_mps", "recorded_at", "received_at", "source", "is_mocked")
      SELECT
         "id", "created_by", "created_at", "updated_by", "updated_at", "version", "is_active",
         "assayer_id", "assignment_id", "latitude", "longitude", "location", "accuracy_meters",
         "speed_mps", "recorded_at", "received_at", "source", "is_mocked"
      FROM "assayer_location_pings_old"
    `);

    // Step 6: indexes and FK on the parent. Postgres creates a matching index on every existing
    // partition and on every partition created after this point — no per-partition DDL needed.
    await queryRunner.query(`
      CREATE INDEX "idx_location_pings_assignment"
      ON "assayer_location_pings" ("assignment_id")
      WHERE "assignment_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_location_pings_recorded_at"
      ON "assayer_location_pings" ("recorded_at")
    `);
    // Already includes the partition key (recorded_at is the second column), which is exactly
    // what Postgres requires of a unique index on a partitioned table.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_location_pings_assayer_instant"
      ON "assayer_location_pings" ("assayer_id", "recorded_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_location_pings"
      ADD CONSTRAINT "FK_d135c71491886f7dc0aa8f400f4"
      FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE
    `);

    // Step 7: verify before destroying anything, then drop the old heap.
    const [{ old_count }] = await queryRunner.query(
      `SELECT count(*)::int AS old_count FROM "assayer_location_pings_old"`,
    );
    const [{ new_count }] = await queryRunner.query(
      `SELECT count(*)::int AS new_count FROM "assayer_location_pings"`,
    );
    if (old_count !== new_count) {
      throw new Error(
        `Location ping partition migration: row count mismatch (old=${old_count}, new=${new_count}). ` +
          `Not dropping the old table — investigate before re-running.`,
      );
    }
    await queryRunner.query(`DROP TABLE "assayer_location_pings_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original unpartitioned shape with data, mirroring `up()` in reverse.
    await queryRunner.query(`ALTER TABLE "assayer_location_pings" RENAME TO "assayer_location_pings_partitioned"`);

    await queryRunner.query(`
      CREATE TABLE "assayer_location_pings" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by"      character varying,
        "created_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by"      character varying,
        "updated_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"         integer NOT NULL DEFAULT 1,
        "is_active"       boolean NOT NULL DEFAULT true,
        "assayer_id"      uuid NOT NULL,
        "assignment_id"   uuid,
        "latitude"        numeric(10,7) NOT NULL,
        "longitude"       numeric(10,7) NOT NULL,
        "location"        geometry(Point,4326),
        "accuracy_meters" integer,
        "speed_mps"       numeric(8,2),
        "recorded_at"     TIMESTAMP WITH TIME ZONE NOT NULL,
        "received_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "source"          character varying(20) NOT NULL DEFAULT 'APP_TRACKING',
        "is_mocked"       boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_0efc5719e251761d893ea8b7b63" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "assayer_location_pings"
        ("id", "created_by", "created_at", "updated_by", "updated_at", "version", "is_active",
         "assayer_id", "assignment_id", "latitude", "longitude", "location", "accuracy_meters",
         "speed_mps", "recorded_at", "received_at", "source", "is_mocked")
      SELECT
         "id", "created_by", "created_at", "updated_by", "updated_at", "version", "is_active",
         "assayer_id", "assignment_id", "latitude", "longitude", "location", "accuracy_meters",
         "speed_mps", "recorded_at", "received_at", "source", "is_mocked"
      FROM "assayer_location_pings_partitioned"
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_location_pings_assignment"
      ON "assayer_location_pings" ("assignment_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_location_pings_recorded_at"
      ON "assayer_location_pings" ("recorded_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_location_pings_assayer_instant"
      ON "assayer_location_pings" ("assayer_id", "recorded_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_location_pings"
      ADD CONSTRAINT "FK_d135c71491886f7dc0aa8f400f4"
      FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE
    `);

    // Drops the partitioned parent and every partition beneath it in one statement.
    await queryRunner.query(`DROP TABLE "assayer_location_pings_partitioned"`);
  }
}
