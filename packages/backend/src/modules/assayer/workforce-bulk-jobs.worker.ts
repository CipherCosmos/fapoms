import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { AssayerService } from './assayer.service';
import {
  BulkAppAccessJobData,
  BulkLifecycleJobData,
  BulkNotifyJobData,
  WORKFORCE_BULK_JOB,
  WORKFORCE_BULK_QUEUE,
} from './workforce-bulk-jobs.contract';
import { progressReporter } from '../../infrastructure/queue/queued-job';
import { runAsJobActor } from '../../infrastructure/queue/job-actor';

/**
 * Runs roster bulk actions (see `workforce-bulk-jobs.contract.ts` for why they left the request).
 *
 * ONE loop for the whole queue, dispatching on the job name — not a `@Process` per action.
 *
 * Bull does not reserve slots per job name: each `@Process({ name, concurrency })` adds loops to the
 * queue, and every loop takes the next job of any name. Two named handlers at concurrency 1 were
 * therefore two loops, so two HR users issuing access to overlapping people could rotate the same
 * person's password concurrently, and each queue an email — the earlier one carrying a password that
 * no longer works. A single `'*'` loop makes "one run at a time" true.
 */
@Processor(WORKFORCE_BULK_QUEUE)
export class WorkforceBulkJobsWorker {
  private readonly logger = new Logger(WorkforceBulkJobsWorker.name);

  constructor(private readonly assayers: AssayerService) {}

  @Process({ name: '*', concurrency: 1 })
  async run(job: Job<BulkAppAccessJobData | BulkNotifyJobData | BulkLifecycleJobData>) {
    switch (job.name) {
      case WORKFORCE_BULK_JOB.APP_ACCESS:
        return this.appAccess(job as Job<BulkAppAccessJobData>);
      case WORKFORCE_BULK_JOB.NOTIFY:
        return this.notify(job as Job<BulkNotifyJobData>);
      case WORKFORCE_BULK_JOB.LIFECYCLE:
        return this.lifecycle(job as Job<BulkLifecycleJobData>);
      default:
        // A name nothing here knows would otherwise complete silently with no result.
        throw new Error(`No handler for roster bulk job "${job.name}".`);
    }
  }

  async appAccess(job: Job<BulkAppAccessJobData>) {
    const { ids, actor } = job.data;
    this.logger.log(`App access run ${job.id}: ${ids.length} people.`);
    return runAsJobActor(actor, () =>
      this.assayers.bulkIssueAppAccess(ids, actor.userId, progressReporter(job)));
  }

  async notify(job: Job<BulkNotifyJobData>) {
    const { ids, subject, body, sendEmail, actor } = job.data;
    this.logger.log(`Notify run ${job.id}: ${ids.length} people.`);
    return runAsJobActor(actor, () =>
      this.assayers.bulkNotify(ids, subject, body, sendEmail, actor.userId, progressReporter(job)));
  }

  async lifecycle(job: Job<BulkLifecycleJobData>) {
    const { ids, targetStatus, reason, actor } = job.data;
    this.logger.log(`Lifecycle run ${job.id}: ${ids.length} people to ${targetStatus}.`);
    return runAsJobActor(actor, () =>
      this.assayers.bulkTransitionLifecycle(ids, targetStatus, actor.userId, reason, progressReporter(job)));
  }
}
