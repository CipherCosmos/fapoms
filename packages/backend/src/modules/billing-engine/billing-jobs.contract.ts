/**
 * FAPOMS — Billing job queue contract.
 *
 * The queue name, the job name and the payload it carries, in one place so that the enqueue side
 * (`BillingJobsService`) and the execute side (`BillingJobsWorker`) cannot drift apart. Same
 * reasoning as `planning-jobs.contract.ts`: the 'background-jobs' queue was broken for exactly
 * that kind of drift — `queue.add(name, …)` on one side, a bare `@Process()` on the other — and
 * naming both halves from these constants is what makes it impossible here.
 */

import type { JobOptions, KeepJobsOptions } from 'bull';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';

/** Its own queue, not 'background-jobs'. */
export const BILLING_QUEUE = 'billing-jobs';

/**
 * Job names. Each appears in exactly two places: `queue.add(BILLING_JOB.X, …)` and
 * `@Process({ name: BILLING_JOB.X })`.
 */
export const BILLING_JOB = {
  SYNC_ASSIGNMENTS: 'sync-assignments',
} as const;

export type BillingJobName = (typeof BILLING_JOB)[keyof typeof BILLING_JOB];

/**
 * The backfill carries no parameters — it scans the whole book by design.
 *
 * `requestedBy` is not decoration: every entry and payable this job creates is attributed to
 * that user id in `created_by` and in the billing history, so the person who pressed the button
 * is on the record for what it wrote. It is also what `assertJobVisibleTo` matches on, so one
 * operator cannot poll another's run.
 */
export interface SyncAssignmentsJobData extends QueuedJobEnvelope {}

/**
 * How long a completed sync is kept.
 *
 * Unlike the planning queue, the result here is a small summary — counts plus a bounded error
 * list — not the deliverable itself, so the sizing constraint is "long enough for an operator to
 * come back and read what happened", not megabytes. An hour covers a coffee break; twenty runs
 * is more history than anyone reads. Both bounds apply together.
 */
export const BILLING_COMPLETED_RETENTION: KeepJobsOptions = { age: 60 * 60, count: 20 };

/**
 * Options every billing job is enqueued with.
 *
 * **`attempts: 1`, and here it matters more than it does for planning.** The planning jobs are
 * read-only, so a retry would merely be useless; this job WRITES — it raises receivables and
 * assayer payables. A half-finished run that is retried from the beginning would re-walk
 * assignments it has already billed. The database refuses the duplicates outright (see
 * `UQ_billing_entries_root_per_assignment` and `UQ_assayer_payables_fee_per_assignment`), so
 * money cannot actually be double-booked — but a retry would still spend the whole scan
 * collecting constraint violations into the error list, and report a failure that looks like a
 * data problem rather than a re-run. One attempt, and the operator decides.
 *
 * **`timeout`.** Concurrency is 1, so a wedged job holds the only slot and every later request
 * queues behind it forever. Thirty minutes is far beyond any measured run and can only fire on
 * something genuinely stuck.
 */
export const BILLING_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  timeout: 30 * 60_000,
  removeOnComplete: BILLING_COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
