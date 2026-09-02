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
 * It does not wrap `BullQueueManager`. That manager adds *named* jobs to the 'background-jobs'
 * queue while `BullProcessor` declares an unnamed `@Process()`, which in Bull means "handle only
 * jobs added with no name" — so every job routed through it currently dead-letters. Each queue
 * introduced here registers its own processor with `@Process({ name })` handlers whose names
 * match exactly what is enqueued, which is the whole reason that defect cannot repeat here.
 */

import { NotFoundException } from '@nestjs/common';
import type { Job, JobStatus, KeepJobsOptions } from 'bull';

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
  const raw = await job.getState();
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
