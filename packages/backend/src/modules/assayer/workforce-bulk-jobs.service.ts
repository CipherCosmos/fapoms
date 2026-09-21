import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import {
  BulkAppAccessJobData,
  BulkLifecycleJobData,
  BulkNotifyJobData,
  WORKFORCE_BULK_JOB,
  WORKFORCE_BULK_JOB_OPTIONS,
  WORKFORCE_BULK_QUEUE,
} from './workforce-bulk-jobs.contract';
import {
  IN_FLIGHT_SCAN_LIMIT,
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';

export interface EnqueuedBulkJob {
  jobId: string;
  /** True when an identical run by the same person was already queued or running. */
  deduplicated: boolean;
}

/** Accepts roster bulk actions for the worker and answers where each run has got to. */
@Injectable()
export class WorkforceBulkJobsService {
  private readonly logger = new Logger(WorkforceBulkJobsService.name);

  constructor(@InjectQueue(WORKFORCE_BULK_QUEUE) private readonly queue: Queue) {}

  /**
   * The ids are sorted into the fingerprint, so pressing the button twice — or a page that retries
   * a POST — joins the run already going instead of rotating everybody's password a second time.
   */
  async enqueueAppAccess(ids: string[], actor: JobActor): Promise<EnqueuedBulkJob> {
    const sorted = [...new Set(ids)].sort();
    const data: BulkAppAccessJobData = {
      requestedBy: actor.userId,
      ids: sorted,
      actor,
      dedupeKey: dedupeKeyFor(WORKFORCE_BULK_JOB.APP_ACCESS, actor.userId, { ids: sorted }),
    };
    return this.add(WORKFORCE_BULK_JOB.APP_ACCESS, data);
  }

  async enqueueNotify(
    input: { ids: string[]; subject: string; body: string; sendEmail: boolean },
    actor: JobActor,
  ): Promise<EnqueuedBulkJob> {
    const sorted = [...new Set(input.ids)].sort();
    const params = { ids: sorted, subject: input.subject, body: input.body, sendEmail: input.sendEmail };
    const data: BulkNotifyJobData = {
      requestedBy: actor.userId,
      ...params,
      actor,
      dedupeKey: dedupeKeyFor(WORKFORCE_BULK_JOB.NOTIFY, actor.userId, params),
    };
    return this.add(WORKFORCE_BULK_JOB.NOTIFY, data);
  }

  async enqueueLifecycle(
    input: { ids: string[]; targetStatus: string; reason?: string },
    actor: JobActor,
  ): Promise<EnqueuedBulkJob> {
    const sorted = [...new Set(input.ids)].sort();
    const params = { ids: sorted, targetStatus: input.targetStatus, reason: input.reason ?? null };
    const data: BulkLifecycleJobData = {
      requestedBy: actor.userId,
      ids: sorted,
      targetStatus: input.targetStatus,
      reason: input.reason,
      actor,
      dedupeKey: dedupeKeyFor(WORKFORCE_BULK_JOB.LIFECYCLE, actor.userId, params),
    };
    return this.add(WORKFORCE_BULK_JOB.LIFECYCLE, data);
  }

  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // The buckets are the deliverable, and they hold ids and reasons only — never a password.
    return describeJob(job, { includeResult: true });
  }

  private async add(name: string, data: QueuedJobEnvelope): Promise<EnqueuedBulkJob> {
    const inFlight = await this.findInFlight(name, data.dedupeKey);
    if (inFlight) {
      this.logger.log(`Joining in-flight ${name} run ${inFlight.id} rather than starting a duplicate.`);
      return { jobId: String(inFlight.id), deduplicated: true };
    }
    const job = await this.queue.add(name, data, WORKFORCE_BULK_JOB_OPTIONS);
    this.logger.log(`Queued roster ${name} run ${job.id}.`);
    return { jobId: String(job.id), deduplicated: false };
  }

  private async findInFlight(name: string, dedupeKey: string): Promise<Job | null> {
    try {
      const jobs = await this.queue.getJobs(['waiting', 'active', 'delayed'], 0, IN_FLIGHT_SCAN_LIMIT);
      return jobs.find(
        (j) => j?.name === name && (j.data as Partial<QueuedJobEnvelope> | undefined)?.dedupeKey === dedupeKey,
      ) ?? null;
    } catch (err) {
      this.logger.warn(`Could not scan for an in-flight ${name} run (${(err as Error).message}); queuing anyway.`);
      return null;
    }
  }
}
