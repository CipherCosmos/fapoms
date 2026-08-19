import { Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { BillingEngineService } from './billing-engine.service';
import { BILLING_JOB, BILLING_QUEUE, ReconcileJobData } from './billing-jobs.contract';
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
}
