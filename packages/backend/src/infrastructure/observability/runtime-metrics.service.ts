import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { Gauge } from 'prom-client';
import { MetricsService } from './metrics.service';
import { REDIS_CLIENT } from '../redis/redis-client.module';

/**
 * The gauges that make the failures this system actually has visible.
 *
 * An audit of 2026-08-16 listed what could not be diagnosed from `/metrics`: the database pool
 * (exhaustion showed only as latency), queue depth and the age of the oldest waiting job (a
 * stalled worker was invisible until someone noticed work not happening), and live socket
 * count. Every one of those was a real incident shape in this system — the pool was
 * self-deadlocking on audit writes, a mis-registered processor dead-lettered every job, and the
 * socket layer silently fell back to single-node when Redis was away.
 *
 * All of them are sampled at scrape time rather than pushed, so they cost nothing between
 * scrapes and cannot themselves become a source of load. Each sampler is individually guarded:
 * a gauge that cannot be read must leave the others readable, because the moment these matter
 * most is exactly when one of the dependencies behind them is failing.
 */
@Injectable()
export class RuntimeMetricsService {
  private readonly logger = new Logger(RuntimeMetricsService.name);

  /** Queues to sample. Kept in step with ALL_QUEUE_NAMES in main.ts. */
  private static readonly QUEUE_NAMES = [
    'background-jobs',
    'ocr',
    'sla-scanner',
    'document-dispatch',
    'notification-delivery',
    'outbox',
  ];

  /**
   * How many statements get their own time series.
   *
   * This is the cardinality budget, and it is the whole reason this is not simply "export
   * pg_stat_statements". That view holds up to `pg_stat_statements.max` rows — 5,000 as
   * configured — and one label set per row across three metrics would be 15,000 series from a
   * single API replica, multiplied by replica count, for a question ("what is slowest?") that is
   * answered by the first page. 20 is deliberately small: cumulative `total_exec_time` moves
   * slowly, so the membership of the top 20 is stable for hours at a time and Prometheus is not
   * asked to store a new series every scrape.
   */
  private static readonly TOP_STATEMENTS = 20;

  /**
   * Dedupe window for the statement query. `registry.metrics()` collects every metric
   * concurrently, so the three statement gauges below would otherwise issue three identical
   * queries per scrape; they all await the same in-flight promise instead. Short enough that
   * consecutive scrapes never share a sample, long enough that one scrape costs one query.
   */
  private static readonly STATEMENT_SAMPLE_TTL_MS = 2_000;

  /**
   * How long to stay quiet after finding the extension missing.
   *
   * `pg_stat_statements` cannot appear without a postmaster restart, so re-probing on every
   * scrape would be a guaranteed-failing query every 15 seconds forever. It is not permanent
   * either: the intended sequence on an existing deployment is "recreate Postgres with the
   * preload, migration installs the extension" — and the API is not necessarily restarted in
   * between. A ten-minute re-probe makes that self-heal without a redeploy, at a cost of one
   * failed query per ten minutes in the genuinely-unsupported case.
   */
  private static readonly STATEMENT_RETRY_MS = 10 * 60 * 1_000;

  private statementSample: Promise<StatementSample | null> | null = null;
  private statementSampleExpiresAt = 0;
  /** Epoch ms before which not to bother asking. 0 = ask now. */
  private statementProbeAfter = 0;
  /** So an unsupported deployment logs one line, not one line per scrape. */
  private statementWarningLogged = false;

  constructor(
    private readonly metrics: MetricsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    this.registerPoolGauges();
    this.registerQueueGauges();
    this.registerStatementGauges();
  }

  /**
   * Database pool occupancy.
   *
   * `waiting` is the one that matters: a non-zero value means requests are queuing for a
   * connection, which is what pool exhaustion looks like from the inside. It is how the
   * audit-write-on-a-second-connection deadlock would have been spotted — twenty concurrent
   * assignment transitions each holding one connection and asking for another — instead of
   * being read as "the API is slow".
   */
  private registerPoolGauges(): void {
    const pool = () => (this.dataSource.driver as unknown as { master?: PoolLike })?.master;

    new Gauge({
      name: 'db_pool_connections',
      help: 'Database pool connections by state (total = open sockets, idle = free, waiting = requests queued for one)',
      labelNames: ['state'],
      registers: [this.metrics.registry],
      collect() {
        const p = pool();
        if (!p) return;
        // node-postgres exposes these as counters on the pool; guarded because a driver that
        // does not (or a pool not yet created) must not break the whole scrape.
        if (typeof p.totalCount === 'number') this.set({ state: 'total' }, p.totalCount);
        if (typeof p.idleCount === 'number') this.set({ state: 'idle' }, p.idleCount);
        if (typeof p.waitingCount === 'number') this.set({ state: 'waiting' }, p.waitingCount);
      },
    });
  }

