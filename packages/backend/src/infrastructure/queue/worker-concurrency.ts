/**
 * FAPOMS — how many jobs may run at once, in one place, because the sum is what matters.
 *
 * ## The problem this exists to make visible
 *
 * Phase 3 of the August 2026 performance work moved six workloads off the request path and onto
 * Bull queues — coverage planning, day planning, project candidates, Excel imports, report exports
 * and billing sync — joining the queues that were already there. Every one of them chose its own
 * concurrency, sensibly, as a local decision: "this scan is heavy, so one at a time".
 *
 * Nobody added them up. Counted 2026-08-17, across eleven `@Processor` classes (twelve since the
 * geo-precision worker joined on 2026-08-19, taking the total to 31):
 *
 *   | queue / worker                        | slots |
 *   |---------------------------------------|-------|
 *   | notifications (deliver 5, email 3, +3)|    11 |
 *   | reports (4 named handlers)            |     4 |
 *   | OCR                                   |     3 |
 *   | planning (coverage, candidates, days) |     3 |
 *   | SLA scanner (scan, digest)            |     2 |
 *   | retention, outbox, billing sync,      |       |
 *   | document dispatch, branch import,     |       |
 *   | generic `@Process('*')`               |     6 |
 *   | **total**                             |**29** |
 *
 * The connection pool is **20** (`DB_POOL_MAX`, `database.config.ts`). And the shipped production
 * default is `PROCESS_ROLE=all` (`.env.production.example`), meaning the API and all twenty-nine
 * of those slots live in one process and draw from that one pool.
 *
 * ## What that does and does not mean
 *
 * It does **not** mean the pool is exhausted today, and this module is not a claim that it is.
 * Most of those slots are idle most of the time, several are cron-driven at staggered minutes, and
 * the eight notification-delivery slots spend most of their wall-clock in HTTP to push and SMTP
 * providers rather than holding a connection. TypeORM acquires and releases per query; only work
 * inside an explicit transaction pins a connection for its duration.
 *
 * It does mean the system has **no mechanism that prevents** worker demand from exceeding the
 * pool, and that the number crossed the pool size without anyone deciding it should. When it does
 * bite, it bites as `connectionTimeoutMillis` (10 s) on a *request handler* — a user-facing
 * timeout caused by background work, which is the hardest kind of incident to attribute, because
 * nothing in the request's own path is slow.
 *
 * So: the numbers live here, the total is derivable, and `assertConcurrencyWithinPool` says so out
 * loud at boot. The alternative — leaving eleven literals in eleven files and re-deriving the sum
 * by hand the next time somebody adds a queue — is how it got to 29 in the first place.
 *
 * ## Why this warns rather than refuses to boot
 *
 * Oversubscription is a tuning mistake, not a corruption risk: the failure mode is slow, and it is
 * recoverable by changing one environment variable. Refusing to start would convert a tuning
 * mistake into an outage, and would do it at the worst possible moment — during a deploy, when
 * somebody has just raised a concurrency to clear a backlog. The same reasoning the rest of this
 * codebase applies to Redis and to metrics: infrastructure concerns degrade, they do not gate.
 */

import { Logger } from '@nestjs/common';

/**
 * Slots per worker, keyed by the queue each belongs to.
 *
 * **This is a mirror, not the definition.** The running values are the `@Process` decorators in
 * the worker classes, where each sits next to the comment explaining why it is what it is;
 * moving them here would separate every number from its reasoning to satisfy a bookkeeping need.
 *
 * A mirror that can drift is worse than no mirror, so it cannot drift: `worker-concurrency.spec.ts`
 * parses every `@Processor` file in the tree and fails if the decorators and this table disagree,
 * or if a worker exists that this table has never heard of. Adding a queue without updating this
 * breaks the build, which is the only way a total stays true.
 */
