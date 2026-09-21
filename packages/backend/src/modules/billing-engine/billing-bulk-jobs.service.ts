import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import {
  ApprovePayoutsJobData,
  BILLING_BULK_JOB,
  BILLING_BULK_JOB_OPTIONS,
  BILLING_BULK_QUEUE,
  InviteAllAssayerInvoicesJobData,
  PayPayoutsJobData,
} from './billing-bulk-jobs.contract';
import {
  IN_FLIGHT_SCAN_LIMIT,
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';

export interface EnqueuedBillingBulkJob {
  jobId: string;
  /** True when an identical run by the same person was already queued or running. */
  deduplicated: boolean;
}

/**
 * Accepts billing bulk writes for the worker and answers where each run has got to.
 *
 * Every check that can refuse a request — validation, the region ceiling, the rollout gate —
 * stays in the controller, before anything reaches here, so a refusal is still an immediate
 * 400/403/404 with nothing queued.
 */
@Injectable()
export class BillingBulkJobsService {
  private readonly logger = new Logger(BillingBulkJobsService.name);

  constructor(@InjectQueue(BILLING_BULK_QUEUE) private readonly queue: Queue) {}

  /**
   * The ids are de-duplicated and sorted into the fingerprint, so a double click — or a page that
   * retries a POST — joins the run already going instead of queueing the same approvals twice.
   */
  async enqueueApprovePayouts(payableIds: string[], actor: JobActor, reason?: string): Promise<EnqueuedBillingBulkJob> {
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
    return this.add(BILLING_BULK_JOB.APPROVE_PAYOUTS, data);
  }

  /**
   * The payment details are part of the fingerprint: the same payouts paid under a different bank
   * reference is a different instruction, not a repeat press to be swallowed.
   */
  async enqueuePayPayouts(
    payableIds: string[],
    payment: PayPayoutsJobData['payment'],
    actor: JobActor,
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
    return this.add(BILLING_BULK_JOB.PAY_PAYOUTS, data);
  }

  /** Keyed on the requester and their region ceiling — the round has no other input. */
  async enqueueInviteAllAssayerInvoices(
    scope: Partial<GlobalScope> | undefined,
    actor: JobActor,
  ): Promise<EnqueuedBillingBulkJob> {
    const snapshot = scope ?? null;
    const data: InviteAllAssayerInvoicesJobData = {
      requestedBy: actor.userId,
      scope: snapshot,
      actor,
      dedupeKey: dedupeKeyFor(BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES, actor.userId, { scope: snapshot }),
    };
    return this.add(BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES, data);
  }

  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // The done/refused lists and the per-assayer outcomes ARE the deliverable, so they ride the poll.
    return describeJob(job, { includeResult: true });
  }

  private async add(name: string, data: QueuedJobEnvelope): Promise<EnqueuedBillingBulkJob> {
    const inFlight = await this.findInFlight(name, data.dedupeKey);
    if (inFlight) {
      this.logger.log(`Joining in-flight billing ${name} run ${inFlight.id} rather than starting a duplicate.`);
      return { jobId: String(inFlight.id), deduplicated: true };
    }
    const job = await this.queue.add(name, data, BILLING_BULK_JOB_OPTIONS);
    this.logger.log(`Queued billing ${name} run ${job.id}.`);
    return { jobId: String(job.id), deduplicated: false };
  }

  /**
   * Unfinished runs only — joining a completed one would hand a later press the earlier run's
   * answer. A failed scan never blocks the enqueue: its worst outcome is one redundant run, whose
   * per-row writes are no-ops the second time.
   */
  private async findInFlight(name: string, dedupeKey: string): Promise<Job | null> {
    try {
      const jobs = await this.queue.getJobs(['waiting', 'active', 'delayed'], 0, IN_FLIGHT_SCAN_LIMIT);
      return jobs.find(
        (j) => j?.name === name && (j.data as Partial<QueuedJobEnvelope> | undefined)?.dedupeKey === dedupeKey,
      ) ?? null;
    } catch (err) {
      this.logger.warn(`Could not scan for an in-flight billing ${name} run (${(err as Error).message}); queuing anyway.`);
      return null;
    }
  }
}
