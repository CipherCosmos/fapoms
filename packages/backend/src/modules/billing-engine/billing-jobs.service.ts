import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import {
  BILLING_JOB,
  BILLING_JOB_OPTIONS,
  BILLING_QUEUE,
  SyncAssignmentsJobData,
} from './billing-jobs.contract';
import {
  IN_FLIGHT_SCAN_LIMIT,
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';

/** What a POST returns: the id to poll, and whether it joined a run already in flight. */
export interface EnqueueBillingJobResult {
  jobId: string;
  /**
   * True when this account already had an identical request queued or running and this call
   * joined it instead of starting a second copy.
   *
   * It matters more here than on a read-only queue. Two concurrent backfills would each walk the
   * same assignments and race to create the same entries; the database would refuse the losers,
   * so nothing is double-booked, but both runs would report errors for work the other did.
   * Joining the run in flight is how "I pressed Sync twice" stays a non-event.
   */
  deduplicated: boolean;
}

@Injectable()
export class BillingJobsService {
  private readonly logger = new Logger(BillingJobsService.name);

  constructor(@InjectQueue(BILLING_QUEUE) private readonly queue: Queue) {}

  /**
   * Queue a full backfill of billable assignments.
   *
   * The dedupe fingerprint is the job name plus the requesting user — the backfill takes no
   * parameters, so two requests from the same account are always the same request.
   */
  async enqueueSyncAssignments(requestedBy: string): Promise<EnqueueBillingJobResult> {
    const data: SyncAssignmentsJobData = {
      requestedBy,
      dedupeKey: dedupeKeyFor(BILLING_JOB.SYNC_ASSIGNMENTS, requestedBy, {}),
    };

    const inFlight = await this.findInFlight(BILLING_JOB.SYNC_ASSIGNMENTS, data.dedupeKey);
    if (inFlight) {
      this.logger.log(`Joining in-flight billing sync ${inFlight.id} rather than starting a duplicate.`);
      return { jobId: String(inFlight.id), deduplicated: true };
    }

    const job = await this.queue.add(BILLING_JOB.SYNC_ASSIGNMENTS, data, BILLING_JOB_OPTIONS);
    this.logger.log(`Enqueued billing sync ${job.id}.`);
    return { jobId: String(job.id), deduplicated: false };
  }

  /**
   * Poll one job. `userId` is required — see `assertJobVisibleTo` for why a mismatched caller
   * gets a 404 rather than someone else's billing summary.
   */
  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // The summary IS the deliverable here — counts and the error list are what the operator
    // came back for — so it rides the poll response.
    return describeJob(job, { includeResult: true });
  }

  /**
   * Finds an identical request that has not finished yet.
   *
   * Unfinished states only. Matching a completed job would mean that for the whole retention
   * window every press of Sync returned the previous run's counts, so an operator who had since
   * completed ten audits would be told there was nothing to bill.
   *
   * A failure here never blocks the enqueue: the scan is an optimisation whose worst outcome is
   * one redundant run, while refusing the work because a list read failed would turn a Redis
   * hiccup into an outage of the endpoint.
   */
  private async findInFlight(name: string, dedupeKey: string): Promise<Job | null> {
    try {
      const jobs = await this.queue.getJobs(['waiting', 'active', 'delayed'], 0, IN_FLIGHT_SCAN_LIMIT);
      return (
        jobs.find(
          (j) => j?.name === name && (j.data as Partial<QueuedJobEnvelope> | undefined)?.dedupeKey === dedupeKey,
        ) ?? null
      );
    } catch (err) {
      this.logger.warn(`Could not scan for an in-flight billing sync (${(err as Error).message}); enqueuing anyway.`);
      return null;
    }
  }
}