export const WORKER_CONCURRENCY = {
  /**
   * Notification delivery. The largest single consumer, and deliberately so: `deliver` and
   * `deliver-email` are dominated by waiting on push and SMTP providers, not by database work, so
   * serialising them would make a broadcast crawl for no gain in database pressure.
   */
  notifications: { deliver: 5, deliverEmail: 3, sweep: 1, failAbandoned: 1, markExhausted: 1 },

  /** Report exports. One per report kind, so a slow roster export cannot block a billing export. */
  reports: { assignments: 1, billing: 1, commandCenter: 1, assayerRoster: 1 },

  /** OCR. Bounded by CPU on the host rather than by the pool. */
  ocr: { extract: 3 },

  /** Planning. Each of these walks a project's worth of branches; one at a time each. */
  planning: { coveragePlan: 1, projectCandidates: 1, dayPlans: 1 },

  /** Scheduled scans. */
  slaScanner: { scan: 1, digest: 1 },

  /** Single-slot workers, each for its own reason documented at its `@Process`. */
  retention: { purge: 1 },
  outbox: { drain: 1 },
  billing: { syncAssignments: 1 },
  documents: { autoDispatch: 1 },
  imports: { branchImport: 1 },
  generic: { catchAll: 1 },
  /**
   * Coordinate precision. Two named handlers (an import's targeted backfill, the nightly sweep),
   * one slot each — and the slot count is a rate-limit decision, not a pool one: the free OSM
   * providers allow ~1 request/second per client, and `politely()` serialises within a process,
   * so one job at a time per handler keeps every geocode inside the providers' published limits.
   * These slots are idle almost all the time and spend their active time waiting on HTTP, not
   * holding a connection.
   */
  geoPrecision: { backfillIds: 1, sweep: 1 },
} as const;

/**
 * The pool size to compare against when `DB_POOL_MAX` is unset.
 *
 * Mirrors the fallback in `database.config.ts` (`configService.get('DB_POOL_MAX', 20)`), which is
 * the authority. Importing the config here would drag the whole Nest config module into a boot
 * path that runs before it, so this is a deliberate duplicate — and `worker-concurrency.spec.ts`
 * reads that file and fails if the two ever disagree.
 */
export const DEFAULT_DB_POOL_MAX = 20;

/** Every slot in `WORKER_CONCURRENCY`, summed. */
export function totalWorkerSlots(): number {
  return Object.values(WORKER_CONCURRENCY)
    .flatMap((queue) => Object.values(queue as Record<string, number>))
    .reduce((sum, n) => sum + n, 0);
}

/**
 * Say out loud, once at boot, when the workers can collectively ask for more connections than the
 * pool has.
 *
 * `processRole` matters: with `PROCESS_ROLE=api` this replica runs no jobs, so its pool is for
 * request handlers alone and the comparison is meaningless. The warning is for the two roles that
 * actually process jobs — `worker` and the default `all`.
 */
export function assertConcurrencyWithinPool(
  poolMax: number,
  processRole: string,
  logger: Logger = new Logger('WorkerConcurrency'),
): void {
  if (processRole === 'api') return;

  const slots = totalWorkerSlots();
  if (slots <= poolMax) return;

  const sharesWithHttp = processRole !== 'worker';
  logger.warn(
    `Worker concurrency (${slots} slots) exceeds the database pool (DB_POOL_MAX=${poolMax})` +
      (sharesWithHttp
        ? ', and PROCESS_ROLE is not "api", so request handlers draw from the same pool. ' +
          'A burst of background work can therefore time out user requests after ' +
          'DB_CONN_TIMEOUT_MS with nothing slow in the request path itself. '
        : '. ') +
      `Either raise DB_POOL_MAX above ${slots} (and keep replicas x pool under Postgres ` +
      `max_connections), or split the roles: run PROCESS_ROLE=api replicas for HTTP and ` +
      `PROCESS_ROLE=worker replicas for jobs. See docs/deployment-guide.md.`,
  );
}