  /**
   * Queue depth and the age of the oldest waiting job.
   *
   * Depth alone does not distinguish "busy" from "stopped": a queue with 500 waiting jobs is
   * healthy if they are seconds old and an outage if the oldest has been there an hour. The age
   * gauge is the one to alert on.
   */
  private registerQueueGauges(): void {
    const redis = this.redis;
    const names = RuntimeMetricsService.QUEUE_NAMES;

    new Gauge({
      name: 'queue_jobs',
      help: 'Bull jobs per queue by state',
      labelNames: ['queue', 'state'],
      registers: [this.metrics.registry],
      async collect() {
        if (!redis) return;
        for (const name of names) {
          try {
            // Read Redis directly rather than injecting six Queue instances: this service is
            // global and must not force every queue to be registered wherever it is imported.
            const [waiting, active, delayed, failed] = await Promise.all([
              redis.llen(`bull:${name}:wait`),
              redis.llen(`bull:${name}:active`),
              redis.zcard(`bull:${name}:delayed`),
              redis.zcard(`bull:${name}:failed`),
            ]);
            this.set({ queue: name, state: 'waiting' }, waiting ?? 0);
            this.set({ queue: name, state: 'active' }, active ?? 0);
            this.set({ queue: name, state: 'delayed' }, delayed ?? 0);
            this.set({ queue: name, state: 'failed' }, failed ?? 0);
          } catch {
            // Redis unreachable, or this queue has never existed. Either way the other queues
            // and every other metric must still be scrapeable.
          }
        }
      },
    });

    new Gauge({
      name: 'queue_oldest_waiting_seconds',
      help: 'Age of the oldest waiting job per queue, in seconds (0 when the queue is empty)',
      labelNames: ['queue'],
      registers: [this.metrics.registry],
      async collect() {
        if (!redis) return;
        for (const name of names) {
          try {
            // The wait list is FIFO, so the last element is the oldest job id; its hash carries
            // the enqueue timestamp.
            const ids = await redis.lrange(`bull:${name}:wait`, -1, -1);
            if (!ids?.length) {
              this.set({ queue: name }, 0);
              continue;
            }
            const timestamp = await redis.hget(`bull:${name}:${ids[0]}`, 'timestamp');
            const enqueuedAt = Number(timestamp);
            this.set(
              { queue: name },
              Number.isFinite(enqueuedAt) ? Math.max(0, (Date.now() - enqueuedAt) / 1000) : 0,
            );
          } catch {
            /* see above */
          }
        }
      },
    });
  }

