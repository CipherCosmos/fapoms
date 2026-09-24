import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import type { BackgroundJobKind } from '@fapoms/shared';
import {
  ApprovePayoutsJobData,
  BILLING_BULK_JOB,
  BILLING_BULK_JOB_OPTIONS,
  BILLING_BULK_QUEUE,
  InviteAllAssayerInvoicesJobData,
  PayPayoutsJobData,
} from './billing-bulk-jobs.contract';
import {
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';

export interface EnqueuedBillingBulkJob {
  jobId: string;
  /** True when an identical run by the same person was already queued or running. */
  deduplicated: boolean;
  /**
   * The `background_jobs` row that tracks the run, so the Jobs tray (and a refreshed Payouts tab)
   * find it again. Null for a run joined that was queued before tracking, or when the row could
   * not be written — the run itself is queued either way.
   */
  backgroundJobId: string | null;
}

/** How the run is shown in the Jobs tray. Never a bank account, never the payload. */
interface TrackedAs {
  kind: BackgroundJobKind;
  title: string;
  params: Record<string, unknown>;
  total: number | null;
  regions: string[] | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Accepts billing bulk writes for the worker and answers where each run has got to.
 *
 * Every check that can refuse a request — validation, the region ceiling, the rollout gate —
 * stays in the controller, before anything reaches here, so a refusal is still an immediate
 * 400/403/404 with nothing queued.
 */
@Injectable()
export class BillingBulkJobsService {
  constructor(
    @InjectQueue(BILLING_BULK_QUEUE) private readonly queue: Queue,
    private readonly jobs: BackgroundJobsService,
  ) {}

  /**
   * The ids are de-duplicated and sorted into the fingerprint, so a double click — or a page that
   * retries a POST — joins the run already going instead of queueing the same approvals twice.
   */
  async enqueueApprovePayouts(
    payableIds: string[],
    actor: JobActor,
    reason?: string,
    regions: string[] | null = null,
  ): Promise<EnqueuedBillingBulkJob> {
    const sorted = [...new Set(payableIds)].sort();
    const data: ApprovePayoutsJobData = {
      requestedBy: actor.userId,
      payableIds: sorted,
      actor,
      reason,
      // The reason is NOT in the fingerprint: the same payouts approved twice is the same
      // instruction whatever note came with the second press, and swallowing the repeat is the
      // whole point of the key.
      dedupeKey: dedupeKeyFor(BILLING_BULK_JOB.APPROVE_PAYOUTS, actor.userId, { payableIds: sorted }),
    };
    return this.add(BILLING_BULK_JOB.APPROVE_PAYOUTS, data, {
      kind: 'BILLING_APPROVE_PAYOUTS',
      title: `Approve ${plural(sorted.length, 'payout')}`,
      params: { payouts: sorted.length, withoutBill: !!reason },
      total: sorted.length,
      regions,
    });
  }

  /**
   * The payment details are part of the fingerprint: the same payouts paid under a different bank
   * reference is a different instruction, not a repeat press to be swallowed.
   */
  async enqueuePayPayouts(
    payableIds: string[],
    payment: PayPayoutsJobData['payment'],
    actor: JobActor,
    regions: string[] | null = null,
  ): Promise<EnqueuedBillingBulkJob> {
    const sorted = [...new Set(payableIds)].sort();
    const normalised = {
      paymentReference: payment.paymentReference,
      method: payment.method,
      paidDate: payment.paidDate,
      notes: payment.notes,
    };
    const data: PayPayoutsJobData = {
      requestedBy: actor.userId,
      payableIds: sorted,
      payment: normalised,
      actor,
      dedupeKey: dedupeKeyFor(BILLING_BULK_JOB.PAY_PAYOUTS, actor.userId, { payableIds: sorted, ...normalised }),
    };
    return this.add(BILLING_BULK_JOB.PAY_PAYOUTS, data, {
      kind: 'BILLING_PAY_PAYOUTS',
      // The bank reference (UTR) is what the desk searches its statement for — never an account number.
      title: `Pay ${plural(sorted.length, 'payout')} (ref ${normalised.paymentReference})`,
      params: { payouts: sorted.length, method: normalised.method, paidDate: normalised.paidDate ?? null },
      total: sorted.length,
      regions,
    });
  }

  /** Keyed on the requester and their region ceiling — the round has no other input. */
  async enqueueInviteAllAssayerInvoices(
    scope: Partial<GlobalScope> | undefined,
    actor: JobActor,
    regions: string[] | null = null,
  ): Promise<EnqueuedBillingBulkJob> {
    const snapshot = scope ?? null;
    const data: InviteAllAssayerInvoicesJobData = {
      requestedBy: actor.userId,
      scope: snapshot,
      actor,
      dedupeKey: dedupeKeyFor(BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES, actor.userId, { scope: snapshot }),
    };
    return this.add(BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES, data, {
      kind: 'BILLING_INVITE_ALL_INVOICES',
      title: 'Invite every assayer with unbilled work to submit a bill',
      params: {},
      // Who is invited is decided when the round RUNS, so the count is not known yet.
      total: null,
      regions,
    });
  }

  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // The done/refused lists and the per-assayer outcomes ARE the deliverable, so they ride the poll.
    return describeJob(job, { includeResult: true });
  }

  /**
   * The duplicate rule is `enqueueTracked`'s, which is this queue's old one exactly: same job name
   * and `dedupeKey`, among waiting/active/delayed runs only — joining a completed run would hand a
   * later press the earlier run's answer. A failed scan never blocks the enqueue.
   */
  private async add(name: string, data: QueuedJobEnvelope & { actor: JobActor }, as: TrackedAs): Promise<EnqueuedBillingBulkJob> {
    return this.jobs.enqueueTracked({
      kind: as.kind,
      actor: data.actor,
      regions: as.regions,
      title: as.title,
      params: as.params,
      total: as.total,
      queue: this.queue,
      jobName: name,
      data,
      options: BILLING_BULK_JOB_OPTIONS,
    });
  }
}
