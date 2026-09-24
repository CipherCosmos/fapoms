/**
 * FAPOMS — the worker half of a TRACKED run: one on a feature's own Bull queue, recorded on a
 * `background_jobs` row (see `BackgroundJobsService.enqueueTracked` for the request half).
 *
 * ```ts
 * @Process({ name: '*', concurrency: 1 })
 * async run(job: Job<ApprovePayoutsJobData>) {
 *   return this.tracker.run(job, (t) =>
 *     runAsJobActor(job.data.actor, () => this.billing.approvePayouts(ids, userId, t.progress)),
 *   { describe: (r) => ({ summary: `${r.approved.length} approved`, counts: { approved: r.approved.length } }) });
 * }
 * ```
 *
 * What it adds to the handler, and what it leaves alone:
 *
 *  - The row goes RUNNING when the handler starts, carries its progress (throttled — at most about
 *    once a second, or at a stage change, or at the last unit), and ends SUCCEEDED with the small
 *    `describe`d summary, or FAILED with the error's own sentence. Every change is pushed to the
 *    requester's screens (`job:updated`), so the Jobs tray shows it after a refresh.
 *  - The Bull job is untouched: the handler's return value is still Bull's `returnvalue`, an error
 *    is still rethrown for Bull's own retry and failed list, and Bull progress is still written, so
 *    the feature's existing poll route answers exactly what it did before.
 *  - A Bull job queued before tracking existed (no `backgroundJobId`) runs untracked, as it would
 *    have.
 *  - Tracking is advisory. A row write that fails is logged and the work carries on.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';
import type { Readable } from 'stream';
import type { BackgroundJobProgress, BackgroundJobResult } from '@fapoms/shared';
import type { StorageEngine } from '../storage/storage-engine.interface';
import { progressReporter, type ProgressCallback, type QueuedJobEnvelope } from '../queue/queued-job';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobStore } from './background-job.store';
import { BackgroundJobsService } from './background-jobs.service';
import { messageFor, PROGRESS_WRITE_INTERVAL_MS } from './background-job.runner';

/** What a tracked handler is handed. */
export interface TrackedRun {
  /** The row, or null when this run is untracked. */
  backgroundJobId: string | null;
  /** The feature's usual progress hook — written to Bull AND (throttled) to the row. */
  progress: ProgressCallback;
  /** Change the stage label shown on the row now. */
  stage(stage: string, message?: string | null): Promise<void>;
  /**
   * Store a file (an export, a row-level report) as the row's downloadable result, fetched from
   * `GET /jobs/:id/result` — so the Jobs tray can offer it after a refresh. A no-op when untracked.
   */
  attachReport(fileName: string, content: Buffer | Readable, mimeType: string): Promise<void>;
}

export interface TrackOptions<R> {
  /** The small summary the row keeps: a sentence and some counts. Never the payload itself. */
  describe: (result: R) => BackgroundJobResult;
}

@Injectable()
export class BackgroundJobTracker {
  private readonly logger = new Logger(BackgroundJobTracker.name);

