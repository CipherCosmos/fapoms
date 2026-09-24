/**
 * FAPOMS — billing bulk writes, run off the request.
 *
 * Approving a selection of payouts, paying one, and the "invite every assayer with unbilled work"
 * round were loops inside one HTTP request. Approve and pay are one transaction per payable — a
 * row lock, the assayer's bank and PAN re-read, the segregation-of-duties check, a history row and
 * an audit row — and the round is one transaction per assayer plus a notification, for roughly
 * 1,200 assayers at today's roster. The web client abandons a request at 30 s, so at realistic
 * sizes the screen reported a failure while the server carried on writing, and a second press
 * started the same writes again.
 *
 * Queue name, job names and payloads in one place so the producer (`BillingBulkJobsService`) and
 * the consumer (`BillingBulkJobsWorker`) cannot drift — see `billing-jobs.contract.ts` for the
 * silent-dead-letter failure that drift causes.
 */

import type { JobOptions, KeepJobsOptions } from 'bull';
import type { FinalApprovalRef, PaymentMethod } from '@fapoms/shared';
import { FAILED_JOB_RETENTION, QueuedJobEnvelope } from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';

/**
 * Its own queue, NOT `billing-jobs`.
 *
 * Bull's worker loops belong to a queue and pop the next job of ANY name (bull 4.16.5
 * `Queue.prototype.run` → `getNextJob`). A handler for these added to `billing-jobs` would share
 * loops with `reconcile` and `book-assignment`: two payout runs could then be active at once, and
 * a 1,200-assayer round would sit in the slot completion booking needs.
 */
export const BILLING_BULK_QUEUE = 'billing-bulk-jobs';

export const BILLING_BULK_JOB = {
  APPROVE_PAYOUTS: 'approve-payouts',
  PAY_PAYOUTS: 'pay-payouts',
  INVITE_ALL_ASSAYER_INVOICES: 'invite-all-assayer-invoices',
  /** The HOD's bulk final approval (2026-09-24) — bills, payouts and client invoices, mixed. */
  FINAL_APPROVE: 'final-approve',
} as const;

/**
 * The most payouts one approve or pay run takes. `PayoutIdsDto` refuses more in the request; the
 * web never gets near it, because the payouts table acts on the rows on screen — 20 a page, and
 * the server pages at most 100 (`BILLING_PAGE_MAX`).
 */
export const BILLING_BULK_MAX_PAYOUTS = 500;

export interface ApprovePayoutsJobData extends QueuedJobEnvelope {
  payableIds: string[];
  actor: JobActor;
  /** Why the assayer's confirmation was skipped, when it was. See `PayoutIdsDto.reason`. */
  reason?: string;
}

/** The items the HOD ticked, each named by kind — see `FinalApprovalService.approveMany`. */
export interface FinalApproveJobData extends QueuedJobEnvelope {
  items: FinalApprovalRef[];
  actor: JobActor;
}

export interface PayPayoutsJobData extends QueuedJobEnvelope {
  payableIds: string[];
  payment: { paymentReference: string; method: PaymentMethod; paidDate?: string; notes?: string };
  actor: JobActor;
}

/**
 * The round computes who to invite when it RUNS, not when it is pressed — an assayer whose work
 * completed while the run waited is included, and one whose payables were held meanwhile is not.
 * What it must not do is widen: the requester's region ceiling is resolved in the request and
 * carried here, so a region desk's round still means everyone THAT desk can see.
 */
export interface InviteAllAssayerInvoicesJobData extends QueuedJobEnvelope {
  scope: Partial<GlobalScope> | null;
  actor: JobActor;
}

/**
 * A finished run's result is what the waiting screen collects, seconds after it completes; six
 * hours covers a tab left open over lunch. The round's result is the largest — one outcome per
 * assayer, about 150 bytes each, so ~180 KB at 1,200 assayers — and twenty of those is under
 * 4 MB of Redis. Both bounds apply together.
 */
const COMPLETED_RETENTION: KeepJobsOptions = { age: 6 * 60 * 60, count: 20 };

/**
 * `attempts: 1`, deliberately. Every job here WRITES money state or starts an assayer's money
 * reveal and sends notifications; a retry after a mid-run failure would walk the batch again from
 * the top. The per-row writes are idempotent enough that nothing would be double-paid (an approved
 * payable is a no-op, a payment is keyed on its bank reference, an active invoice blocks a second),
 * but the re-run would resend nothing useful and report a run's worth of refusals for its own work.
 * A failed run is reported, and the operator re-runs it knowing what it does.
 *
 * `attempts` does not cover a worker that DIES mid-run — Bull recovers that as a stalled job, on
 * its own counter. The queue is registered with `maxStalledCount: 0` (billing-engine.module.ts).
 *
 * No `timeout` — see the note inside the options below.
 */
export const BILLING_BULK_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  /*
    No `timeout`, deliberately. Bull's timeout fails the job but does NOT stop the handler: the
    write carried on while the queue's loop started the next run beside it, and the Jobs tray read
    "failed" for work that was still happening. Overlap is prevented by the Postgres advisory lock
    `BackgroundJobTracker` holds per queue for the whole run (released by Postgres if the worker
    dies); a genuinely wedged run is a stalled job, which `maxStalledCount` and the recovery sweep
    handle.
  */
  removeOnComplete: COMPLETED_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
};
