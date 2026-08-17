/**
 * FAPOMS — Report export queue contract.
 *
 * Queue name, job names and payloads for the spreadsheet exports, kept together so the enqueue
 * side and the `@Process` handlers cannot name the same job two different things. See
 * `planning/planning-jobs.contract.ts` for the defect on the shared 'background-jobs' queue that
 * this convention exists to avoid.
 */

import type { JobOptions, KeepJobsOptions } from 'bull';
import type { BillingState } from '@fapoms/shared';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';

/**
 * Its own queue, separate from 'planning-jobs'.
 *
 * The two do different kinds of damage when they run long. A planning job is query-bound: it
 * spends its seconds waiting on Postgres, so the event loop stays responsive. `buildWorkbook` is
 * the opposite — `xlsx.write` is synchronous CPU with no await in it, so while a large workbook
 * serialises *nothing else in the process runs*, health checks included. Keeping them on
 * separate queues means the export cannot sit behind a plan, and, more importantly, that the
 * concurrency ceiling on each can be reasoned about separately.
 */
export const REPORT_QUEUE = 'report-jobs';

export const REPORT_JOB = {
  ASSIGNMENTS: 'assignments',
  BILLING: 'billing',
  COMMAND_CENTER: 'command-center',
  ASSAYER_ROSTER: 'assayer-roster',
} as const;

export type ReportJobName = (typeof REPORT_JOB)[keyof typeof REPORT_JOB];

/**
 * The principal, reduced to what the export actually needs.
 *
 * `assayerRoster` scopes PII by role (`scopeAssayerListForRoles` / `rolesOf`), so the worker
 * needs the caller's roles. It does NOT need the rest of the user record, and putting a whole
 * user entity — name, email, phone, possibly banking columns — into a Redis payload that
 * outlives the request would be storing PII to answer a question about roles. Roles and id only.
 */
export interface PrincipalSnapshot {
  id: string;
  roles: string[];
}

export interface AssignmentsReportJobData extends QueuedJobEnvelope {
  status?: string;
  projectBranchStatus?: string;
  priority?: string;
  scope: Partial<GlobalScope> | null;
}

export interface BillingReportJobData extends QueuedJobEnvelope {
  clientId?: string;
  projectId?: string;
  assayerId?: string;
  state?: BillingState;
}

export interface CommandCenterReportJobData extends QueuedJobEnvelope {
  scope: Partial<GlobalScope> | null;
}

export interface AssayerRosterReportJobData extends QueuedJobEnvelope {
  principal: PrincipalSnapshot;
  scope: Partial<GlobalScope> | null;
}

/**
 * What a finished export job returns.
 *
 * Metadata only — the bytes live under their own Redis key with their own TTL (see
 * `ReportFileStore`). Two reasons the buffer is not the job return value:
 *
 * 1. A poll would carry it. `job.returnvalue` is loaded whenever the job is fetched, so a client
 *    polling every two seconds would drag a twenty-megabyte workbook out of Redis and through
 *    `JSON.stringify` on every tick, to render a progress bar.
 * 2. Bull's `removeOnComplete: { age }` prunes when *later* jobs finish, not on a timer, so on a
 *    quiet queue a completed job — and anything inside it — can outlive its stated age
 *    indefinitely. A key with an `EX` is expired by Redis whether or not anything else happens.
 */
export interface ReportJobResult {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * How long a finished export is kept — job record and file alike.
 *
 * Fifteen minutes is sized for the actual interaction: a client polls, sees `done`, and follows
 * the download link. It is not a place to park a report and come back tomorrow, and it should
 * not become one, because the store is Redis rather than object storage (see `ReportFileStore`).
 *
 * The arithmetic that picks it: exports run at concurrency 1 and take seconds, so the number
 * retained at once is bounded by how many can *complete* inside the window — roughly ninety at
 * ten seconds each. At the observed few-megabytes-per-workbook that is a few hundred megabytes,
 * and at the 20 MB hard cap it would be far more, which is why the cap exists and why the count
 * bound below is deliberately tight as well.
 */
export const REPORT_RESULT_TTL_SECONDS = 15 * 60;

/** Bull's own retention for the (tiny, metadata-only) completed job records. */
export const REPORT_COMPLETED_RETENTION: KeepJobsOptions = {
  age: REPORT_RESULT_TTL_SECONDS,
  count: 100,
};

/**
 * Hard ceiling on a single produced workbook.
 *
 * Not a guess about Excel: it is the size at which putting the bytes in Redis stops being
 * defensible. Above it the job fails with a message telling the operator to narrow the filter,
 * which is a better outcome than an export that succeeds and evicts the RBAC cache. The largest
 * export in normal use — assignments at the 5000-row page cap — is a small number of megabytes.
 *
 * The real fix for genuinely large exports is object storage (`infrastructure/storage`, S3/MinIO)
 * with a pre-signed URL; that directory was outside this change's partition.
 */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

/**
 * Options every export job is enqueued with.
 *
 * **`attempts: 1`.** Exports are read-only, so retrying is safe, but every realistic failure
 * here is deterministic — a filter that matches too much, a client id that does not exist, a
 * workbook over the size cap — and a retry would re-run the same multi-thousand-row hydration to
 * reach the same answer while holding the only slot.
 *
 * **`timeout`.** Ten minutes. Same reasoning as the planning queue: at concurrency 1 a wedged
 * job would otherwise block every later export permanently.
 */
export const REPORT_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  timeout: 10 * 60_000,
  removeOnComplete: REPORT_COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
