import type { DataSource } from 'typeorm';

/**
 * The one database-connectivity probe in this process.
 *
 * ## Why this is a file and not two lines inside a controller
 *
 * There were two endpoints claiming to report database connectivity and only one of them asked
 * the database. `/health` and `/health/ready` ran `SELECT 1`; `GET /auth/status` returned the
 * string literal `'connected'`, unconditionally, with no reference to a `DataSource` anywhere in
 * its body. An endpoint named "status" that cannot go red is worse than no endpoint at all —
 * a monitor wired to it reports a green light while the database is on fire, and the greener the
 * light the longer nobody looks.
 *
 * The fix is deliberately *not* a third `SELECT 1` copied into the auth controller. Three
 * implementations of "is the database up" drift into three different answers; this is the one
 * the honest endpoints already used, factored out so the dishonest one could adopt it rather
 * than approximate it.
 *
 * ## The contract
 *
 * `'up'` means a trivial round trip to the database completed. `'down'` means it did not, for
 * any reason at all — connection refused, pool exhausted, credentials rejected, statement
 * timeout, the `DataSource` never initialised. The distinction between those causes belongs in
 * the logs, not in a probe response read by a load balancer: from the caller's side they are
 * the same fact, which is that this replica cannot serve data right now.
 *
 * Never throws. A probe that can throw turns a degraded database into a 500 on the very
 * endpoint an operator uses to find out *why* they are getting 500s.
 */
export type DatabaseProbe = 'up' | 'down';

/**
 * `SELECT 1` is the whole probe: it touches no table, takes no lock, reads no row, and so is
 * safe to expose unauthenticated and cheap enough for a load balancer to hammer. It still fails
 * for every reason that matters — there is no way to complete it without an authenticated,
 * connected, responsive session.
 */
export async function probeDatabase(
  dataSource: Pick<DataSource, 'query'> | null | undefined,
): Promise<DatabaseProbe> {
  // No DataSource at all is not "unknown", it is "this process cannot reach a database".
  if (!dataSource) return 'down';
  try {
    await dataSource.query('SELECT 1');
    return 'up';
  } catch {
    return 'down';
  }
}
