import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import {
  DOCUMENT_DISPATCH_JOB,
  DOCUMENT_DISPATCH_QUEUE,
  DISPATCH_BATCH_JOB_OPTIONS,
  DispatchBatchJobData,
  DispatchBatchResult,
} from './document-dispatch-jobs.contract';
import {
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';

export const DOCUMENT_DISPATCH_KIND = 'DOCUMENT_DISPATCH' as const;

export interface EnqueuedDispatchBatch {
  jobId: string;
  /** True when an identical batch by the same person was already queued or running. */
  deduplicated: boolean;
  /** The `background_jobs` row that tracks it (the Jobs tray), or null when untracked. */
  backgroundJobId: string | null;
}

/**
 * Accepts a desk's batch dispatch for the worker and answers where it has got to.
 *
 * The batch stays on its own `document-dispatch` queue — its one loop is what makes "one dispatch
 * at a time" true (see `DocumentDispatchWorker`) — and is TRACKED on a `background_jobs` row
 * (`enqueueTracked`), so the Jobs tray shows it after a refresh. The Bull id is still the answer,
 * so `GET /documents/dispatch-batch/:jobId` and the page's poll keep working unchanged.
 */
@Injectable()
export class DocumentDispatchJobsService {
  constructor(
    @InjectQueue(DOCUMENT_DISPATCH_QUEUE) private readonly queue: Queue,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  /**
   * The ids are sorted into the fingerprint and the address is part of it, so pressing Send twice —
   * or a page that retries a POST — joins the batch already going instead of emailing the branch a
   * second copy. A different address is a different batch: it is a different delivery.
   *
   * The fingerprint is a courtesy, not the last line. Two presses that race past the in-flight scan
   * both enqueue, but the queue has one processing loop, so the second batch runs after the first
   * and `dispatchDocument` refuses every document the first already moved out of UPLOADED.
   */
  async enqueueBatch(
    input: { documentIds: string[]; branchEmail?: string | null },
    actor: JobActor,
    regions: string[] | null = null,
  ): Promise<EnqueuedDispatchBatch> {
    const documentIds = [...new Set(input.documentIds)].sort();
    const branchEmail = (input.branchEmail ?? '').trim() || null;
    const params = { documentIds, branchEmail };
    const data: DispatchBatchJobData = {
      requestedBy: actor.userId,
      ...params,
      actor,
      dedupeKey: dedupeKeyFor(DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH, actor.userId, params),
    };

    const count = documentIds.length;
    return this.backgroundJobs.enqueueTracked({
      kind: DOCUMENT_DISPATCH_KIND,
      actor,
      regions,
      title: `Send ${count} document${count === 1 ? '' : 's'}${branchEmail ? ` to ${branchEmail}` : ' to their assayers'}`,
      // Displayable facts only — never the id list.
      params: { documentCount: count, branchEmail },
      total: count,
      queue: this.queue,
      jobName: DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH,
      data,
      options: DISPATCH_BATCH_JOB_OPTIONS,
    });
  }

  /**
   * Readable only by whoever started the batch. Bull's job ids are a counter shared with the hourly
   * auto-dispatch, so the name is checked too: an auto-dispatch job carries no requester and is
   * nobody's to read, and nothing else on this queue answers as a batch.
   */
  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus<DispatchBatchResult>> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    if (job.name !== DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH) assertJobVisibleTo(null, userId);
    // The per-document outcome is the deliverable: ids and reasons, never file contents.
    return describeJob<DispatchBatchResult>(job, { includeResult: true });
  }
}
