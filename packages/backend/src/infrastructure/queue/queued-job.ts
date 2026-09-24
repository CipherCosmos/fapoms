/**
 * FAPOMS — Shared vocabulary for "accept the work, poll for the answer" endpoints.
 *
 * ## Why this exists
 *
 * Three planning reports (coverage plan, project candidates, day plans) and four spreadsheet
 * exports all do the same thing: minutes-to-seconds of CPU and hundreds of queries, produced
 * synchronously inside an HTTP request. On the 200k-assignment scale database a 200-branch
 * coverage plan measured 6.8 s and the candidates report 12.2 s — long enough that the browser,
 * the reverse proxy and the connection pool are all held for the duration, and long enough that
 * two operators refreshing together is a capacity incident rather than a slow page.
 *
 * Moving them onto a queue needs the same four things in every case — enqueue, poll, report
 * progress, hand back the result — so those four live here once rather than being written twice
 * (planning) and four times again (reports). See `one-implementation-rule`: a cross-cutting
 * concern gets one canonical home.
 *
 * ## Where it lives
 *
 * `infrastructure/queue/`, alongside the Bull wiring it belongs to. It was first written under
 * `modules/planning/` because that was the only directory the change introducing it owned, with
 * a note to move it the next time this directory was touched. Billing sync became its third
 * consumer, at which point three feature modules importing a cross-cutting helper out of a
 * fourth feature module stopped being a compromise and started being the thing the
 * one-implementation rule exists to prevent.
 *
 * ## What it deliberately does NOT do
 *
 * It did not wrap `BullQueueManager` (deleted 2026-09-24 with its 'background-jobs' queue, which
 * nothing enqueued onto). That manager added *named* jobs while `BullProcessor` declared an unnamed
 * `@Process()`, which in Bull means "handle only jobs added with no name" — so every job routed
 * through it dead-lettered. Each queue
 * introduced here registers its own processor with `@Process({ name })` handlers whose names
 * match exactly what is enqueued, which is the whole reason that defect cannot repeat here.
 */

import { NotFoundException } from '@nestjs/common';
import type { Job, JobStatus, KeepJobsOptions, Queue } from 'bull';

/**
 * The four states a caller has to be able to act on.
 *
 * Bull has six (`waiting`, `delayed`, `paused`, `active`, `completed`, `failed`) plus the
 * pseudo-state `stuck`, and the distinction between "waiting behind another job", "delayed by a
 * backoff" and "the whole queue is paused" is not one a polling UI can do anything useful with.
 * Collapsing them keeps the client's state machine to: keep polling / show a result / show an
 * error.
 */
export type QueuedJobState = 'queued' | 'running' | 'done' | 'failed';

/**
 * What the poll endpoint reports about progress.
 *
 * `percent` alone is not enough: a coverage plan spends its first seconds loading a project and
 * its assayer roster with nothing to count, so a bare 0% reads as "nothing is happening". The
 * stage label is what makes the difference between a stalled job and a job in its opening phase
 * visible to whoever is watching the spinner.
 */
export interface JobProgress {
  /** 0–100, clamped. Forced to 100 once the job is done, whatever the last write said. */
  percent: number;
  /** Human-readable phase, e.g. "Scoring branches (37/200)". */
  stage: string;
}

/**
 * The progress hook the long-running services accept.
 *
 * Deliberately expressed in units of work rather than percent, so the caller (a service that
 * knows it is on branch 37 of 200) does not have to know how its phase maps onto the overall
 * bar, and so nothing below the worker has to import Bull. `progressReporter` below is the only
 * adapter from this to a Bull job.
 *
 * Awaited by callers, because writing progress is a Redis round trip; `progressReporter`
 * suppresses the writes that would not change what the poller sees, so awaiting it in a
 * per-branch loop costs a function call rather than a network hop on most iterations.
 */
export type ProgressCallback = (done: number, total: number, stage: string) => void | Promise<void>;

/**
 * Fields every queued-job payload carries, whatever the job does.
 *
 * `requestedBy` is not bookkeeping — it is the access check. See `assertJobVisibleTo`.
 */
export interface QueuedJobEnvelope {
  /** The user id that enqueued this job. The only principal allowed to read it back. */
  requestedBy: string;
  /** Stable fingerprint of (job name + inputs + requester) — see `dedupeKeyFor`. */
  dedupeKey: string;
  /**
   * The `background_jobs` row that tracks this run, when it was enqueued through
   * `BackgroundJobsService.enqueueTracked` — what lets a refreshed page and the Jobs tray find it
   * again. Absent on a job queued before tracking existed; `BackgroundJobTracker` then runs it
   * untracked, exactly as before.
   */
  backgroundJobId?: string;
}

