import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheService } from '../cache/cache.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { AuthService } from '../../modules/auth/auth.service';
import { MetricsService } from '../observability/metrics.service';

/**
 * FAPOMS — the only *scheduled* thing in this system that deletes anything.
 *
 * (The other is `DataResetModule` — a super administrator clearing accumulated test/seed data on
 * demand, not a recurring job. Different trigger, different audience, same discipline: neither
 * touches `audit_events`, `workflow_history`, or anything this comment already says is evidence.)
 *
 * ## Why this exists
 *
 * The audit of 2026-08-16 established that **nothing is ever deleted**. The single DELETE in the
 * whole service layer was `LocationTrailService.purgeOlderThanRetention`, and it was dormant
 * because its retention setting defaults to null. Everything else — dispatched outbox rows,
 * expired refresh tokens, notifications read months ago — accumulates forever.
 *
 * That is not a slow leak, and the growth is real — but the amplification figures this comment
 * used to quote were not, and they are corrected here rather than left to be re-used.
 *
 * It claimed "122 audit rows per assignment, plus roughly 480 location fixes", projecting ~1 GB
 * and ~9 GB/year at 200 audits/day. Re-derived 2026-08-17 against the same dev database:
 *
 *   - **122 was `total audit rows ÷ assignment count`** — every row in the table, including ones
 *     nothing to do with an assignment, divided by 22 assignments. Worse, 1,509 of those 2,671
 *     rows (56%) are `RULE_BYPASSED` written during the bypass testing that produced the very fix
 *     in `rule-bypass.service.ts`, so the sample was measuring the test, not the workload.
 *     Excluding those: 52.8. Counting only `entity_type = 'ASSIGNMENT'`: **7.6**.
 *   - **480 was never measured.** This database holds 32 location fixes, all from one assayer. It
 *     is a *model* — 30-second cadence over a four-hour moving day, which is consistent with
 *     `location-policy.ts` (`timeInterval: 30_000`, `distanceInterval: 25`) — and it is a
 *     reasonable one. It is simply not an observation, and calling it measured invited everything
 *     downstream to treat it as ground truth.
 *
 * The true per-assignment audit rate is somewhere in 7.6–52.8 depending on how much surrounding
 * activity (user, assayer, document, schedule events) you attribute to the assignment that caused
 * it — a range nobody can narrow without production data, which is the honest state of it. The
 * storage projections built on 122 are therefore high by somewhere between 2x and 16x.
 *
 * None of which changes what this service does. The case for retention was never the exact
 * multiplier; it was that the multiplier is greater than zero and nothing ever deleted a row. The
 * production host has 11.5 GB of RAM and runs the API, Redis, MinIO and on-host image builds
 * alongside Postgres, and `assayer_location_pings` grows without bound inside its own 550-day
 * window regardless of which figure is right.
 *
 * ## What it does and does not delete
 *
 * Deletes, because the row has served its purpose and the fact it recorded survives elsewhere:
 *
 *  - **`outbox_events` that were dispatched.** The outbox exists to guarantee an event reaches its
 *    subscribers. Once `dispatched_at` is set that guarantee has been discharged; what the event
 *    *did* is recorded by the subscriber, and that it happened is in `audit_events`. Undispatched
 *    rows are never touched at any age — those are unresolved failures and deleting one would
 *    silently discard work.
 *  - **Expired `refresh_tokens`.** Rotation inserts a row per refresh against a ~15-minute access
 *    token and a 7-day refresh TTL, and nothing has ever removed one. An expired token cannot
 *    authenticate anything; the row is dead weight on a table that every single refresh reads.
 *  - **Read `notifications` past a long window.** An unread notification is work outstanding and is
 *    never purged regardless of age. A read one is a receipt.
 *  - **`assayer_location_pings` past the retention window.** The one genuinely difficult call —
 *    see `locationPingRetentionDays()`.
 *
 * Never deleted by this service, and the omissions are deliberate:
 *
 *  - **`audit_events`.** It is the compliance record. Its growth is a write-amplification problem
 *    (fixed at the source in `rule-bypass.service.ts`), never a deletion problem.
 *  - **`workflow_history`, `billing_history`, assignments, documents, invoices** — the operational
 *    record, and all of it is evidence for something.
 *  - **Undispatched outbox rows, unread notifications** — as above, unfinished work.
 *
 * ## Why it is safe to run against a live database
 *
 * Three properties, each of which had to be designed in rather than hoped for:
 *
 *  1. **Bounded transactions.** Every purge is a loop of independent `DELETE … WHERE id IN (SELECT
 *     … LIMIT batchSize)` statements. Each is its own transaction of at most `batchSize` rows, so
 *     the longest lock this service can ever hold is one batch — never "delete four years of
 *     history" as one statement that blocks writers and bloats WAL. The loop is bounded by
 *     `maxBatches` as well as by running out of rows, so one tick can never run away.
 *  2. **Index-backed selection.** Each statement is written to match an index that exists —
 *     see `1790600000000-DataLifecycleIndexes` for the measurements. Without that the selection is
 *     a full table scan per batch and the cleanup costs far more than the growth it prevents.
 *  3. **Cluster-safe.** Held under the same Redis lock the outbox relay uses. Two replicas both
 *     purging is not *incorrect* (the deletes are idempotent and disjoint by id), but it doubles
 *     the I/O for nothing. The lock fails open — if Redis is down the purge still runs, because a
 *     cleanup job that stops when the cache stops is a cleanup job that silently never runs.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  /**
   * Rows per statement. Small enough that one batch's lock and WAL record are unremarkable,
   * large enough that draining a long-neglected table does not take weeks of ticks: at 10 batches
   * per hourly run this clears 1.2 million rows/day per table.
   */
  private static readonly BATCH_SIZE = 5_000;

  /**
   * Batches per table per tick. The ceiling on how much work one run can do — without it, the
   * first run after this ships would try to delete the entire backlog in one job and hold the
   * queue (and a lot of dirty buffers) for as long as that took.
   */
  private static readonly MAX_BATCHES = 10;

  // ── Defaults ────────────────────────────────────────────────────────────────────────────────
  // Every one of these is overridable by environment variable (documented in
  // .env.production.example). They are days.

  /**
   * Dispatched outbox rows. The relay's own retry budget is 15 attempts at a one-minute tick —
   * a quarter of an hour. Seven days is two orders of magnitude beyond that, and exists purely so
   * that "did that event actually go out on Tuesday?" is answerable during the week it was asked.
   */
  private static readonly DEFAULT_OUTBOX_DAYS = 7;

  /**
   * Refresh tokens, counted past expiry. The refresh TTL is 7 days; 2 days past expiry keeps a
   * week's worth of session history for "when did this device last authenticate?" while
   * guaranteeing the table stays proportional to *active* sessions rather than to all sessions
   * ever. See `AuthService.pruneRefreshTokens` for why expiry alone is the right predicate.
   */
  private static readonly DEFAULT_REFRESH_TOKEN_GRACE_DAYS = 2;

  /**
   * Read notifications. Long enough that "what was I told about this branch last quarter?" is
   * still answerable from the bell icon, short enough to bound a table that grows at 10 rows per
   * assignment. The durable record of what happened is `audit_events`, which is not purged; a
   * notification is the delivery receipt for it.
   */
  private static readonly DEFAULT_READ_NOTIFICATION_DAYS = 180;

  /**
   * Location fixes. **This is the one with a real cost to getting wrong** — see
   * `locationPingRetentionDays()` for the reasoning behind 550.
   */
  private static readonly DEFAULT_LOCATION_PING_DAYS = 550;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: CacheService,
    private readonly settings: PlatformSettingsService,
    private readonly auth: AuthService,
    private readonly metrics: MetricsService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------------------------

  /**
   * One retention pass over every table this service owns.
   *
   * Phases are independent and every failure is contained to its phase, for the same reason the
   * SLA scanner works that way: a purge that aborts the run because one table's statement failed
   * means the other three tables silently stop being cleaned, and the phase most likely to fail is
   * the one working on the biggest table. Failures are collected and re-thrown as one aggregate so
   * Bull still records the tick as failed.
   */
  async runOnce(): Promise<RetentionReport> {
    return this.cache.withLock('lock:retention:purge', 900, () => this.purgeAll(), { retries: 0 });
  }

  private async purgeAll(): Promise<RetentionReport> {
    const started = Date.now();
    const report: RetentionReport = {
      outboxEvents: 0,
      refreshTokens: 0,
      notifications: 0,
      locationPings: 0,
      durationMs: 0,
      saturated: [],
      failures: [],
    };

    const phase = async (
      name: keyof RetentionReport & string,
      table: string,
      fn: () => Promise<BatchOutcome>,
    ) => {
      try {
        const { removed, saturated } = await fn();
        (report as any)[name] = removed;
        if (!saturated) return;

        report.saturated.push(table);
        this.metrics.retentionSaturated.inc({ table });
        // WARN, not LOG: this is the documented trigger for partitioning that table, and the
        // migration that declined to partition said it would be "visible as RetentionService
        // reporting a full batch on every pass". This is that line. One of these after a backlog
        // is expected; a run of them across passes means the tick can no longer keep up with the
        // write rate, and no amount of raising the ceiling changes the shape of the problem.
        this.logger.warn(
          `Retention phase "${name}" hit its batch ceiling: removed ${removed} row(s) from ` +
            `${table} (${RetentionService.MAX_BATCHES} × ${RetentionService.BATCH_SIZE}) and there ` +
            `are more waiting. If this repeats on every pass, ${table} has outgrown batched ` +
            `deletes — see 1790600000000-DataLifecycleIndexes for the partition plan.`,
        );
      } catch (error) {
        this.logger.error(`Retention phase "${name}" failed: ${(error as Error).message}`);
        report.failures.push({ phase: name, error });
      }
    };

    await phase('outboxEvents', 'outbox_events', () => this.purgeDispatchedOutboxEvents());
    await phase('refreshTokens', 'refresh_tokens', () => this.purgeDeadRefreshTokens());
    await phase('notifications', 'notifications', () => this.purgeReadNotifications());
    await phase('locationPings', 'assayer_location_pings', () => this.purgeLocationPings());

    report.durationMs = Date.now() - started;

    const total =
      report.outboxEvents + report.refreshTokens + report.notifications + report.locationPings;
    if (total > 0) {
      this.logger.log(
        `Retention pass removed ${total} row(s) in ${report.durationMs} ms — ` +
          `outbox ${report.outboxEvents}, refresh tokens ${report.refreshTokens}, ` +
          `notifications ${report.notifications}, location fixes ${report.locationPings}.`,
      );
    }

    if (report.failures.length > 0) {
      throw new AggregateError(
        report.failures.map((f) => f.error),
        `Retention: ${report.failures.length} of 4 phases failed (${report.failures
          .map((f) => f.phase)
          .join(', ')}).`,
      );
    }

    return report;
  }

  // ---------------------------------------------------------------------------------------------
  // The purges
  // ---------------------------------------------------------------------------------------------

  /**
   * Dispatched outbox rows past their window.
   *
   * `dispatched_at < $1` also excludes undispatched rows for free — NULL fails every comparison —
   * so there is no way for this statement to touch an event that has not been delivered, even if
   * the retention window were misconfigured to zero.
   *
   * Written to match `IDX_e58bf63cc50ef5e4503d6836df (dispatched_at, occurred_at)`, which already
   * exists: verified as a 110-buffer index scan against 2,000,000 rows.
   */
  private async purgeDispatchedOutboxEvents(): Promise<BatchOutcome> {
    const days = this.days('RETENTION_OUTBOX_DAYS', RetentionService.DEFAULT_OUTBOX_DAYS);
    if (days <= 0) return NOTHING_TO_DO;
    return this.deleteInBatches(
      `DELETE FROM outbox_events WHERE id IN (
         SELECT id FROM outbox_events
          WHERE dispatched_at < $1
          ORDER BY dispatched_at
          LIMIT $2
       )`,
      [this.cutoff(days)],
    );
  }

  /**
   * Expired refresh tokens.
   *
   * Delegated to `AuthService` rather than written here: `refresh_tokens` is the auth module's
   * table and what counts as a dead token is an auth question — this service owns the *schedule*,
   * not the definition. See `AuthService.pruneRefreshTokens`.
   */
  private async purgeDeadRefreshTokens(): Promise<BatchOutcome> {
    const graceDays = this.days(
      'RETENTION_REFRESH_TOKEN_GRACE_DAYS',
      RetentionService.DEFAULT_REFRESH_TOKEN_GRACE_DAYS,
    );
    if (graceDays < 0) return NOTHING_TO_DO;

    let removed = 0;
    for (let pass = 0; pass < RetentionService.MAX_BATCHES; pass++) {
      const deleted = await this.auth.pruneRefreshTokens(graceDays, RetentionService.BATCH_SIZE);
      removed += deleted;
      if (deleted < RetentionService.BATCH_SIZE) return { removed, saturated: false };
    }
    return { removed, saturated: true };
  }

  /**
   * Notifications that have been read and are past their window.
   *
   * `is_read = true` is the whole safety story: an unread notification is outstanding work and is
   * never removed here at any age, so the worst this can do is delete a receipt somebody has
   * already looked at.
   *
   * **One consequence worth stating plainly.** `notifications.dedupe_key` is UNIQUE, and dedupe is
   * what stops the 15-minute SLA scanner from re-notifying the same thing forever. Deleting an old
   * read notification frees its dedupe key, so a condition that is *still* true — an assayer
   * credential that has been expiring for seven months and still has not been renewed — will
   * notify again. That is arguably the correct behaviour (it is still expiring, and nobody acted)
   * and it is bounded by the retention window, but it is a real behaviour change and it is why the
   * default is 180 days rather than 30.
   */
  private async purgeReadNotifications(): Promise<BatchOutcome> {
    const days = this.days(
      'RETENTION_READ_NOTIFICATION_DAYS',
      RetentionService.DEFAULT_READ_NOTIFICATION_DAYS,
    );
    if (days <= 0) return NOTHING_TO_DO;
    return this.deleteInBatches(
      `DELETE FROM notifications WHERE id IN (
         SELECT id FROM notifications
          WHERE is_read = true AND created_at < $1
          ORDER BY created_at
          LIMIT $2
       )`,
      [this.cutoff(days)],
    );
  }

  /**
   * Location fixes past the retention window.
   *
   * The statement is deliberately the same shape as `LocationTrailService.purgeOlderThanRetention`
   * — `ORDER BY recorded_at` is not cosmetic. It is what makes the planner use
   * `idx_location_pings_recorded_at` (128 buffers) instead of a sequential scan that degrades as
   * the table is recycled (11,126 buffers measured after a single purge-and-refill cycle).
   */
  private async purgeLocationPings(): Promise<BatchOutcome> {
    const days = await this.locationPingRetentionDays();
    if (days <= 0) return NOTHING_TO_DO;
    return this.deleteInBatches(
      `DELETE FROM assayer_location_pings WHERE id IN (
         SELECT id FROM assayer_location_pings
          WHERE recorded_at < $1
          ORDER BY recorded_at
          LIMIT $2
       )`,
      [this.cutoff(days)],
    );
  }

  /**
   * How long to keep the movement trail — 550 days unless somebody has said otherwise.
   *
   * ## Why this used to have no default, and why it now does
   *
   * `locationTrail.retentionDays` ships with `default: null`, and the comment on it is right about
   * why: how long to hold continuous movement records of identifiable people is an employment and
   * data-protection decision, not a technical one, and a service should not make it quietly.
   *
   * But "no default" did not leave the decision open. It resolved it — to *keep everything
   * forever*, which is the most aggressive answer available and the one nobody chose. A year of
   * tracking at 2,000 audits/day is ~93 GB on a host with a 3 GB Postgres allocation; the outcome
   * of leaving it unset is not a deferred policy decision, it is an outage, followed by somebody
   * deleting data under pressure with no policy at all.
   *
   * ## Why 550 days
   *
   * The trail is **live evidence, not an archive**. `AssignmentService.getTravelVerification`
   * recomputes a travel assessment from the raw fixes every time it is opened — nothing is
   * precomputed and stored — so the window has to cover the whole period in which a travel claim
   * can still be questioned, not just the period in which it is filed.
   *
   * 550 days ≈ 18 months, which is the shortest window that covers the worst case in the Indian
   * financial year: an audit performed on 2 April falls in the first days of FY N, and the FY N
   * books are typically not closed and audited until well into the following calendar year. A
   * 12-month window would delete the evidence for early-in-year claims months before anyone could
   * be asked about them; 18 months clears the whole cycle with margin.
   *
   * It is not longer than that because each additional month is ~0.8 GB at 200 audits/day and
   * ~7.8 GB at 2,000, and because indefinitely retaining minute-by-minute location history of
   * identifiable workers is its own liability — the risk runs in both directions.
   *
   * ## How to override it
   *
   * Administration → Platform Settings → Data retention, or `LOCATION_TRAIL_RETENTION_DAYS`.
   * A saved or environment value always wins. **Setting it to 0 restores the previous behaviour
   * of never deleting anything**, deliberately — an organisation whose policy really is
   * "keep indefinitely" must be able to say so explicitly, which is different from never having
   * been asked.
   */
  async locationPingRetentionDays(): Promise<number> {
    // Through settings first, so the field on the settings screen is a control that actually
    // controls something; the environment variable is what it falls back to, and the constant is
    // what applies when nobody has expressed a view.
    const configured = await this.settings
      .get<number | null>('locationTrail.retentionDays')
      .catch(() => undefined);

    const fromSettings = asDays(configured);
    if (fromSettings !== null) return fromSettings;

    const fromEnv = asDays(process.env.LOCATION_TRAIL_RETENTION_DAYS);
    if (fromEnv !== null) return fromEnv;

    return RetentionService.DEFAULT_LOCATION_PING_DAYS;
  }

  // ---------------------------------------------------------------------------------------------
  // Mechanics
  // ---------------------------------------------------------------------------------------------

  /**
   * Run one DELETE repeatedly until it stops finding rows or hits the batch ceiling.
   *
   * The batch size is appended as the last parameter, so callers write `LIMIT $n` with their own
   * parameters before it and cannot accidentally issue an unbounded delete.
   *
   * Each iteration is a separate statement and therefore a separate implicit transaction. That is
   * the entire point: the alternative — one DELETE covering the whole backlog — takes a lock and
   * accumulates WAL for as long as it runs, and on the first run after this ships that backlog is
   * everything since the system was installed.
   */
  private async deleteInBatches(sql: string, params: unknown[]): Promise<BatchOutcome> {
    let removed = 0;
    for (let batch = 0; batch < RetentionService.MAX_BATCHES; batch++) {
      const result = await this.dataSource.query(sql, [...params, RetentionService.BATCH_SIZE]);
      const deleted = rowsAffected(result);
      removed += deleted;
      // A short batch means the table is drained; stop rather than issue a statement that will
      // find nothing, which on these tables still costs an index descent.
      //
      // Reaching the end of the loop without ever seeing a short batch means the opposite: the
      // ceiling stopped us, not the data. That distinction is the whole signal — see
      // `MetricsService.retentionSaturated` — so it is returned rather than thrown away.
      if (deleted < RetentionService.BATCH_SIZE) return { removed, saturated: false };
    }
    return { removed, saturated: true };
  }

  /** `now - days`, as a Date, because the driver binds Dates to timestamptz correctly. */
  private cutoff(days: number): Date {
    return new Date(Date.now() - days * 86_400_000);
  }

  /**
   * A retention window in days from the environment, falling back to the constant.
   *
   * Anything non-numeric or negative falls back rather than throwing: a typo in an environment
   * variable must not be able to switch retention off silently *or* stop the worker.
   */
  private days(envVar: string, fallback: number): number {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      this.logger.warn(`${envVar}="${raw}" is not a valid number of days; using ${fallback}.`);
      return fallback;
    }
    return n;
  }
}

