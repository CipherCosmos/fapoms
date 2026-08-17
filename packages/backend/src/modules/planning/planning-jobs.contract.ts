/**
 * FAPOMS — Planning job queue contract.
 *
 * The queue name, the job names and the payload each job carries, in one place so that the
 * enqueue side (`PlanningJobsService`) and the execute side (`PlanningJobsWorker`) cannot drift
 * apart.
 *
 * That drift is not hypothetical here. `BullQueueManager` enqueues onto 'background-jobs' with
 * `queue.add(job.name, …)` while `BullProcessor` declares a bare `@Process()`. In Bull a bare
 * `@Process()` handles only jobs added *without* a name, so every job that manager enqueues sits
 * in the queue with no handler and is eventually reported as stalled — the two halves were
 * written against different assumptions about the same string. Naming the handlers from these
 * constants, on both sides, is what makes the same mistake impossible on this queue.
 */

import type { KeepJobsOptions, JobOptions } from 'bull';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';

/** Its own queue, not 'background-jobs' — see the module doc for why. */
export const PLANNING_QUEUE = 'planning-jobs';

/**
 * Job names. These strings appear in exactly two places: `queue.add(PLANNING_JOB.X, …)` and
 * `@Process({ name: PLANNING_JOB.X })`.
 */
export const PLANNING_JOB = {
  COVERAGE_PLAN: 'coverage-plan',
  PROJECT_CANDIDATES: 'project-candidates',
  DAY_PLANS: 'day-plans',
} as const;

export type PlanningJobName = (typeof PLANNING_JOB)[keyof typeof PLANNING_JOB];

/**
 * The scope the job runs under.
 *
 * Carried in the payload rather than resolved in the worker, because the worker has no request
 * and therefore no principal. The synchronous routes take `@GlobalScopeFilter()`, which has
 * already intersected the requested region against `users.regions` and refused anything the
 * account does not hold; freezing that resolved scope into the payload means the queued run
 * returns exactly what the synchronous run would have, and means a worker cannot accidentally
 * run a regional operator's request unscoped.
 */
export type ScopeSnapshot = Partial<GlobalScope> | null;

export interface CoveragePlanJobData extends QueuedJobEnvelope {
  projectId: string;
  scope: ScopeSnapshot;
}

export interface ProjectCandidatesJobData extends QueuedJobEnvelope {
  projectId: string;
  scope: ScopeSnapshot;
}

export interface DayPlansJobData extends QueuedJobEnvelope {
  /** One or more project ids; sorted at enqueue time so the dedupe fingerprint is stable. */
  projectIds: string[];
  targetDate?: string;
  /** The operator's "Min Radius Filter", if their toggle is on. */
  minDistanceKm?: number;
}

/**
 * How long a *completed* planning job is kept.
 *
 * The result is the deliverable here — the poll response is how the plan reaches the browser —
 * so the whole plan JSON lives in the job hash in Redis. That is the sizing constraint: a
 * 200-branch candidates report is a few megabytes even after the shortlist cap
 * (PROJECT_CANDIDATES_PER_BRANCH=5 trimmed it from a measured 39 MB), so the honest budget is
 * "how many megabytes may this queue hold", not "how many jobs feel tidy".
 *
 * 30 minutes × 50 jobs is a low-single-digit-gigabyte worst case and, far more usually, a few
 * tens of megabytes. Thirty minutes is generous for a poller that ticks every couple of seconds;
 * it exists so that a result survives an operator switching tabs, not so that it can be
 * bookmarked. Both bounds apply together — Bull keeps only jobs satisfying age *and* count.
 *
 * This is the same Redis that backs the socket adapter, the RBAC cache and the throttler, which
 * is the reason for a bound at all rather than `false`.
 */
export const PLANNING_COMPLETED_RETENTION: KeepJobsOptions = { age: 30 * 60, count: 50 };

/**
 * Options every planning job is enqueued with.
 *
 * **`attempts: 1`.** These jobs are read-only, so a retry would be *safe* — but it would not be
 * *useful*. Their failures are deterministic (a project id that does not exist, a client with no
 * configuration, a branch with no coordinates), so a second attempt spends the same six to
 * twelve seconds of CPU to produce the same error, on a queue whose concurrency is 1. One
 * attempt surfaces the real message to the operator immediately instead.
 *
 * **`timeout`.** With concurrency 1, a job that wedges — a query that never returns, a driver
 * that never rejects — holds the only slot and every later request queues behind it forever. Ten
 * minutes is roughly ninety times the measured 6.8 s coverage plan, so it can only ever fire on
 * something genuinely broken, and when it does the slot is released.
 */
export const PLANNING_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  timeout: 10 * 60_000,
  removeOnComplete: PLANNING_COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