/**
 * How long a *failed* job is kept, on every queue that uses this module.
 *
 * Failures are a few hundred bytes (a message and a stack) and they are the only record that a
 * report an operator asked for never arrived, so they are worth a week. Completed retention is
 * deliberately NOT shared: a completed planning job holds megabytes of plan JSON and a completed
 * export job holds only a filename, so they cannot sensibly carry the same budget. Each queue
 * declares its own with the arithmetic written down.
 *
 * Never `false`. `false` on both means "keep every job forever" — that is what filled Redis
 * previously, and it was `BullQueueManager`'s setting until it was changed to a bounded
 * `{ age, count }` (bull-queue-manager.ts). The `ocr` queue carried the same `false` for longer
 * still; it is bounded now too. Nothing in this codebase should reintroduce it.
 */
export const FAILED_JOB_RETENTION: KeepJobsOptions = { age: 7 * 86_400, count: 500 };

/**
 * Ceiling on how far back an in-flight-duplicate scan will look.
 *
 * `Queue.getJobs` pulls whole list ranges into memory, so this is bounded rather than open.
 * Every queue using it is throttled at the controller and runs at concurrency 1, so the waiting
 * list is normally single digits; 200 is a ceiling, not an expectation.
 */
export const IN_FLIGHT_SCAN_LIMIT = 200;

/**
 * An identical request (same job name and `dedupeKey`) that has not finished yet, or null.
 *
 * Only unfinished states are considered. Matching a *completed* job would be worse than no
 * deduplication at all: for the retention window every re-request would return the first run's
 * answer — an operator who changed something and pressed again would be told nothing had changed.
 *
 * A failure here never blocks the enqueue. The scan is an optimisation — the worst consequence of
 * skipping it is one redundant run — whereas refusing to accept the work because a list read failed
 * would turn a Redis hiccup into an outage of the endpoint.
 *
 * The one implementation of the rule; every queue that de-duplicates by fingerprint uses it
 * (through `BackgroundJobsService.enqueueTracked`, and directly by any queue that is not tracked).
 */
export async function findInFlightDuplicate(
  queue: Pick<Queue, 'getJobs'>,
  name: string,
  dedupeKey: string,
  logger?: { warn(message: string): void },
): Promise<Job | null> {
  try {
    const jobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, IN_FLIGHT_SCAN_LIMIT);
    return (
      jobs.find(
        (j) => j?.name === name && (j.data as Partial<QueuedJobEnvelope> | undefined)?.dedupeKey === dedupeKey,
      ) ?? null
    );
  } catch (err) {
    logger?.warn(`Could not scan for an in-flight ${name} job (${(err as Error).message}); enqueuing anyway.`);
    return null;
  }
}

/**
 * Canonical fingerprint of a job request, used to collapse duplicate submissions.
 *
 * The failure this prevents: a POST that returns 202 invites the client to retry. A page that
 * re-fires on focus, a double-clicked button, or a fetch wrapper with automatic retries can put
 * ten identical 12-second coverage plans on the queue in a minute, and every one of them
 * computes the same answer. Requests that are still queued or running and carry the same
 * fingerprint therefore return the id of the job already doing the work.
 *
 * The requester is part of the key on purpose. Two operators can ask for "the coverage plan for
 * project X" under different region scopes and get legitimately different answers, and sharing a
 * job between them would hand one of them the other's scope. Scope is in the payload and so is
 * already part of the fingerprint, but keying on the requester as well means a scoping bug can
 * never become a cross-user data leak.
 */
export function dedupeKeyFor(jobName: string, requestedBy: string, params: unknown): string {
  return `${jobName}|${requestedBy}|${stableStringify(params)}`;
}