  /**
   * The top statements by cumulative execution time, from `pg_stat_statements`.
   *
   * This is the half of Phase 4 that makes a regression *attributable*. Everything else on this
   * dashboard says the database got slower; none of it says which query. Until now answering that
   * meant taking a copy of production, guessing at the workload and re-running it by hand — which
   * is how every measurement in the audit was obtained, and why so few of them exist.
   *
   * WHAT IS EXPOSED, AND WHY IT IS SAFE TO EXPOSE
   * ---------------------------------------------
   * `queryid` is Postgres' own stable fingerprint of a normalised statement — it survives
   * restarts and matches across replicas, so an alert can name a query and a human can recover
   * the full text with `SELECT query FROM pg_stat_statements WHERE queryid = ...`. On its own it
   * is unreadable, so a truncated `statement` label rides alongside it, and the query below is
   * restricted to DML for a reason that is about disclosure rather than tidiness: Postgres
   * normalises constants in DML to `$1`, so that text can contain no literal values, but with
   * `pg_stat_statements.track_utility` on (the default) the view ALSO records utility commands
   * verbatim — and `ALTER ROLE … PASSWORD '…'` is a utility command that this repo's password
   * rotation script really does run inside the container. Copying that into a Prometheus label,
   * where it would be retained for weeks under access controls looser than the database's, is
   * exactly the sort of quiet leak that is impossible to walk back. So the filter is a
   * safety boundary, not a filter for noise, and it must not be relaxed to `query NOT ILIKE
   * '%password%'` or similar — an allowlist of statement shapes is the only version of this
   * that fails closed.
   *
   * The three values are the ones that separate the two kinds of problem: `exec_seconds_total`
   * finds the query that costs the most in aggregate (usually a cheap query run a million times),
   * `mean_exec_seconds` finds the query that is slow per call, and `calls_total` tells you which
   * of those two you are looking at. All three are cumulative since the last `pg_stat_statements_reset()`
   * or postmaster start, so the useful PromQL is `rate()`/`increase()` over them, not the raw value.
   *
   * `reset()` before each fill is load-bearing. prom-client remembers every label set it has ever
   * been given, so without it a query that drops out of the top 20 would keep reporting its last
   * value forever — a permanently frozen series that reads as a query still running.
   */
  private registerStatementGauges(): void {
    // prom-client calls collect() with `this` bound to the gauge itself (hence `this.set(...)`
    // further down), so the service has to be captured here to stay reachable inside the callback.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const registers = [this.metrics.registry];
    const labelNames = ['queryid', 'statement'];

    // Availability is its own metric, deliberately. The degradation this guards against is
    // silent by construction: with no extension, "the top queries" is an empty set, which on a
    // dashboard is indistinguishable from a database with nothing slow on it. Alert on this being
    // 0 — it means the panel next to it is lying by omission, not that the system is fast.
    new Gauge({
      name: 'db_query_stats_available',
      help: 'Whether pg_stat_statements could be read (1 = collecting, 0 = extension absent or not preloaded, so every statement metric below is empty rather than zero)',
      registers,
      async collect() {
        this.set((await self.sampleStatements()) ? 1 : 0);
      },
    });

    // Occupancy against pg_stat_statements.max. At the ceiling the extension evicts its
    // least-executed entries, so the history quietly becomes lossy — and a query that ran twice
    // and took a minute each time is exactly the kind of entry eviction removes first. Alert if
    // this approaches the configured max (5,000) rather than discovering it during an incident.
    new Gauge({
      name: 'db_query_stats_tracked',
      help: 'Statements currently retained by pg_stat_statements; nearing pg_stat_statements.max means entries are being evicted and the history is lossy',
      registers,
      async collect() {
        const sample = await self.sampleStatements();
        if (sample) this.set(sample.tracked);
      },
    });

    new Gauge({
      name: 'db_query_exec_seconds_total',
      help: 'Cumulative execution time per statement since the last statistics reset, for the top statements by that measure',
      labelNames,
      registers,
      async collect() {
        const sample = await self.sampleStatements();
        if (!sample) return;
        this.reset();
        for (const row of sample.rows) {
          this.set({ queryid: row.queryid, statement: row.statement }, row.totalExecSeconds);
        }
      },
    });

    new Gauge({
      name: 'db_query_calls_total',
      help: 'Cumulative execution count per statement since the last statistics reset, for the top statements by total execution time',
      labelNames,
      registers,
      async collect() {
        const sample = await self.sampleStatements();
        if (!sample) return;
        this.reset();
        for (const row of sample.rows) {
          this.set({ queryid: row.queryid, statement: row.statement }, row.calls);
        }
      },
    });

    new Gauge({
      name: 'db_query_mean_exec_seconds',
      help: 'Mean execution time per call for the top statements by total execution time — the per-call view, as opposed to the aggregate one',
      labelNames,
      registers,
      async collect() {
        const sample = await self.sampleStatements();
        if (!sample) return;
        this.reset();
        for (const row of sample.rows) {
          this.set({ queryid: row.queryid, statement: row.statement }, row.meanExecSeconds);
        }
      },
    });
  }

  /**
   * One statement sample per scrape, shared by the gauges above, `null` when unavailable.
   *
   * Never rejects. A metrics endpoint that throws takes every other metric with it, and the
   * moment this fails is precisely the moment the pool and queue gauges beside it are worth
   * reading — the same rule `CacheService` applies to Redis: a diagnostic must never become a
   * failure mode of its own.
   */
  private async sampleStatements(): Promise<StatementSample | null> {
    const now = Date.now();
    if (!this.statementSample || now >= this.statementSampleExpiresAt) {
      this.statementSampleExpiresAt = now + RuntimeMetricsService.STATEMENT_SAMPLE_TTL_MS;
      this.statementSample = this.queryStatements().catch(() => null);
    }
    return this.statementSample;
  }

