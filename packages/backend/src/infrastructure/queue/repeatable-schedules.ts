import { Logger } from '@nestjs/common';
import type { JobOptions, Queue } from 'bull';
import { FAILED_JOB_RETENTION } from './queued-job';

/**
 * One wanted schedule on a queue: a named job that fires on `cron` (optionally in `tz`).
 */
export interface WantedSchedule {
  name: string;
  cron: string;
  tz?: string;
  /**
   * Extra Bull job options (attempts, backoff…). `repeat` is set below and cannot be overridden;
   * `removeOnComplete`/`removeOnFail` are defaulted below and a schedule may override either.
   */
  jobOptions?: Omit<JobOptions, 'repeat'>;
  /**
   * The payload each firing carries. Defaults to `{}`, which is what every caller got before
   * this existed — and what made the geo sweep run branches twice and assayers never: two
   * schedules were registered under one job name with no data, so the worker's
   * `job.data?.target ?? 'branch'` answered the same way for both.
   */
  data?: Record<string, unknown>;
  /**
   * Distinguishes two schedules of the same job name. Bull keys a repeatable by name, cron and
   * jobId together, so without this the second registration of a name replaces the first
   * instead of joining it.
   */
  jobId?: string;
}

/**
 * Converge a queue on exactly the given repeatable schedules — without being able to stop the
 * application from starting.
 *
 * ## Why one helper
 *
 * Four modules (outbox relay, SLA scanner, notification sweeper, document dispatch) each carried
 * the same twenty lines: "Bull keys repeatable jobs by cron string, so a changed cron adds a
 * second schedule instead of replacing the first — remove stale ones, then add the wanted one."
 * That is a rule about Bull, not about any of those modules, and it had to be right in four places.
 *
 * ## Why it never throws
 *
 * Every one of those modules did this work in `onModuleInit` and awaited it. Bull's client queues
 * commands while Redis is unreachable and rejects them after its retry budget (~10–40 s), so a
 * Redis that was down at boot turned into a rejected `onModuleInit`, an unhandled bootstrap
 * error and `process.exit(1)` — a crash-loop for as long as Redis stayed down, from code whose
 * only job is to make sure a cron fires later. `main.ts` claims a graceful single-node fallback
 * when the Redis socket adapter is unavailable; this made that claim false.
 *
 * Registration is therefore fire-and-forget from the caller's point of view: on failure it logs
 * and retries in the background with capped backoff. The API serves requests meanwhile. If Redis
 * never comes back the schedules never register — and the same outage has already stopped every
 * queue from processing anyway, which is the louder symptom.
 *
 * ## Idempotent across replicas
 *
 * Bull dedupes a repeatable job by (name, cron, tz), so N replicas registering the same schedule
 * produce one schedule. Removing a stale one on two replicas at once is a no-op on the second.
 *
 * ## Why it keeps checking
 *
 * Converging once at boot is not enough, and the gap is silent. Bull schedules the NEXT firing of
 * a repeatable only while its `bull:<queue>:repeat` member still exists; if that key goes — a
 * Redis restart without persistence, an eviction, somebody's `FLUSHALL` — the job simply stops
 * firing and Bull reports nothing, because from its point of view there is no schedule to run.
 *
 * Observed on a real deployment: nine minutes with no cron of any kind. `audit-seal` fired once
 * and stopped, the outbox sat undispatched across three tick boundaries, 134 audit events went
 * unsealed — while `/health` said ok, the worker stayed healthy, ordinary Bull jobs kept
 * succeeding and nothing was logged. Reproduced in isolation on a throwaway queue: drop the
 * repeat key, and there are zero further firings, for ever, with no error. Only a restart
 * recovered it.
 *
 * The outbox is what books payables, so "the cron stopped and nobody noticed" is money quietly
 * not being booked.
 *
 * So the convergence repeats on a plain `setInterval`. Deliberately NOT a Bull repeatable itself:
 * a scheduled job that checks whether scheduled jobs are running dies of the same illness it is
 * meant to detect. And every re-convergence that has to RE-ADD something says so at warn level,
 * because self-healing in silence is how a recurring fault becomes invisible.
 */
