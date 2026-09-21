/**
 * FAPOMS — releasing a batch of documents, run off the request.
 *
 * `POST /documents/dispatch-batch` used to dispatch every document inside the request. With a branch
 * address that is, per document, a read and decrypt of the whole PDF from storage and an SMTP
 * conversation carrying it as an attachment: one to three seconds each. Thirty documents passed the
 * web client's 30-second timeout, so the screen reported a failure while the server carried on
 * sending — and pressing Send again emailed the branch the same paperwork a second time.
 *
 * Queue name, job names and payloads live here once so the producer (`DocumentDispatchJobsService`)
 * and the consumer (`DocumentDispatchWorker`) cannot drift apart — see `billing-jobs.contract.ts`
 * for the silent dead-letter that drift causes. Modelled on `workforce-bulk-jobs.contract.ts`.
 *
 * The single-document route (`POST /documents/:id/dispatch`) stays synchronous on purpose: for one
 * document the email IS the answer, and the caller is told it went or did not.
 */

import type { JobOptions, KeepJobsOptions } from 'bull';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';

export const DOCUMENT_DISPATCH_QUEUE = 'document-dispatch';

export const DOCUMENT_DISPATCH_JOB = {
  /** The hourly scan that releases packets due tomorrow (spec §12.6). */
  AUTO_DISPATCH: 'auto-dispatch',
  /** A desk operator's "Send N documents". */
  DISPATCH_BATCH: 'dispatch-batch',
} as const;

export interface DispatchBatchJobData extends QueuedJobEnvelope {
  /** De-duplicated and sorted, so a repeat press in another order fingerprints the same. */
  documentIds: string[];
  /** Email the packets to this bank branch; null tells the assayers to download them instead. */
  branchEmail: string | null;
  actor: JobActor;
}

/** What the batch reports per document — the same shape the synchronous route used to answer. */
export interface DispatchBatchResult {
  dispatched: string[];
  failed: Array<{ documentId: string; reason: string }>;
}

/** The per-document outcome is what the desk comes back for; a few hours is plenty. */
const COMPLETED_RETENTION: KeepJobsOptions = { age: 6 * 60 * 60, count: 50 };

/**
 * `attempts: 1`, deliberately. A batch SENDS: a retry after a failure part-way through would email
 * the branch again. (The status gate in `dispatchDocument` refuses a document that already went, but
 * a mail accepted by the server just before the status write failed has gone and would go again.)
 * A failed run is reported, and the operator decides what to re-send knowing what it does.
 *
 * `attempts` does not cover a worker that DIES mid-run — Bull recovers that as a stalled job, on its
 * own counter. The queue is registered with `maxStalledCount: 0` (document.module.ts) for that case.
 */
export const DISPATCH_BATCH_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  // A hundred documents at a few seconds of SMTP each is minutes; this only stops a hang holding the
  // queue's one slot, which the hourly auto-dispatch also needs.
  timeout: 60 * 60_000,
  removeOnComplete: COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