/** What one pass removed, per table. Returned so the worker can log it and tests can assert it. */
export interface RetentionReport {
  outboxEvents: number;
  refreshTokens: number;
  notifications: number;
  locationPings: number;
  durationMs: number;
  /**
   * Tables whose purge stopped because it hit the batch ceiling rather than because it ran out of
   * rows. Empty is the healthy state. See `MetricsService.retentionSaturated`.
   */
  saturated: string[];
  failures: Array<{ phase: string; error: unknown }>;
}

/**
 * What one purge phase did, and — the part that matters — *why it stopped*.
 *
 * A bare row count cannot answer that. 50,000 removed is what you see both when the last batch
 * drained the table and when ten million rows are still queued behind the ceiling, and those two
 * call for opposite responses.
 */
interface BatchOutcome {
  removed: number;
  saturated: boolean;
}

/** A phase that was switched off by configuration: nothing removed, and nothing left behind. */
const NOTHING_TO_DO: BatchOutcome = { removed: 0, saturated: false };

/**
 * A configured number of days, or `null` for "nobody has said".
 *
 * The distinction has teeth here, and JavaScript actively works against it: `Number(null)` is 0,
 * `Number('')` is 0, and `Number([])` is 0 — so the obvious `Number(x)` check reads an *unset*
 * retention setting as an explicit "keep nothing", or (as this is used) as "keep forever". The
 * setting's stored default really is `null`, so this is the common path, not an edge case.
 *
 * Caught by `retention.service.spec.ts`, which is why it is a named function rather than an
 * expression inlined at each of the three call sites.
 */
function asDays(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * The row count from a raw DELETE.
 *
 * node-postgres reports it on the command result; TypeORM's `query()` surfaces that as the second
 * element of a tuple for statements that return no rows. Written defensively because getting this
 * wrong does not throw — it silently reports 0, the batch loop breaks on the first pass, and
 * retention appears to run successfully while deleting 5,000 rows an hour instead of 50,000.
 */
export function rowsAffected(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') return result[1];
  if (typeof result === 'number') return result;
  return 0;
}