export function ensureRepeatableSchedules(
  queue: Queue,
  wanted: WantedSchedule[],
  logger: Logger,
  opts: { retryDelaysMs?: number[]; reconcileIntervalMs?: number } = {},
): void {
  const delays = opts.retryDelaysMs ?? [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  /**
   * Five minutes: short enough that the worst case is one missed tick of the most frequent
   * schedule plus the interval, long enough that a `getRepeatableJobs` per queue is nothing.
   * `0` disables it, which is what the unit tests use — they assert one convergence, not a timer.
   */
  const reconcileEvery = opts.reconcileIntervalMs ?? Number(process.env.SCHEDULE_RECONCILE_MS ?? 300_000);

  const attempt = async (n: number): Promise<void> => {
    try {
      await convergeOnce(queue, wanted, logger);
    } catch (err) {
      const delay = delays[Math.min(n, delays.length - 1)];
      logger.warn(
        `Could not register repeatable schedules on queue "${queue.name}" (${(err as Error).message}); ` +
          `retrying in ${Math.round(delay / 1000)}s. The API keeps serving meanwhile.`,
      );
      const timer = setTimeout(() => void attempt(n + 1), delay);
      // Never keep the process alive just to retry a cron registration.
      timer.unref?.();
    }
  };

  void attempt(0);

  if (reconcileEvery > 0) {
    const timer = setInterval(() => {
      void reconcile(queue, wanted, logger);
    }, reconcileEvery);
    // Never keep the process alive just to re-check a cron registration.
    timer.unref?.();
  }
}

/**
 * Re-check, and say something only when there was something to say.
 *
 * A quiet pass must stay quiet — this runs every five minutes on every queue, and a log line per
 * pass would bury the one that matters. A pass that finds a wanted schedule MISSING is the
 * opposite: that is the failure this exists for, and it is reported at warn level with the queue
 * and the job named, whether or not the re-add succeeds.
 */
async function reconcile(queue: Queue, wanted: WantedSchedule[], logger: Logger): Promise<void> {
  try {
    const existing = await queue.getRepeatableJobs();
    const present = new Set(existing.map((j) => scheduleKey(j.name, (j as { id?: string | null }).id)));
    const missing = wanted.filter((w) => !present.has(scheduleKey(w.name, w.jobId)));
    if (missing.length === 0) return;

    logger.warn(
      `Repeatable schedule(s) had disappeared from queue "${queue.name}" and were not firing: ` +
        `${missing.map((m) => `${m.name} (${m.cron})`).join(', ')}. Re-registering. ` +
        'A schedule vanishing from Redis is silent in Bull — nothing else would have reported this.',
    );
    await convergeOnce(queue, wanted, logger);
  } catch (err) {
    // Never throw out of a timer. Redis being unreachable is already the louder symptom, and the
    // next pass will try again.
    logger.warn(`Could not re-check repeatable schedules on queue "${queue.name}": ${(err as Error).message}`);
  }
}

/** A schedule's identity: the job name, plus the jobId when one distinguishes it from a sibling. */
const scheduleKey = (name: string, jobId?: string | null): string => `${name}::${jobId ?? ''}`;

async function convergeOnce(queue: Queue, wanted: WantedSchedule[], logger: Logger): Promise<void> {
  // Keyed by name AND jobId. Keyed by name alone, two schedules of one job name collapsed to
  // whichever was listed last, and the stale-removal below then compared every firing against
  // that one — so a sibling with a different cron was deleted as though it had drifted.
  const wantedByName = new Map(wanted.map((w) => [scheduleKey(w.name, w.jobId), w]));

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    const want = wantedByName.get(scheduleKey(job.name, (job as { id?: string | null }).id));
    if (want && (job.cron !== want.cron || (want.tz && job.tz !== want.tz))) {
      await queue.removeRepeatableByKey(job.key);
      logger.warn(`Removed stale ${job.name} schedule on "${queue.name}": ${job.cron}${job.tz ? ` ${job.tz}` : ''}`);
    }
  }

  for (const w of wanted) {
    await queue.add(
      w.name,
      w.data ?? {},
      {
        /**
         * Retention, not "keep every failure forever".
         *
         * `removeOnFail: false` kept every failed tick of every cron job in Redis permanently.
         * That is worse here than on a user-triggered queue: a cron tick is guaranteed and
         * unbounded in time, so the failures accrue on their own schedule with nobody having
         * asked for anything. The outbox `drain` fires every minute — a database it cannot reach
         * leaves 1,440 permanent failed entries a day, precisely when the system is already
         * degraded — and the notification sweep (every 5 min) and SLA scan (every 15 min) add
         * another 384 on top, before the hourly and daily schedules.
         *
         * Redis runs with `maxmemory` and `noeviction` in production (see bull-queue-manager.ts),
         * so an unbounded key set does not quietly evict a cache key to make room: Redis starts
         * refusing writes, which takes down the cache, the rate limiters and every other queue
         * with it. `BullQueueManager` and the `ocr` queue were fixed for exactly this; the
         * repeatable schedules — the one producer that is guaranteed to keep producing — were
         * missed.
         *
         * Both sit before `...w.jobOptions` so an individual schedule can still declare its own
         * (the SLA scan and geo sweeps already declare `attempts`/`backoff` there).
         */
        removeOnComplete: true,
        removeOnFail: FAILED_JOB_RETENTION,
        ...w.jobOptions,
        ...(w.jobId ? { jobId: w.jobId } : {}),
        repeat: { cron: w.cron, ...(w.tz ? { tz: w.tz } : {}) },
      },
    );
  }

  logger.log(
    `Repeatable schedules registered on "${queue.name}": ${wanted.map((w) => `${w.name}@"${w.cron}"`).join(', ')}`,
  );
}
