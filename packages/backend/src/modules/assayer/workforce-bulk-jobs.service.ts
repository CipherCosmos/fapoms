import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { assayerLifecycleLabel, type BackgroundJobKind } from '@fapoms/shared';
import {
  BulkAppAccessJobData,
  BulkLifecycleJobData,
  BulkNotifyJobData,
  WORKFORCE_BULK_JOB,
  WORKFORCE_BULK_JOB_OPTIONS,
  WORKFORCE_BULK_QUEUE,
} from './workforce-bulk-jobs.contract';
import {
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';

export interface EnqueuedBulkJob {
  /** The Bull id — what `GET /assayers/bulk-jobs/:jobId` answers on. */
  jobId: string;
  /** True when an identical run by the same person was already queued or running. */
  deduplicated: boolean;
  /**
   * The `background_jobs` row the run is recorded on, so the Jobs tray (and a refreshed page) can
   * find it. Null when the run could not be recorded (tracking is advisory) or when this press
   * joined a run queued before tracking existed.
   */
  backgroundJobId: string | null;
}

const people = (n: number) => `${n.toLocaleString('en-IN')} ${n === 1 ? 'assayer' : 'assayers'}`;

/**
 * Accepts roster bulk actions for the worker and answers where each run has got to.
 *
 * Every run is TRACKED (`BackgroundJobsService.enqueueTracked`): it stays on this module's own
 * queue — one loop, concurrency 1, `maxStalledCount: 0`, exactly as before — and is also recorded
 * on a `background_jobs` row, so it survives a refresh in the Jobs tray. The dedupe rule is the
 * same one this service used to apply itself: same job name and fingerprint, still waiting, active
 * or delayed, joins the run already going.
 */
@Injectable()
export class WorkforceBulkJobsService {
  constructor(
    @InjectQueue(WORKFORCE_BULK_QUEUE) private readonly queue: Queue,
    private readonly jobs: BackgroundJobsService,
  ) {}

  /**
   * The ids are sorted into the fingerprint, so pressing the button twice — or a page that retries
   * a POST — joins the run already going instead of rotating everybody's password a second time.
   */
  async enqueueAppAccess(ids: string[], actor: JobActor, regions: string[] | null = null): Promise<EnqueuedBulkJob> {
    const sorted = [...new Set(ids)].sort();
    const data: BulkAppAccessJobData = {
      requestedBy: actor.userId,
      ids: sorted,
      actor,
      dedupeKey: dedupeKeyFor(WORKFORCE_BULK_JOB.APP_ACCESS, actor.userId, { ids: sorted }),
    };
    return this.add('WORKFORCE_APP_ACCESS', WORKFORCE_BULK_JOB.APP_ACCESS, data, actor, regions, {
      title: `Issue app access to ${people(sorted.length)}`,
      params: { action: 'app-access', count: sorted.length },
    });
  }

  async enqueueNotify(
    input: { ids: string[]; subject: string; body: string; sendEmail: boolean },
    actor: JobActor,
    regions: string[] | null = null,
  ): Promise<EnqueuedBulkJob> {
    const sorted = [...new Set(input.ids)].sort();
    const params = { ids: sorted, subject: input.subject, body: input.body, sendEmail: input.sendEmail };
    const data: BulkNotifyJobData = {
      requestedBy: actor.userId,
      ...params,
      actor,
      dedupeKey: dedupeKeyFor(WORKFORCE_BULK_JOB.NOTIFY, actor.userId, params),
    };
    return this.add('WORKFORCE_NOTIFY', WORKFORCE_BULK_JOB.NOTIFY, data, actor, regions, {
      title: `Send a message to ${people(sorted.length)}`,
      // Counts only: the message itself stays in the Bull payload, not on the row the tray lists.
      params: { action: 'notify', count: sorted.length, sendEmail: input.sendEmail },
    });
  }

  async enqueueLifecycle(
    input: { ids: string[]; targetStatus: string; reason?: string },
    actor: JobActor,
    regions: string[] | null = null,
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
    return this.add('WORKFORCE_LIFECYCLE', WORKFORCE_BULK_JOB.LIFECYCLE, data, actor, regions, {
      title: `Move ${people(sorted.length)} to ${assayerLifecycleLabel(input.targetStatus)}`,
      params: { action: 'lifecycle', count: sorted.length, targetStatus: input.targetStatus },
    });
  }

  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // The buckets are the deliverable, and they hold ids and reasons only — never a password.
    return describeJob(job, { includeResult: true });
  }

  private async add(
    kind: BackgroundJobKind,
    jobName: string,
    data: QueuedJobEnvelope & { ids: string[] },
    actor: JobActor,
    regions: string[] | null,
    shown: { title: string; params: Record<string, unknown> },
  ): Promise<EnqueuedBulkJob> {
    const { jobId, deduplicated, backgroundJobId } = await this.jobs.enqueueTracked({
      kind,
      actor,
      regions,
      title: shown.title,
      params: shown.params,
      total: data.ids.length,
      queue: this.queue,
      jobName,
      data,
      options: WORKFORCE_BULK_JOB_OPTIONS,
    });
    return { jobId, deduplicated, backgroundJobId };
  }
}
