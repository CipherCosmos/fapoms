import { Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { BillingEngineService } from './billing-engine.service';
import { BILLING_JOB, BILLING_QUEUE, SyncAssignmentsJobData } from './billing-jobs.contract';
import { progressReporter } from '../../infrastructure/queue/queued-job';

/**
 * Why the backfill runs one at a time.
 *
 * This processor runs inside the API process — there is no separate worker deployment — so every
 * connection the scan holds is a connection the request handlers are not getting, out of a pool
 * of twenty. Concurrency 1 is what makes "the queue protects the API" true rather than aspirational:
 * however many operators press Sync, at most one scan is walking the book, and the rest wait in
 * Redis where waiting costs nothing.
 *
 * It also removes a class of write race for free. Two concurrent backfills would each try to
 * create the same entries and payables; the database would refuse the losers on the uniqueness
 * constraints, so nothing could be double-booked — but both runs would fill their error lists
 * with each other's work and report a failure that reads like a data problem. Serialising them
 * means that situation cannot arise.
 */
const ONE_AT_A_TIME = 1;

@Processor(BILLING_QUEUE)
export class BillingJobsWorker {
  private readonly logger = new Logger(BillingJobsWorker.name);

  constructor(private readonly billing: BillingEngineService) {}

  /**
   * The named handler MUST match what `BillingJobsService` enqueues — both read
   * `BILLING_JOB.SYNC_ASSIGNMENTS`. A bare `@Process()` here would silently handle nothing,
   * which is precisely the defect that left the 'background-jobs' queue dead.
   */
  @Process({ name: BILLING_JOB.SYNC_ASSIGNMENTS, concurrency: ONE_AT_A_TIME })
  async syncAssignments(job: Job<SyncAssignmentsJobData>) {
    const { requestedBy } = job.data;
    this.logger.log(`Billing sync ${job.id} started for ${requestedBy}.`);

    const result = await this.billing.syncFromAssignments(requestedBy, progressReporter(job));

    this.logger.log(
      `Billing sync ${job.id} finished: scanned ${result.scanned}, ${result.created} receivable(s), ` +
        `${result.payablesCreated} payable(s), ${result.skipped} already settled, ${result.errors.length} error(s).`,
    );
    return result;
  }
}
