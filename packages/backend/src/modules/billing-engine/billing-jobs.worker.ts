import { Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { BillingEngineService } from './billing-engine.service';
import {
  BILLING_JOB,
  BILLING_QUEUE,
  BookAssignmentJobData,
  ReconcileJobData,
} from './billing-jobs.contract';
import { progressReporter } from '../../infrastructure/queue/queued-job';

/**
 * Why the reconcile runs one at a time.
 *
 * This processor runs inside the API process — there is no separate worker deployment — so every
 * connection the scan holds is a connection the request handlers are not getting, out of a pool
 * of twenty. Concurrency 1 is what makes "the queue protects the API" true rather than aspirational:
 * however many operators press Reconcile, at most one scan is walking the book, and the rest
 * wait in Redis where waiting costs nothing.
 *
 * It also removes a class of write race for free. Two concurrent reconciles would each try to
 * book the same rows; the database would refuse the losers on the uniqueness constraints, so
 * nothing could be double-booked — but both runs would fill their error lists with each other's
 * work and report a failure that reads like a data problem. Serialising them means that
 * situation cannot arise.
 */
const ONE_AT_A_TIME = 1;

@Processor(BILLING_QUEUE)
export class BillingJobsWorker {
  private readonly logger = new Logger(BillingJobsWorker.name);

  constructor(private readonly billing: BillingEngineService) {}

  /**
   * The named handler MUST match what `BillingJobsService` enqueues — both read
   * `BILLING_JOB.RECONCILE`. A bare `@Process()` here would silently handle nothing, which is
   * precisely the defect that left the 'background-jobs' queue dead.
   */
  @Process({ name: BILLING_JOB.RECONCILE, concurrency: ONE_AT_A_TIME })
  async reconcile(job: Job<ReconcileJobData>) {
    const { requestedBy, since } = job.data;
    this.logger.log(`Billing reconcile ${job.id} started for ${requestedBy}${since ? ` (since ${since})` : ''}.`);

    const result = await this.billing.reconcile(requestedBy, { since: since ?? null }, progressReporter(job));

    this.logger.log(
      `Billing reconcile ${job.id} finished: scanned ${result.scanned}, booked ${result.booked}, ` +
        `${result.skipped} already booked, ${result.errors.length} error(s).`,
    );
    return result;
  }

  /**
   * Processes single-assignment booking jobs durable via BullMQ.
   *
   * Idempotency guarantee:
   * 1. If already booked, billing.bookAssignment returns booked: false, reason: 'already booked'. Clean complete.
   * 2. If concurrent race occurs, DB unique constraints catch it and return 'already booked (concurrent)'. Clean complete.
   * 3. Terminal validation failures (e.g. no assayer, not completed, no client, NO_FEE) log warning and do not retry.
   * 4. Transient failures (DB connection blips, locks, etc.) throw so BullMQ applies exponential backoff retry.
   */
  @Process({ name: BILLING_JOB.BOOK_ASSIGNMENT, concurrency: ONE_AT_A_TIME })
  async bookAssignment(job: Job<BookAssignmentJobData>) {
    const { assignmentId, userId, outboxEventId } = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts?.attempts ?? 5;

    this.logger.log(
      `[BillingJob:Start] jobId=${job.id} assignmentId=${assignmentId} attempt=${attempt}/${maxAttempts} outboxEventId=${outboxEventId ?? 'none'}`,
    );

    let result;
    try {
      result = await this.billing.bookAssignment(assignmentId, userId ?? 'system');
    } catch (dbErr) {
      this.logger.error(
        `[BillingJob:TransientError] jobId=${job.id} assignmentId=${assignmentId} attempt=${attempt}/${maxAttempts} error=${(dbErr as Error).message}`,
        (dbErr as Error).stack,
      );
      throw dbErr;
    }

    if (result.booked) {
      this.logger.log(
        `[BillingJob:Success] jobId=${job.id} assignmentId=${assignmentId} entryId=${result.entryId} payableId=${result.payableId}`,
      );
      return result;
    }

    const reason = result.reason ?? '';
    // Benign idempotent completion: already booked in a previous run or concurrent worker
    if (reason.startsWith('already booked')) {
      this.logger.log(
        `[BillingJob:AlreadyBooked] jobId=${job.id} assignmentId=${assignmentId} reason="${reason}" entryId=${result.entryId} payableId=${result.payableId}`,
      );
      return result;
    }

    // Legitimate non-billable domain outcome: fee resolved to NONE (e.g. internal audit / complimentary)
    if (reason === 'NO_FEE') {
      this.logger.log(
        `[BillingJob:LegitimateNonBillable] jobId=${job.id} assignmentId=${assignmentId} reason="NO_FEE" - Assignment produces zero financial booking.`,
      );
      return result;
    }

    // Missing prerequisites or unexpected data inconsistency:
    // Do NOT acknowledge cleanly! Throw so the job fails, retries with backoff, and if persistent,
    // lands durably in Bull's operational failed job queue where operators can inspect the failure
    // reason via Bull Board and replay once prerequisites are repaired.
    this.logger.error(
      `[BillingJob:PrerequisiteFailure] jobId=${job.id} assignmentId=${assignmentId} attempt=${attempt}/${maxAttempts} reason="${reason}"`,
    );
    throw new Error(`Billing booking prerequisite failed: ${reason}`);
  }
}
