import * as fs from 'fs';
import * as path from 'path';

/**
 * The indexes retention depends on must exist in the ACTIVE migration chain.
 *
 * ## Why this test exists
 *
 * This is the same guard as `infrastructure/database/scale-indexes.spec.ts`, for the same reason
 * and against the same accident. In August 2026 the migration chain was regenerated from the
 * entity classes into one baseline; every index that existed only as raw SQL moved to
 * `_historical/`, which the loader does not read, and stopped being applied. Nothing failed — a
 * missing index is invisible to correctness — and the live database ran on sequential scans until
 * somebody checked `pg_indexes` by hand.
 *
 * These two are exposed to exactly that. Neither can be declared as an `@Index` on its entity from
 * this work (the notification and ping entities are outside its remit), so the migration is their
 * only home and a regeneration would silently take them.
 *
 * ## Why it is not merely a performance regression
 *
 * Without them the purge statements are full table scans plus top-N heapsorts, run up to ten times
 * per table per hour, against the two tables projected to grow fastest. Measured on a scratch
 * clone: 66,670 buffers instead of 128 for the location trail at 3M rows, 77,000 instead of 138
 * for notifications at 2M. Retention would then cost more I/O than the growth it prevents — the
 * cleanup job becomes the load problem — and the natural response to that is to switch retention
 * off, which puts the database back where it started.
 *
 * The second half asserts the *statements* still match the indexes. An index and a query that no
 * longer agree is the failure mode neither file alone would catch: dropping `ORDER BY recorded_at`
 * from the purge looks like a harmless tidy-up and silently returns it to a sequential scan.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../database/migrations');
const RETENTION_SERVICE = path.join(__dirname, 'retention.service.ts');
const AUTH_SERVICE = path.resolve(__dirname, '../../modules/auth/auth.service.ts');

/** Indexes the purge statements are written against, and the table each belongs to. */
const REQUIRED_INDEXES: Array<[name: string, table: string]> = [
  ['idx_location_pings_recorded_at', 'assayer_location_pings'],
  ['idx_notifications_read_created', 'notifications'],
];

function activeMigrationSources(): string {
  // Single level only — mirrors the loader glob in data-source.ts. `_historical/` is exactly
  // where these would be lost, so it must NOT count.
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

describe('the indexes retention depends on', () => {
  const migrations = activeMigrationSources();

  it.each(REQUIRED_INDEXES)('an active migration creates %s on %s', (name, table) => {
    expect(migrations).toMatch(
      new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+"${name}"\\s+ON\\s+"${table}"`, 'i'),
    );
  });

  it('the notification index is partial on is_read, so it stays proportional to the backlog', () => {
    // A plain index would also cover the unread rows the purge can never touch, paying write
    // cost on the notification fan-out path (10 rows per assignment) for nothing.
    expect(migrations).toMatch(
      /"idx_notifications_read_created"\s+ON\s+"notifications"\s+\("created_at"\)\s+WHERE\s+"is_read"\s*=\s*true/i,
    );
  });

  describe('the purge statements still match them', () => {
    const retention = fs.readFileSync(RETENTION_SERVICE, 'utf8');
    const auth = fs.readFileSync(AUTH_SERVICE, 'utf8');

    it.each([
      ['assayer_location_pings', /recorded_at < \$1\s+ORDER BY recorded_at/],
      ['notifications', /is_read = true AND created_at < \$1\s+ORDER BY created_at/],
      ['outbox_events', /dispatched_at < \$1\s+ORDER BY dispatched_at/],
    ])('%s selects on the indexed column, oldest first', (_table, shape) => {
      expect(retention).toMatch(shape);
    });

    it('refresh tokens are swept on expires_at, which is already indexed', () => {
      expect(auth).toMatch(/expires_at < \$1\s+ORDER BY expires_at/);
    });
  });
});
