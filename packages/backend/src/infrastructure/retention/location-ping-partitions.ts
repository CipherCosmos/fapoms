import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Monthly partition arithmetic and maintenance for `assayer_location_pings`.
 *
 * Kept separate from `RetentionService` (which decides *when* a partition should go away) and from
 * `LocationTrailService` (which writes and reads pings, never their storage shape) because this
 * file is about the physical layout the migration created — naming a partition and knowing its
 * boundaries — and that logic needs to be exercised with plain arithmetic tests, not a database.
 *
 * See `1794610000000-PartitionLocationPingsByMonth` for how the table got here and why the
 * boundary format below (`FOR VALUES FROM ... TO ...`, half-open, UTC) has to match it exactly.
 */

/** One calendar month's partition: its table name and the half-open range it must own. */
export interface PartitionMonth {
  name: string;
  /** Inclusive lower bound, UTC midnight on the 1st. */
  from: Date;
  /** Exclusive upper bound, UTC midnight on the 1st of the following month. */
  to: Date;
}

const PARENT_TABLE = 'assayer_location_pings';

/**
 * The partition name for the month containing `date`, in UTC.
 *
 * UTC, not server/local time, because `recorded_at` is `timestamptz` — Postgres always ranges a
 * partition bound in UTC internally, so computing the name in any other zone risks picking a name
 * that looks right locally but names the wrong boundary once compared against the stored instant.
 */
export function partitionNameFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${PARENT_TABLE}_y${year}m${String(month).padStart(2, '0')}`;
}

/** The `[from, to)` boundary Postgres needs for `FOR VALUES FROM (...) TO (...)`, for `date`'s month. */
export function partitionBoundsFor(date: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { from, to };
}

/** Name and bounds together, for one month. */
export function partitionFor(date: Date): PartitionMonth {
  const { from, to } = partitionBoundsFor(date);
  return { name: partitionNameFor(date), from, to };
}

/**
 * The partitions that must exist right now: the current month plus `monthsAhead` more.
 *
 * Ahead-of-need creation is the point. A missing partition is not a slow query, it is an INSERT
 * failing outright — `assayer_location_pings` has no DEFAULT partition wide enough to swallow
 * every future month by design (see the migration), so an assayer's fix landing in a month nobody
 * created a partition for is rejected at the exact moment somebody is trying to record it. Two
 * months ahead absorbs an hourly job missing a run or two without that ever becoming visible to a
 * field app.
 */
export function upcomingPartitions(now: Date, monthsAhead = 2): PartitionMonth[] {
  const months: PartitionMonth[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    months.push(partitionFor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))));
  }
  return months;
}

/**
 * A partition whose entire range is older than `cutoff` — safe to drop outright rather than
 * DELETE row by row. "Entire range" is the safety property: a partition dropped while any of its
 * rows are still inside the retention window would destroy live evidence, so this only ever
 * returns partitions whose `to` (exclusive upper bound) is at or before the cutoff.
 */
export interface DroppablePartition {
  name: string;
  to: Date;
}

/**
 * Creates whatever of `upcomingPartitions(now)` does not already exist.
 *
 * Idempotent and safe to call every hour: `IF NOT EXISTS` makes a repeat call a no-op, and nothing
 * here touches a partition that already exists — extending its bounds is not attempted because
 * Postgres does not support it (a partition's range is fixed at creation; changing it means drop
 * and recreate, which this function deliberately never does to a partition that might hold rows).
 */
export async function ensureFuturePartitions(
  dataSource: Pick<DataSource, 'query'>,
  logger: Logger,
  now: Date = new Date(),
): Promise<string[]> {
  const created: string[] = [];
  for (const month of upcomingPartitions(now)) {
    const result = await dataSource.query(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
      [month.name],
    );
    if (Array.isArray(result) && result.length > 0) continue;

    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS "${month.name}"
      PARTITION OF "${PARENT_TABLE}"
      FOR VALUES FROM ('${month.from.toISOString()}') TO ('${month.to.toISOString()}')
    `);
    created.push(month.name);
    logger.log(`Created location-ping partition ${month.name} (${month.from.toISOString()} .. ${month.to.toISOString()}).`);
  }
  return created;
}

/**
 * The real, attached, dated partitions of `assayer_location_pings` whose entire range is at or
 * before `cutoff` — i.e. safe to `DROP TABLE`.
 *
 * Deliberately excludes `assayer_location_pings_default`: it is not dated, may still hold rows
 * from any period (it is where every pre-partitioning row landed — see the migration), and
 * dropping it would be dropping an unknown mix of old and, potentially, not-yet-old data. The
 * default partition is retired by `RetentionService`'s batched-DELETE fallback, same as before
 * this migration, until it is empty enough to drop by hand.
 *
 * Reads `pg_inherits` / `pg_get_expr` rather than trusting the name, because the name is only a
 * convention this codebase follows — the actual boundary Postgres enforces is what must gate a
 * drop that cannot be undone.
 */
export async function droppablePartitions(
  dataSource: Pick<DataSource, 'query'>,
  cutoff: Date,
): Promise<DroppablePartition[]> {
  const rows = await dataSource.query(
    `
    SELECT
      child.relname AS name,
      pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    WHERE parent.relname = $1
      AND child.relname <> $2
    `,
    [PARENT_TABLE, `${PARENT_TABLE}_default`],
  );

  const droppable: DroppablePartition[] = [];
  for (const row of rows as Array<{ name: string; bound: string }>) {
    // relpartbound renders as `FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00')`.
    const match = row.bound.match(/TO \('([^']+)'\)/);
    if (!match) continue;
    const to = new Date(match[1]);
    if (Number.isNaN(to.getTime())) continue;
    if (to.getTime() <= cutoff.getTime()) {
      droppable.push({ name: row.name, to });
    }
  }
  return droppable;
}

/**
 * Drops every partition `droppablePartitions` names as fully past `cutoff`.
 *
 * `DROP TABLE`, not `TRUNCATE` — the partition itself is retired, not just emptied, so its
 * catalog entry and any partition-local statistics go with it. Each drop is its own statement:
 * one partition failing to drop (a lock held by a long-running read, say) must not stop the others
 * from going, the same reasoning `RetentionService.deleteInBatches` already applies per batch.
 */
export async function dropExpiredPartitions(
  dataSource: Pick<DataSource, 'query'>,
  logger: Logger,
  cutoff: Date,
): Promise<{ dropped: string[]; failures: Array<{ name: string; error: unknown }> }> {
  const dropped: string[] = [];
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const partition of await droppablePartitions(dataSource, cutoff)) {
    try {
      await dataSource.query(`DROP TABLE IF EXISTS "${partition.name}"`);
      dropped.push(partition.name);
      logger.log(`Dropped expired location-ping partition ${partition.name} (ended ${partition.to.toISOString()}).`);
    } catch (error) {
      logger.error(`Failed to drop location-ping partition ${partition.name}: ${(error as Error).message}`);
      failures.push({ name: partition.name, error });
    }
  }
  return { dropped, failures };
}
