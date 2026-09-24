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
 * geo-precision worker joined on 2026-08-19; total 32 once that worker gained its address-enrichment
 * handler, and **33** since the roster import worker joined on 2026-09-02):
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
 * The connection pool is **20** (`DB_POOL_MAX`, `database.config.ts`). The total passed it in
 * August 2026 and has stayed past it; the roster slot added in September did not newly cross that
 * line, and it replaced work that used to occupy an API request handler for up to fifteen minutes,
 * which drew from the same pool with none of this visibility. And the shipped production
 * default is `PROCESS_ROLE=all` (`.env.production.example`), meaning the API and all twenty-nine
 * of those slots live in one process and draw from that one pool.
 *
 * On 2026-09-24 the branch, roster and customer-master import queues (one slot each) were folded
 * into the two shared `tracked-jobs` slots; `totalWorkerSlots()` is the live number, and it is still
 * above the pool, which is why the boot-time warning below still matters.
 *
 * ## What that does and does not mean
 *
 * It does **not** mean the pool is exhausted today, and this module is not a claim that it is.
 * Most of those slots are idle most of the time, several are cron-driven at staggered minutes, and
 * the notification-delivery slots spend most of their wall-clock in HTTP to the push provider or
 * handing a message to the outbound queues, whose own slots wait on SMTP and the SMS gateway,
 * rather than holding a connection. TypeORM acquires and releases per query; only work
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
 * Slots per worker, one key per `@Processor` class.
 *
 * That is also one key per queue: the three spreadsheet imports used to be three classes on the one
 * `import-jobs` queue, until 2026-09-17 showed that three handlers on a queue are three shared
 * loops, not three one-at-a-time lanes; they now share the `tracked-jobs` queue, where "one at a
 * time" is a rule on the row, not a slot count. The key is the class because the class is what the
 * fitness test can count from the source.
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
   *
   * `deliver-sms` (two slots, joined 2026-09-17) only decides and hands a text to the `outbound-sms`
   * queue — a few short reads and two updates, no gateway call — and only for events an
   * administrator has switched SMS on for, so it is idle on a default deployment.
   */
  notifications: { deliver: 5, deliverEmail: 3, deliverSms: 2, sweep: 1, failAbandoned: 1 },

  /**
   * The emails an action asks for — invites, setup links, approval letters, bulk credentials —
   * sent from `outbound_emails` rather than inside the request (see `OutboundEmailWorker`). Its own
   * QUEUE, not just its own class: Bull's loops are per queue and take jobs of any name, so on the
   * notification queue a 540-person credential run would have held the loops that push offers and
   * alert emails need. Three sending slots matches the mail pool's three connections
   * (`MAIL_CONNECTION_OPTIONS.maxConnections`); a fourth would only wait for a connection. Each
   * holds a database connection for two short updates, not across the SMTP conversation.
   *
   * NOTE for every multi-handler row in this table: a queue's slots are the SUM of its handlers'
   * concurrency, shared by all of its job names — not a per-name reservation.
   */
  outboundEmail: { send: 3, sweep: 1 },
  /**
   * Texts (`OutboundSmsWorker`, queue `outbound-sms`): the same ledger and delivery routine as email on
   * a queue of its own, so a slow SMS gateway holds only texts. Two slots — a gateway answers in well
   * under a second and texts are not bursty; the one sweep on the email queue covers both channels.
   */
  outboundSms: { send: 2 },

  /**
   * Roster bulk actions — "issue app access" and "notify" over a selection (see
   * `workforce-bulk-jobs.contract.ts`). ONE slot for the whole queue, through a single `'*'`
   * handler: two named handlers would have been two shared loops, letting two credential runs over
   * the same people rotate passwords concurrently. Idle except when HR presses the button.
   */
  workforceBulk: { run: 1 },

  /**
   * Report exports: ONE `'*'` loop for every export kind. It used to be five named handlers, with a
   * comment claiming "one per report kind, so a slow roster export cannot block a billing export" —
   * false: Bull's loops are per queue and take any job name, so five handlers were five shared
   * loops and up to five synchronous `xlsx.write` builds at once, each one freezing the process.
   * One slot is the correct number for a CPU-blocking build (see `ReportJobsWorker`).
   */
  reports: { run: 1 },

  /** OCR. Bounded by CPU on the host rather than by the pool. */
  ocr: { extract: 3 },

  /**
   * Planning reads. Each walks a project's worth of branches. Three handlers are three loops SHARED
   * by all three job names — up to three reads at once of any mix, not one of each kind.
   */
  planning: { coveragePlan: 1, projectCandidates: 1, dayPlans: 1 },

  /**
   * Planning writes — deploy an approved plan, generate a version, bulk offer, bulk unable-to-cover
   * (see `planning-write-jobs.contract.ts`). Their own queue with ONE `'*'` loop: a named handler on
   * the read queue would have been a fourth shared loop, letting two deploys of one plan run side by
   * side. Idle except when the desk presses one of those buttons, and the work it replaced ran inside
   * API requests on the same pool.
   */
  planningWrites: { run: 1 },

  /**
   * Scheduled scans. Two named handlers are two SHARED loops, so two scans could run at once (a
   * retry's backoff landing on the next tick); the scan takes a Postgres advisory lock and a tick
   * that finds one running skips (`SlaScannerWorker.runScan`).
   */
  slaScanner: { scan: 1, digest: 1 },

  /**
   * Single-slot workers, each for its own reason documented at its `@Process` — except `billing`,
   * which is TWO shared loops (reconcile + booking are two named handlers on one queue), not one of
   * each. Two reconciles cannot overlap anyway: reconcile runs through `BackgroundJobTracker`, whose
   * per-queue advisory lock serialises tracked runs cluster-wide.
   */
  retention: { purge: 1 },
  outbox: { drain: 1 },
  billing: { reconcile: 1, bookAssignment: 1 },
  /**
   * Billing bulk writes — approve or pay a selection of payouts, and the invite-all assayer invoice
   * round (see `billing-bulk-jobs.contract.ts`). Their own queue with ONE `'*'` loop: a handler on
   * `billing-jobs` would have shared the reconcile/booking loops, letting two payout runs go at once
   * and parking a 1,200-assayer round in the slot completion booking needs. Idle except when finance
   * presses one of those buttons, and it replaced work that ran inside API requests on the same pool.
   */
  billingBulk: { run: 1 },
  documents: { autoDispatch: 1 },
  /*
   * `rosterImports` and `customerMasterImports` (and, before them, `imports` for branches) had
   * queues of their own here until 2026-09-24, when all three uploads moved onto the tracked
   * background-job foundation (`trackedJobs` below). Their one-at-a-time rule is now the kind's
   * `exclusive: 'kind'`, enforced by a unique index over RUNNING rows across every replica, and
   * customer master's "a stalled run is failed, never re-run" is its `idempotent: false`.
   */
  /**
   * Audit chain sealing, ticked by cron every minute (see `AuditModule`). One slot: `sealOnce`
   * is already a single-writer pass, serialised cluster-wide by a Redis lock plus a Postgres
   * advisory lock held for the transaction's duration (see `AuditSealService`) — a second
   * concurrent tick on the same replica could only block on that lock and gain nothing. The slot
   * exists solely to stop the every-minute cron from overlapping itself if a pass ever runs long.
   */
  auditSeal: { seal: 1 },
  /**
   * Tracked background jobs (`BackgroundJobsWorker`, queue `tracked-jobs`) — the uploads and other
   * work whose progress lives on a `background_jobs` row the Jobs tray reads back after a refresh.
   * ONE `'*'` loop at concurrency 2: every kind shares it, so one long import (a 5,000-branch file
   * geocoding at one lookup a second) does not hold every other upload behind it. A kind that must
   * run one at a time says so on its definition (`exclusive`), enforced by a unique index over
   * RUNNING rows — which holds across replicas, where a slot count holds only inside one process.
   * Joined 2026-09-24; idle except while somebody's upload is being processed.
   */
  trackedJobs: { run: 2 },
  /**
   * Coordinate precision. Three named handlers — an import's targeted backfill, the nightly
   * coordinate sweep, and the address-enrichment sweep (district/pincode/city + zone/territory/
   * tier) — one slot each. The slot count is a rate-limit decision, not a pool one: the backfill
   * handlers walk the free public OSM providers (~1 request/second), and `politely()` serialises
   * within a process, so one job at a time per handler keeps every geocode inside those limits.
   * Enrichment reads the self-hosted geocoder (no such limit) but still takes one slot so its
   * reverse calls stay serialised. These slots are idle almost all the time and spend their active
   * time waiting on HTTP, not holding a connection.
   */
  geoPrecision: { backfillIds: 1, sweep: 1, enrichAddresses: 1 },
} as const;