/**
 * JSON with object keys sorted, recursively.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}` — the same request
 * arriving through two code paths — would fingerprint differently and defeat the deduplication
 * above. Arrays keep their order, because for these payloads order is meaningful (a day plan
 * over projects [A,B] is the same request as [B,A] only because the caller sorts the ids before
 * it gets here).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Adapts a service's unit-of-work progress hook onto a Bull job.
 *
 * Two things this does that a bare `job.progress(pct)` does not:
 *
 * 1. **Suppresses no-op writes.** The per-branch loops call this once per branch; on a
 *    200-branch project that is 200 Redis writes to move a bar through 100 integers. Only a
 *    change in the rendered `(percent, stage)` is written, so the cost tracks what the poller
 *    can actually see.
 * 2. **Never lets progress reporting fail the job.** A write to Redis that rejects mid-plan
 *    would abort six seconds of completed work in order to fail at updating a progress bar.
 *    Progress is advisory; the result is not.
 */
export function progressReporter(job: Pick<Job, 'progress'>): ProgressCallback {
  let lastWritten = '';

  return async (done: number, total: number, stage: string): Promise<void> => {
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;

    /**
     * Suppression is keyed on `(percent, stage)` and NOT on the rendered label, even though the
     * label is what the poller displays. The label carries the item counter, which changes on
     * every call — keying on it would make every key unique and write once per branch, which is
     * exactly the cost this exists to avoid. Keyed this way, the counter shown is the one that
     * was true at the moment the percentage last moved, which is accurate at write time and is
     * all the label claims to be.
     */
    const key = `${percent}|${stage}`;
    if (key === lastWritten) return;
    lastWritten = key;

    const label = total > 1 ? `${stage} (${Math.min(done, total)}/${total})` : stage;

    try {
      await job.progress({ percent, stage: label } satisfies JobProgress);
    } catch {
      // Advisory only — see above. Swallowed rather than logged because a Redis blip during a
      // 200-branch loop would otherwise emit one line per branch.
    }
  };
}

/** What `describeJob` reports back to a polling client. */
export interface QueuedJobStatus<TResult = unknown> {
  jobId: string;
  state: QueuedJobState;
  progress: JobProgress;
  /** Present only when `state === 'done'` and the caller asked for the payload to be included. */
  result?: TResult;
  /** Present only when `state === 'failed'`. Never a stack trace — see below. */
  error?: string;
  /** ISO timestamps, or null where the transition has not happened yet. */
  enqueuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Collapses a Bull job into the poll response.
 *
 * `includeResult` exists because the two consumers want opposite things. A planning poll IS the
 * delivery mechanism for the plan, so it must carry the result. A report poll must not: the
 * result there is an .xlsx of up to twenty megabytes, and a client polling every two seconds
 * would drag it across the wire on every tick. Reports poll for `state` and then fetch the file
 * once from a separate route.
 */
export async function describeJob<TResult = unknown>(
  job: Job,
  opts: { includeResult?: boolean } = {},
): Promise<QueuedJobStatus<TResult>> {
  const settled = await resolveState(job);
  job = settled.job;
  const raw = settled.raw;
  const state = toQueuedState(raw);

  const status: QueuedJobStatus<TResult> = {
    jobId: String(job.id),
    state,
    progress: normaliseProgress(job.progress(), state),
    enqueuedAt: toIso(job.timestamp),
    startedAt: toIso(job.processedOn),
    finishedAt: toIso(job.finishedOn),
  };

  if (state === 'done' && opts.includeResult !== false) {
    status.result = job.returnvalue as TResult;
  }

  if (state === 'failed') {
    /**
     * The message only, never `job.stacktrace`.
     *
     * The services behind these jobs throw messages written for operators ("Project … not
     * found", "No project found for …"), and those are exactly what should surface. A stack
     * trace names internal file paths and class names to whoever can reach the endpoint, which
     * is a much wider audience than whoever can read the server log where it already is.
     */
    status.error = job.failedReason?.trim() || 'The job failed without reporting a reason.';
  }

  if (raw === 'stuck') {
    /**
     * Bull reports `stuck` when a job hash exists but the job is in none of the queue's lists —
     * in practice, a worker that died holding the lock. It will never progress and it will never
     * complete, so reporting it as `running` would leave the client polling forever.
     */
    status.error =
      'The queue is no longer tracking this job (its worker most likely restarted mid-run). Run it again.';
  }

  return status;
}

/**
 * How long to wait before asking a second time whether a job is really stuck.
 *
 * Long enough for a job to finish crossing between two of Bull's lists, short enough that a
 * poll does not feel stalled. The transient was measured at roughly one poll in six against a
 * local stack, and every occurrence resolved on the very next read 25ms later.
 */
const STUCK_RECHECK_MS = 250;

/**
 * Ask twice before declaring a job dead, because `stuck` is two different things.
 *
 * `Job.getState()` is six sequential Redis reads — completed, failed, delayed, active, waiting,
 * paused — and reports `stuck` when none of them matched. A worker that died holding the lock
 * looks like that, which is what the state is for. So does a perfectly healthy job that moved
 * from `waiting` to `active` while the six reads were being made: the early checks miss it in
 * the list it has left and the later ones miss it in the list it has not yet reached.
 *
 * The two are indistinguishable from one read and trivially distinguishable from two, because a
 * dead job stays stuck forever and a moving one does not. Measured on a local stack, 2 of 12
 * billing runs reported `stuck` on one poll and `done` on the next — and `stuck` is mapped to
 * `failed`, which is terminal for a polling client. So one press in six of Approve or Pay told
 * the operator their money action had failed when it had in fact just succeeded, and advised
 * them to run it again. The money itself was never at risk — a second approval of an approved
 * payout is a no-op and a second payment of a paid one is refused — but "it failed, try again"
 * on a screen that moves money is the kind of false alarm that gets a real payment made twice by
 * hand, outside the system, to make up for one the operator believes did not happen.
 *
 * The job is RE-FETCHED rather than only re-read: `returnvalue` and `finishedOn` are snapshots
 * taken when the job was loaded, so a job that completed in between would otherwise be reported
 * as done with no result. If it has vanished entirely by the second look, the original is used
 * and will report stuck, which is the right answer for a job that is no longer there.
 */
async function resolveState(job: Job): Promise<{ job: Job; raw: JobStatus | 'stuck' }> {
  const first = await job.getState();
  if (first !== 'stuck') return { job, raw: first };
  await new Promise((r) => setTimeout(r, STUCK_RECHECK_MS));
  const fresh = (await job.queue?.getJob?.(job.id)) ?? job;
  return { job: fresh, raw: await fresh.getState() };
}

/** Bull's seven states, collapsed onto the four a client can act on. */
function toQueuedState(raw: JobStatus | 'stuck'): QueuedJobState {
  switch (raw) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'active':
      return 'running';
    case 'stuck':
      // See describeJob: unrecoverable, so it must terminate the client's polling loop.
      return 'failed';
    default:
      // waiting | delayed | paused
      return 'queued';
  }
}