  private async queryStatements(): Promise<StatementSample | null> {
    if (Date.now() < this.statementProbeAfter) return null;

    try {
      // `dbid` filter: pg_stat_statements is cluster-wide, and this cluster also holds
      // fapoms_scale2 (200k assignments) whose load tests would otherwise dominate the ranking
      // for the application database. Scoped to the database this connection is actually on.
      //
      // `queryid IS NOT NULL` covers `compute_query_id = off`, where the view still returns rows
      // but every fingerprint is null — one unusable label set rather than twenty useful ones.
      // Loading the library flips the default `auto` to on, so this should never trigger.
      //
      // The `statement` label is a human hint; `queryid` is the identity. Two transformations
      // earn their place, and both were chosen after looking at what this database actually
      // produces rather than at what SQL looks like in a textbook:
      //
      //   1. Whitespace is collapsed, because TypeORM emits multi-line SQL and 120 characters of
      //      a query that begins with three newlines identifies nothing.
      //   2. The projection of a SELECT is replaced with an ellipsis. This is the one that makes
      //      the label useful at all here: TypeORM aliases every column as
      //      `"UserEntity"."created_by" AS "UserEntity_created_by"`, so the first 120 characters
      //      of *every* query against a given entity are byte-identical. Before this, three
      //      different top-ranked queries all rendered as
      //      `SELECT "UserEntity"."id" AS "UserEntity_id", "UserEntity"."created_by" AS "UserE`.
      //      Collapsing to `SELECT … FROM "users" … WHERE …` puts the table and the predicate —
      //      the parts that differ — inside the budget. Non-greedy, so a subquery in the select
      //      list stops the match at its own FROM; the label is degraded in that case, never
      //      wrong, and queryid still resolves it exactly.
      const rows: RawStatementRow[] = await this.dataSource.query(
        `
        SELECT s.queryid::text                                      AS queryid,
               left(regexp_replace(
                 regexp_replace(s.query, '\\s+', ' ', 'g'),
                 '^SELECT .+? FROM ', 'SELECT … FROM ', 'i'), 120)  AS statement,
               s.calls::float8                                      AS calls,
               s.total_exec_time                                    AS total_exec_ms,
               s.mean_exec_time                                     AS mean_exec_ms,
               (SELECT count(*) FROM pg_stat_statements)::float8    AS tracked
        FROM pg_stat_statements s
        WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND s.queryid IS NOT NULL
          AND s.query ~* '^\\s*(select|insert|update|delete|with)\\s'
          AND s.query NOT ILIKE '%pg_stat_statements%'
        ORDER BY s.total_exec_time DESC
        LIMIT $1
        `,
        [RuntimeMetricsService.TOP_STATEMENTS],
      );

      // Reaching here at all is the availability signal — an empty result means a database with
      // no DML history yet (a freshly restarted postmaster), not a missing extension.
      this.statementProbeAfter = 0;
      this.statementWarningLogged = false;

      return {
        tracked: rows.length ? toFinite(rows[0].tracked) : 0,
        rows: rows.map((r) => ({
          queryid: r.queryid,
          statement: r.statement,
          calls: toFinite(r.calls),
          // Postgres reports these in milliseconds; Prometheus convention is base units.
          totalExecSeconds: toFinite(r.total_exec_ms) / 1000,
          meanExecSeconds: toFinite(r.mean_exec_ms) / 1000,
        })),
      };
    } catch (err) {
      // 55000 object_not_in_prerequisite_state — "must be loaded via shared_preload_libraries":
      // the extension exists (the migration created it) but the postmaster was not restarted.
      // 42P01 undefined_table — no extension in this database at all.
      // Both mean "not today, and not until something outside this process changes", so back off
      // rather than issuing a query that is certain to fail on every scrape. Anything else is
      // treated the same way on purpose: a transient error here must not be louder than the
      // metrics it is reporting on, and the availability gauge already says the panel is empty.
      if (!this.statementWarningLogged) {
        this.statementWarningLogged = true;
        this.logger.warn(
          `pg_stat_statements unavailable, slow-query attribution is off: ${(err as Error).message}. `
          + 'Recreate the Postgres container so shared_preload_libraries takes effect (it is PGC_POSTMASTER; a reload will not do it).',
        );
      }
      this.statementProbeAfter = Date.now() + RuntimeMetricsService.STATEMENT_RETRY_MS;
      return null;
    }
  }
}

/** The subset of node-postgres' Pool this samples, without depending on its types. */
interface PoolLike {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

/**
 * As Postgres returns it. `calls` and the count are cast to float8 in SQL rather than converted
 * here because node-postgres hands back bigint as a *string* to avoid losing precision above
 * 2^53 — and `Number(undefined)` is NaN, which prom-client accepts and then exports as `NaN`,
 * poisoning the series rather than omitting it. Casting in SQL keeps that failure impossible.
 */
interface RawStatementRow {
  queryid: string;
  statement: string;
  calls: number;
  total_exec_ms: number;
  mean_exec_ms: number;
  tracked: number;
}

interface StatementSample {
  tracked: number;
  rows: Array<{
    queryid: string;
    statement: string;
    calls: number;
    totalExecSeconds: number;
    meanExecSeconds: number;
  }>;
}

/** Belt and braces against a NaN reaching the registry — see RawStatementRow. */
function toFinite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