/**
 * The pool size to compare against when `DB_POOL_MAX` is unset.
 *
 * Mirrors the fallback in `database.config.ts` (`configService.get('DB_POOL_MAX', 20)`), which is
 * the authority. Importing the config here would drag the whole Nest config module into a boot
 * path that runs before it, so this is a deliberate duplicate — and `worker-concurrency.spec.ts`
 * reads that file and fails if the two ever disagree.
 */
/**
 * Which Bull queue each `WORKER_CONCURRENCY` key actually processes.
 *
 * The table above is keyed per `@Processor` class, because that is what the fitness test can
 * count from the source. Pausing, dead-letter monitoring and the Bull Board dashboard all care
 * about the *queue*, not the class, so this is the one place that maps class-key to queue name.
 * The mapping is 1:1. Two class-keys on one queue name is possible but is not a way to give each
 * class its own slots — they would share every loop — which is why the three import kinds, which
 * once did exactly that, now each have a queue of their own.
 *
 * This mapping, plus `WORKER_CONCURRENCY`'s own keys, is the single source every consumer
 * (`pauseLocalQueues` in main.ts, the job-failure monitor, Bull Board) derives its queue list
 * from — see `ALL_QUEUE_NAMES` below. A queue registered with Bull but missing here is caught by
 * `queue-registry.spec.ts`, which scans every `BullModule.registerQueue` call site.
 */