function normaliseProgress(raw: unknown, state: QueuedJobState): JobProgress {
  // A job that finished reports 100 whatever its last write said. The final progress write
  // happens before the last chunk of work, so a completed plan would otherwise sit at 99%.
  if (state === 'done') return { percent: 100, stage: 'Complete' };

  if (raw && typeof raw === 'object' && typeof (raw as JobProgress).percent === 'number') {
    const p = raw as JobProgress;
    return {
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      stage: typeof p.stage === 'string' && p.stage ? p.stage : 'Working',
    };
  }

  // Bull initialises `_progress` to the number 0, so this is the normal shape for a job that has
  // not written progress yet, not an error case.
  if (typeof raw === 'number') {
    return { percent: Math.max(0, Math.min(100, Math.round(raw))), stage: 'Working' };
  }

  return { percent: 0, stage: state === 'failed' ? 'Failed' : 'Queued' };
}

function toIso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Refuses to hand a job to anyone but the account that enqueued it.
 *
 * This is load-bearing, not defensive tidiness. Bull job ids are a per-queue incrementing
 * integer — the first coverage plan of the day is job "1" — so `GET /planning/jobs/2` is a
 * guess, not an exploit. The results behind these ids are region-scoped: the sync routes take
 * `@GlobalScopeFilter()` precisely so a West operator sees West branches, and without this check
 * that same operator could read the national plan an administrator ran a minute earlier, branch
 * list and candidate assayers included.
 *
 * `NotFoundException`, not `ForbiddenException`, and with wording that does not distinguish the
 * two cases: a 403 on someone else's id and a 404 on an unused one together confirm which ids
 * exist, which is all an enumeration attempt needs.
 *
 * No administrator override. An administrator who needs the answer can run the job themselves —
 * it is a read — and that keeps this rule with no exceptions to reason about.
 */
export function assertJobVisibleTo(job: Job | null, userId: string | undefined): Job {
  if (!job || !userId || (job.data as Partial<QueuedJobEnvelope> | undefined)?.requestedBy !== userId) {
    throw new NotFoundException(
      'No such job. Results are kept for a limited time and are only readable by the account that requested them.',
    );
  }
  return job;
}
