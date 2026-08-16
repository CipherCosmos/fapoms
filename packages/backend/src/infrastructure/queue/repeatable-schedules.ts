import { Logger } from '@nestjs/common';
import type { JobOptions, Queue } from 'bull';

/**
 * One wanted schedule on a queue: a named job that fires on `cron` (optionally in `tz`).
 */
export interface WantedSchedule {
  name: string;
  cron: string;
  tz?: string;
  /** Extra Bull job options (attempts, backoff…). `repeat`/`removeOnComplete` are set here. */
  jobOptions?: Omit<JobOptions, 'repeat'>;
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
 */
export function ensureRepeatableSchedules(
  queue: Queue,
  wanted: WantedSchedule[],
  logger: Logger,
  opts: { retryDelaysMs?: number[] } = {},
): void {
  const delays = opts.retryDelaysMs ?? [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

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
}

async function convergeOnce(queue: Queue, wanted: WantedSchedule[], logger: Logger): Promise<void> {
  const wantedByName = new Map(wanted.map((w) => [w.name, w]));

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    const want = wantedByName.get(job.name);
    if (want && (job.cron !== want.cron || (want.tz && job.tz !== want.tz))) {
      await queue.removeRepeatableByKey(job.key);
      logger.warn(`Removed stale ${job.name} schedule on "${queue.name}": ${job.cron}${job.tz ? ` ${job.tz}` : ''}`);
    }
  }

  for (const w of wanted) {
    await queue.add(
      w.name,
      {},
      {
        removeOnComplete: true,
        removeOnFail: false,
        ...w.jobOptions,
        repeat: { cron: w.cron, ...(w.tz ? { tz: w.tz } : {}) },
      },
    );
  }

  logger.log(
    `Repeatable schedules registered on "${queue.name}": ${wanted.map((w) => `${w.name}@"${w.cron}"`).join(', ')}`,
  );
}