const QUEUE_NAME_BY_WORKER_KEY: Record<keyof typeof WORKER_CONCURRENCY, string> = {
  notifications: 'notification-delivery',
  outboundEmail: 'outbound-email',
  outboundSms: 'outbound-sms',
  workforceBulk: 'workforce-bulk-jobs',
  reports: 'report-jobs',
  ocr: 'ocr',
  planning: 'planning-jobs',
  planningWrites: 'planning-write-jobs',
  slaScanner: 'sla-scanner',
  retention: 'retention',
  outbox: 'outbox',
  billing: 'billing-jobs',
  billingBulk: 'billing-bulk-jobs',
  documents: 'document-dispatch',
  auditSeal: 'audit-seal',
  trackedJobs: 'tracked-jobs',
  geoPrecision: 'geo-precision',
};

/**
 * Every Bull queue in the system, derived from `WORKER_CONCURRENCY` (via
 * `QUEUE_NAME_BY_WORKER_KEY`) rather than hand-maintained. This is what `pauseLocalQueues`
 * (main.ts), the job-failure monitor and Bull Board all consume, so a queue that exists in Bull
 * but was never added to `WORKER_CONCURRENCY` shows up nowhere in this list — which is exactly
 * the drift `queue-registry.spec.ts` fails the build on.
 */
export const ALL_QUEUE_NAMES: readonly string[] = Array.from(
  new Set(Object.values(QUEUE_NAME_BY_WORKER_KEY)),
);

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
      `max_connections), split the roles (run PROCESS_ROLE=api replicas for HTTP and ` +
      `PROCESS_ROLE=worker replicas for jobs — see DEPLOYMENT.md), or, for a single-process ` +
      `("all") deployment that must stay on one process, lower the per-queue numbers in the ` +
      `WORKER_CONCURRENCY table above (worker-concurrency.ts) until their sum is at least 5 ` +
      `below DB_POOL_MAX — that table, not an env var, is the knob; see .env.production.example's ` +
      `"AWS saving profile" note.`,
  );
}