  constructor(
    private readonly store: BackgroundJobStore,
    private readonly jobs: BackgroundJobsService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  async run<R>(
    bullJob: Pick<Job, 'data' | 'id' | 'progress' | 'attemptsMade' | 'opts'>,
    work: (run: TrackedRun) => Promise<R>,
    options: TrackOptions<R>,
  ): Promise<R> {
    const bullProgress = progressReporter(bullJob);
    const id = (bullJob.data as Partial<QueuedJobEnvelope> | undefined)?.backgroundJobId ?? null;
    const untracked: TrackedRun = {
      backgroundJobId: null,
      progress: bullProgress,
      stage: async () => undefined,
      attachReport: async () => undefined,
    };
    if (!id) return work(untracked);

    let row: BackgroundJobEntity | null = null;
    try {
      row = await this.store.claim(id, null);
      if (!row) {
        const current = await this.store.findById(id);
        if (current?.status === 'CANCELLED') {
          // Cancelled while it waited, and Bull still handed it over (the removal lost a race).
          throw new Error('This was cancelled before it started.');
        }
      }
    } catch (err) {
      if ((err as Error)?.message === 'This was cancelled before it started.') throw err;
      this.logger.warn(`Could not claim tracked job ${id}; running untracked: ${(err as Error).message}`);
      row = null;
    }
    if (!row) return work(untracked);
    this.jobs.publish(row);

    const claimed: BackgroundJobEntity = row;
    let progress: BackgroundJobProgress = claimed.progress;
    let lastWriteAt = 0;
    const write = async (next: BackgroundJobProgress) => {
      progress = next;
      lastWriteAt = Date.now();
      try {
        if (await this.store.writeProgress(claimed.id, next)) {
          this.jobs.publish({ ...claimed, progress: next, updatedAt: new Date() });
        }
      } catch (err) {
        this.logger.warn(`Progress write for tracked job ${claimed.id} failed: ${(err as Error).message}`);
      }
    };

    const tracked: TrackedRun = {
      backgroundJobId: claimed.id,
      progress: async (done, total, stage) => {
        await bullProgress(done, total, stage);
        const safeTotal = Number.isFinite(total) && total >= 0 ? total : null;
        const processed = Math.max(0, Math.floor(done));
        const next: BackgroundJobProgress = {
          processed,
          total: safeTotal,
          percent: safeTotal ? Math.max(0, Math.min(100, Math.floor((processed / safeTotal) * 100))) : safeTotal === 0 ? 100 : null,
          stage: stage || progress.stage,
          message: progress.message ?? null,
        };
        const due =
          next.stage !== progress.stage ||
          (safeTotal !== null && processed >= safeTotal) ||
          Date.now() - lastWriteAt >= PROGRESS_WRITE_INTERVAL_MS;
        if (due) await write(next);
        else progress = next;
      },
      stage: async (stage, message) => write({ ...progress, stage, message: message ?? null }),
      attachReport: async (fileName, content, mimeType) => {
        try {
          const key = await this.storage.saveFile(fileName, content, mimeType);
          const previous = claimed.resultObjectKey;
          claimed.resultObjectKey = key;
          claimed.resultFileName = fileName;
          claimed.resultMimeType = mimeType;
          await this.store.patch(claimed.id, { resultObjectKey: key, resultFileName: fileName, resultMimeType: mimeType });
          if (previous && previous !== key) await this.storage.deleteFile(previous).catch(() => undefined);
        } catch (err) {
          this.logger.warn(`Could not attach a report to tracked job ${claimed.id}: ${(err as Error).message}`);
        }
      },
    };

    let result: R;
    try {
      result = await work(tracked);
    } catch (err) {
      await this.settleFailure(claimed, bullJob, err, progress);
      throw err;
    }

    let summary: BackgroundJobResult;
    try {
      summary = options.describe(result);
    } catch {
      summary = { summary: 'Done.' };
    }
    try {
      const settled = await this.store.transition(claimed.id, ['RUNNING'], {
        status: 'SUCCEEDED',
        result: summary,
        error: null,
        finishedAt: new Date(),
        progress: { processed: progress.total ?? progress.processed, total: progress.total, percent: 100, stage: 'Done', message: null },
      });
      if (settled) this.jobs.publish(settled);
    } catch (err) {
      this.logger.warn(`Could not record the outcome of tracked job ${claimed.id}: ${(err as Error).message}`);
    }
    return result;
  }

  /**
   * FAILED — unless Bull is going to try again (a queue with `attempts` above one), in which case the
   * row goes back to QUEUED saying so, and the next attempt claims it again.
   */
  private async settleFailure(
    row: BackgroundJobEntity,
    bullJob: Pick<Job, 'attemptsMade' | 'opts'>,
    err: unknown,
    progress: BackgroundJobProgress,
  ): Promise<void> {
    const message = messageFor(err);
    const attempts = bullJob.opts?.attempts ?? 1;
    const willRetry = (bullJob.attemptsMade ?? 0) + 1 < attempts;
    try {
      const next = willRetry
        ? await this.store.transition(row.id, ['RUNNING'], {
            status: 'QUEUED',
            progress: { ...progress, stage: 'Trying again shortly', message },
          })
        : await this.store.transition(row.id, ['RUNNING'], {
            status: 'FAILED',
            error: message,
            finishedAt: new Date(),
            progress: { ...progress, stage: 'Failed' },
          });
      if (next) this.jobs.publish(next);
    } catch (writeErr) {
      this.logger.warn(`Could not record the failure of tracked job ${row.id}: ${(writeErr as Error).message}`);
    }
  }
}
