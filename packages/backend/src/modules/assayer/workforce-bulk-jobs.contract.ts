/**
 * FAPOMS — bulk actions on the roster, run off the request.
 *
 * "Issue app access" and "Notify" over a roster selection were plain loops inside one HTTP request:
 * per person a record load, a bcrypt hash, a credential write, an audit row, and — until the email
 * queue — an SMTP conversation of several seconds. HR's real batch is the 540-person backlog, which
 * put that request at around half an hour. The web client abandons a request at 30 seconds, so the
 * screen reported a failure while the server carried on rotating passwords, and pressing the button
 * again rotated them a second time and sent everybody a second, different password.
 *
 * Queue name, job names and payloads in one place so the producer (`WorkforceBulkJobsService`) and
 * the consumer (`WorkforceBulkJobsWorker`) cannot drift — see `billing-jobs.contract.ts` for the
 * silent-dead-letter failure that drift causes.
 */

import type { JobOptions, KeepJobsOptions } from 'bull';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';

export const WORKFORCE_BULK_QUEUE = 'workforce-bulk-jobs';

export const WORKFORCE_BULK_JOB = {
  APP_ACCESS: 'app-access',
  NOTIFY: 'notify',
  LIFECYCLE: 'lifecycle',
} as const;

export interface BulkAppAccessJobData extends QueuedJobEnvelope {
  ids: string[];
  actor: JobActor;
}

export interface BulkNotifyJobData extends QueuedJobEnvelope {
  ids: string[];
  subject: string;
  body: string;
  sendEmail: boolean;
  actor: JobActor;
}

/**
 * Moving a selection along the lifecycle. Measured 9–25 ms per hop from `audit_events`; INVITED →
 * ACTIVE is four hops, so the roster's select-all (~1,200 people) took 50–120 s inside one request —
 * past the web client's 30 s, with the same "failed on screen, still running on the server" outcome.
 */
export interface BulkLifecycleJobData extends QueuedJobEnvelope {
  ids: string[];
  targetStatus: string;
  reason?: string;
  actor: JobActor;
}

/** A finished run's buckets are what the operator comes back for; a few hours is plenty. */
const COMPLETED_RETENTION: KeepJobsOptions = { age: 6 * 60 * 60, count: 50 };

/**
 * `attempts: 1`, deliberately. Issuing access WRITES a new password per person and sends it; a
 * retry after a mid-run crash would rotate the first half again and send them a second password.
 * A failed run is reported, and the operator re-runs it knowing what it does.
 *
 * `attempts` does not cover a worker that DIES mid-run — Bull recovers that as a stalled job, on its
 * own counter. The queue is registered with `maxStalledCount: 0` (assayer.module.ts) for that case.
 */
export const WORKFORCE_BULK_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  // 500 people at a bcrypt hash each is minutes, not an hour; this only stops a hang holding the slot.
  timeout: 60 * 60_000,
  removeOnComplete: COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
