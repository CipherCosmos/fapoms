/**
 * FAPOMS — Planning WRITE job queue contract.
 *
 * ## Why these left the request
 *
 * Deploying an approved coverage plan created every assignment inside one HTTP request. Each
 * `AssignmentService.create` runs eligibility, a fee quote, a road route (4 s timeout), a row lock, a
 * transaction and audit writes, and the executor tries up to ten dates per branch. A 166-branch
 * plan at 0.2–0.5 s a branch passes the web client's 30 s budget: the screen reported a failure
 * while the server carried on creating offers, and pressing Deploy again started a second run.
 *
 * The planning desk's two bulk buttons had the same shape from the other side: "Offer all to …"
 * sent up to 500 `POST /assignments` from the browser five at a time, and "Mark unable to cover"
 * fired one unbounded `Promise.all` of POSTs — 500 ticked branches is past the 300-a-minute
 * per-user brake, so some were refused with 429 and reported only as a name in a list.
 *
 * ## Why a queue of its own, and not more handlers on 'planning-jobs'
 *
 * Bull's worker loops belong to the QUEUE, not to a job name: every `@Process({ name })` adds
 * `concurrency` loops, and each loop takes the next job of ANY name (bull 4.16.5
 * `Queue.prototype.run` / `getNextJob`; the name only picks the handler afterwards). The read queue
 * already has three such loops. A fourth, named for execute, would have let two deploys — of the
 * same plan, by two operators — run side by side on two of those loops, each with its own in-memory
 * assayer-capacity map. And a stalled-job setting is per queue, so "a write that died mid-run must
 * not restart from the top" could not be said for writes without also saying it for the reads.
 *
 * So writes get this queue, ONE `'*'` loop (see `PlanningWriteJobsWorker`), and
 * `maxStalledCount: 0` (see `PLANNING_WRITE_QUEUE_SETTINGS`). Reads keep their three loops and their
 * default stall recovery, untouched.
 */

import type { AdvancedSettings, JobOptions, KeepJobsOptions } from 'bull';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';
import type { ScopeSnapshot } from './planning-jobs.contract';
import type { JobActor } from '../../infrastructure/queue/job-actor';

export const PLANNING_WRITE_QUEUE = 'planning-write-jobs';

export const PLANNING_WRITE_JOB = {
  /** Deploy an APPROVED coverage plan: one PENDING offer per branch, spread over workable dates. */
  EXECUTE_PLAN: 'execute-plan',
  /** Generate (or regenerate) a plan version: the whole coverage engine, then a version row. */
  GENERATE_VERSION: 'generate-version',
  /** Offer a selection of branches to one assayer, each its own assignment. */
  BULK_OFFER: 'bulk-offer',
  /** Record a selection of branches as unable to cover, with one reason. */
  BULK_UNABLE_TO_COVER: 'bulk-unable-to-cover',
} as const;

export type PlanningWriteJobName = (typeof PLANNING_WRITE_JOB)[keyof typeof PLANNING_WRITE_JOB];

/**
 * Registration settings for the write queue.
 *
 * `maxStalledCount: 0`: a run whose worker died mid-way (deploy, out-of-memory, lost lock) is FAILED,
 * not restarted. Bull's default re-runs a stalled job once from the top, and `attempts: 1` does not
 * stop that — stalled recovery is its own counter. A deploy restarted from the top is safe now
 * (see `OperationsPlanningService.executeApprovedPlan`'s per-branch idempotency), but a bulk offer
 * restarted from the top would re-offer every branch it had already offered, re-notifying each
 * assayer. The operator is told the run failed and re-runs it knowing what it does.
 */
export const PLANNING_WRITE_QUEUE_SETTINGS: AdvancedSettings = { maxStalledCount: 0 };

export interface ExecutePlanJobData extends QueuedJobEnvelope {
  planId: string;
  /** The campaign's start date (YYYY-MM-DD); each branch is spread forward from it. */
  scheduledDate?: string;
  actor: JobActor;
}

export interface GenerateVersionJobData extends QueuedJobEnvelope {
  projectId: string;
  overrides: Array<Record<string, unknown>>;
  justification?: string;
  actor: JobActor;
}

export interface BulkOfferJobData extends QueuedJobEnvelope {
  /** Sorted and de-duplicated at enqueue, so the fingerprint is stable. */
  projectBranchIds: string[];
  assayerId: string;
  assayerName?: string;
  scheduledDate?: string;
  acceptOnBehalf: boolean;
  acceptanceReason?: string;
  /**
   * The region scope resolved at the request, re-asserted per branch in the worker. The synchronous
   * `POST /assignments` asserts it per call; a batch that skipped it would let a regional operator
   * offer another region's branches by id.
   */
  scope: ScopeSnapshot;
  actor: JobActor;
}

export interface BulkUnableToCoverJobData extends QueuedJobEnvelope {
  projectBranchIds: string[];
  reason: string;
  scope: ScopeSnapshot;
  actor: JobActor;
}

/** One branch's outcome in a bulk run. Every branch lands in exactly one of the two lists. */
export interface BulkBranchSucceeded {
  projectBranchId: string;
  assignmentId?: string;
  /** For an offer: PENDING, or ACCEPTED when the desk confirmed on the assayer's behalf. */
  status?: string;
}

export interface BulkBranchFailed {
  projectBranchId: string;
  /** The refusal in the words the synchronous route would have used. */
  error: string;
}

export interface BulkBranchResult {
  succeeded: BulkBranchSucceeded[];
  failed: BulkBranchFailed[];
}

/** A finished run's per-branch outcome is what the operator comes back for; a few hours is plenty. */
export const PLANNING_WRITE_COMPLETED_RETENTION: KeepJobsOptions = { age: 6 * 60 * 60, count: 50 };

/**
 * Options every planning write job is enqueued with.
 *
 * **`attempts: 1`.** These WRITE. A retry after a failure part-way through would re-offer what was
 * already offered. A failed run is reported with its reason; the operator decides.
 *
 * **`timeout`.** Bull's timeout fails the job but does NOT stop the handler, which carries on in the
 * background while the loop moves to the next job. On a write queue that is a second run overlapping
 * the first, so the bound is set far past any real run — 500 branches at ten dated attempts and half
 * a second each is 42 minutes — and exists only so that a genuinely wedged run eventually releases
 * the slot.
 */
export const PLANNING_WRITE_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  timeout: 2 * 60 * 60_000,
  removeOnComplete: PLANNING_WRITE_COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
