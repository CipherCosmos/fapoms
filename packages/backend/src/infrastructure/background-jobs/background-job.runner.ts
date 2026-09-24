/**
 * FAPOMS — running one background job, in the worker.
 *
 * Kept out of the `@Processor` class so the whole lifecycle — claim, context, progress, cancel,
 * finish — can be driven from a test without Bull.
 *
 * ## What happens, in order
 *
 *  1. Read the row. Gone, finished or cancelled while it waited → nothing to do.
 *  2. The row is already RUNNING → its previous worker died mid-run (Bull redelivered a stalled job).
 *     An idempotent kind runs again from the top; any other is FAILED "interrupted — please retry",
 *     because running half a non-idempotent import twice is how duplicates are made.
 *  3. Claim it (QUEUED/RUNNING → RUNNING). A kind that runs one-at-a-time and finds its slot taken
 *     is put back on the queue with a short delay, visibly waiting.
 *  4. Run the handler inside the requester's request context (`runAsJobActor`), with a context that
 *     throttles progress writes, answers "was I cancelled?" cheaply, and stores reports.
 *  5. Finish: SUCCEEDED / AWAITING_REVIEW with the result, CANCELLED with whatever it managed, or
 *     FAILED with a message written for a person. Every finishing write names RUNNING as the only
 *     status it may leave from, so it can never overwrite what the recovery sweep decided.
 *
 * The Bull job itself always completes normally: the outcome lives on the row. Rethrowing would only
 * duplicate the failure into Bull's own failed list for the dead-letter monitor to report twice.
 */

import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { Readable } from 'stream';
import { QueryFailedError } from 'typeorm';
import {
  backgroundJobLabel,
  type BackgroundJobProgress,
  type BackgroundJobResult,
} from '@fapoms/shared';
import type { StorageEngine } from '../storage/storage-engine.interface';
import { runAsJobActor } from '../queue/job-actor';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobRegistry } from './background-job.registry';
import { BackgroundJobStore, ExclusiveSlotBusyError } from './background-job.store';
import { BackgroundJobsService, INTERRUPTED_MESSAGE } from './background-jobs.service';
import {
  BackgroundJobCancelledError,
  type BackgroundJobDefinition,
  type RunContext,
  type RunOutcome,
  type TrackedJobData,
} from './background-jobs.contract';

/** Progress is written at most this often, unless the stage changes or the last unit is done. */
export const PROGRESS_WRITE_INTERVAL_MS = 1_000;
/** The cancel flag is re-read at most this often. */
export const CANCEL_CHECK_INTERVAL_MS = 2_000;
/** How long a one-at-a-time job waits before asking for its slot again. */
export const EXCLUSIVE_RETRY_DELAY_MS = 5_000;
/** `result` above this many bytes of JSON has its `details` moved into a downloadable file. */
export const MAX_RESULT_JSON_BYTES = 64 * 1024;

export type RunnerVerdict = 'missing' | 'skipped' | 'deferred' | 'interrupted' | 'SUCCEEDED' | 'AWAITING_REVIEW' | 'CANCELLED' | 'FAILED';

@Injectable()
export class BackgroundJobRunner {
  private readonly logger = new Logger(BackgroundJobRunner.name);

  constructor(
    private readonly store: BackgroundJobStore,
    private readonly registry: BackgroundJobRegistry,
    private readonly jobs: BackgroundJobsService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  async run(bullJob: Pick<Job<TrackedJobData>, 'data' | 'id'>): Promise<RunnerVerdict> {
    const id = bullJob.data?.backgroundJobId;
    const row = id ? await this.store.findById(id) : null;
    if (!row) {
      this.logger.warn(`Bull job ${bullJob.id} names background job ${id ?? '(none)'}, which does not exist.`);
      return 'missing';
    }
    if (row.status !== 'QUEUED' && row.status !== 'RUNNING') return 'skipped';

    // A deferred or restarted row is carried by a newer Bull job; an older copy must not run it too.
    if (row.bullJobId && bullJob.id !== undefined && String(bullJob.id) !== row.bullJobId) return 'skipped';

    const definition = this.registry.get(row.kind);
    if (!definition) {
      return this.fail(row, `This server does not know how to run "${backgroundJobLabel(row.kind)}" jobs any more.`);
    }

    if (row.status === 'RUNNING' && !definition.idempotent) {
      await this.fail(row, definition.interruptedMessage ?? INTERRUPTED_MESSAGE);
      return 'interrupted';
    }

    let claimed: BackgroundJobEntity | null;
    try {
      claimed = await this.store.claim(row.id, exclusiveKeyFor(definition, row));
    } catch (err) {
      if (err instanceof ExclusiveSlotBusyError) return this.defer(row);
      throw err;
    }
    if (!claimed) return 'skipped';

    if (claimed.attempts > 1) {
      claimed.progress = { ...claimed.progress, stage: 'Restarting after an interruption', message: null };
      await this.store.writeProgress(claimed.id, claimed.progress);
    }
    this.jobs.publish(claimed);

    const context = this.contextFor(claimed);
    try {
      const outcome = await runAsJobActor(claimed.actor, () => definition.run(context.ctx));
      return await this.finish(claimed, outcome, context.lastProgress());
    } catch (err) {
      if (err instanceof BackgroundJobCancelledError) {
        return this.settle(claimed, 'CANCELLED', {
          result: err.partial ?? null,
          progress: { ...context.lastProgress(), stage: 'Cancelled', message: null },
        });
      }
      this.logger.error(`Background job ${claimed.id} (${claimed.kind}) failed: ${(err as Error)?.stack ?? err}`);
      return this.fail(claimed, messageFor(err), context.lastProgress());
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────

  private contextFor(row: BackgroundJobEntity) {
    let progress: BackgroundJobProgress = row.progress;
    let lastWriteAt = 0;
    let lastCancelCheckAt = 0;
    let cancelled = !!row.cancelRequestedAt;

    const write = async (next: BackgroundJobProgress) => {
      progress = next;
      lastWriteAt = Date.now();
      try {
        const written = await this.store.writeProgress(row.id, next);
        if (written) this.jobs.publish({ ...row, progress: next, updatedAt: new Date() });
      } catch (err) {
        // Advisory only — a failed progress write must never fail the work it describes.
        this.logger.warn(`Progress write for ${row.id} failed: ${(err as Error).message}`);
      }
    };

    const isCancelRequested = async (): Promise<boolean> => {
      if (cancelled) return true;
      if (Date.now() - lastCancelCheckAt < CANCEL_CHECK_INTERVAL_MS) return false;
      lastCancelCheckAt = Date.now();
      try {
        cancelled = !!(await this.store.cancelRequestedAt(row.id));
      } catch {
        // Unknown is not cancelled; the next check will ask again.
      }
      return cancelled;
    };

    const readInput = async (): Promise<Readable> => {
      if (!row.inputObjectKey) throw new Error('This job has no uploaded file.');
      return this.storage.getFileStream(row.inputObjectKey);
    };

    const ctx: RunContext<any> = {
      job: this.jobs.toSummary(row),
      kind: row.kind,
      params: row.params ?? {},
      actor: row.actor,
      regions: row.regions,
      scope: row.scopeType ? { type: row.scopeType, id: row.scopeId } : null,
      attempt: row.attempts,
      openInput: readInput,
      readInput: async () => streamToBuffer(await readInput()),
      inputFiles: (row.inputObjects ?? []).map((o, index) => ({
        index,
        fileName: o.fileName,
        mimeType: o.mimeType,
        size: o.size,
        sha256: o.sha256,
        open: () => this.storage.getFileStream(o.key),
        read: async () => streamToBuffer(await this.storage.getFileStream(o.key)),
      })),
      progress: async (processed, total, stage, message) => {
        const nextStage = stage ?? progress.stage;
        const safeTotal = typeof total === 'number' && total >= 0 ? total : null;
        const safeProcessed = Math.max(0, Math.floor(processed));
        const next: BackgroundJobProgress = {
          processed: safeProcessed,
          total: safeTotal,
          percent: safeTotal ? Math.max(0, Math.min(100, Math.floor((safeProcessed / safeTotal) * 100))) : safeTotal === 0 ? 100 : null,
          stage: nextStage,
          message: message === undefined ? progress.message ?? null : message,
        };
        const due =
          nextStage !== progress.stage ||
          (safeTotal !== null && safeProcessed >= safeTotal) ||
          Date.now() - lastWriteAt >= PROGRESS_WRITE_INTERVAL_MS;
        if (due) await write(next);
        else progress = next;
      },
      stage: async (stage, message) => write({ ...progress, stage, message: message ?? null }),
      throwIfCancelled: async () => {
        if (await isCancelRequested()) throw new BackgroundJobCancelledError();
      },
      isCancelRequested,
      attachReport: async (fileName, content, mimeType) => {
        const key = await this.storage.saveFile(fileName, content, mimeType);
        const previous = row.resultObjectKey;
        row.resultObjectKey = key;
        row.resultFileName = fileName;
        row.resultMimeType = mimeType;
        await this.store.patch(row.id, { resultObjectKey: key, resultFileName: fileName, resultMimeType: mimeType });
        if (previous && previous !== key) {
          await this.storage.deleteFile(previous).catch(() => undefined);
        }
      },
    };
    return { ctx, lastProgress: () => progress };
  }

  private async finish(row: BackgroundJobEntity, outcome: RunOutcome, progress: BackgroundJobProgress): Promise<RunnerVerdict> {
    if (!outcome || (outcome.status !== 'SUCCEEDED' && outcome.status !== 'AWAITING_REVIEW') || !outcome.result) {
      return this.fail(row, 'The job finished without saying what it did.', progress);
    }
    const result = await this.boundedResult(row, outcome.result);
    const finalProgress: BackgroundJobProgress =
      outcome.status === 'SUCCEEDED'
        ? {
            processed: progress.total ?? progress.processed,
            total: progress.total,
            percent: 100,
            stage: 'Done',
            message: null,
          }
        : { ...progress, stage: 'Waiting for your review', message: null };
    return this.settle(row, outcome.status, { result, progress: finalProgress });
  }

  /** A result too big to travel on every update keeps its sentence and counts; the rest becomes a file. */
  private async boundedResult(row: BackgroundJobEntity, result: BackgroundJobResult): Promise<BackgroundJobResult> {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size <= MAX_RESULT_JSON_BYTES) return result;
    this.logger.warn(`Background job ${row.id} returned a ${size}-byte result; moving its details into a file.`);
    if (result.details !== undefined && !row.resultObjectKey) {
      const key = await this.storage.saveFile('details.json', Buffer.from(JSON.stringify(result.details, null, 2)), 'application/json');
      await this.store.patch(row.id, { resultObjectKey: key, resultFileName: 'details.json', resultMimeType: 'application/json' });
    }
    return { summary: result.summary.slice(0, 2_000), counts: result.counts };
  }

  private async settle(
    row: BackgroundJobEntity,
    status: 'SUCCEEDED' | 'AWAITING_REVIEW' | 'CANCELLED',
    patch: { result: BackgroundJobResult | null; progress: BackgroundJobProgress },
  ): Promise<RunnerVerdict> {
    const settled = await this.store.transition(row.id, ['RUNNING'], {
      status,
      result: patch.result,
      progress: patch.progress,
      error: null,
      finishedAt: new Date(),
    });
    if (!settled) {
      this.logger.warn(`Background job ${row.id} was no longer RUNNING when it finished as ${status}; left as it was.`);
      return 'skipped';
    }
    this.jobs.publish(settled);
    return status;
  }

  private async fail(row: BackgroundJobEntity, error: string, progress?: BackgroundJobProgress): Promise<RunnerVerdict> {
    const failed = await this.store.transition(row.id, ['QUEUED', 'RUNNING'], {
      status: 'FAILED',
      error,
      finishedAt: new Date(),
      progress: { ...(progress ?? row.progress), stage: 'Failed' },
    });
    if (failed) this.jobs.publish(failed);
    return 'FAILED';
  }

  private async defer(row: BackgroundJobEntity): Promise<RunnerVerdict> {
    const label = backgroundJobLabel(row.kind).toLowerCase();
    const waiting: BackgroundJobProgress = { ...row.progress, stage: `Waiting for another ${label} to finish` };
    await this.store.patch(row.id, { progress: waiting });
    await this.jobs.enqueue(row, { delayMs: EXCLUSIVE_RETRY_DELAY_MS, fresh: true });
    const fresh = await this.store.findById(row.id);
    if (fresh) this.jobs.publish(fresh);
    return 'deferred';
  }
}

/** Which RUNNING rows this one may not run beside. */
export function exclusiveKeyFor(
  definition: Pick<BackgroundJobDefinition<any>, 'exclusive'>,
  row: Pick<BackgroundJobEntity, 'kind' | 'scopeType' | 'scopeId'>,
): string | null {
  switch (definition.exclusive) {
    case 'kind':
      return row.kind;
    case 'scope':
      return `${row.kind}|${row.scopeType ?? '-'}|${row.scopeId ?? '-'}`;
    default:
      return null;
  }
}

/**
 * The sentence a person reads when a job fails.
 *
 * What a handler throws on purpose (an HttpException, a plain Error with a sentence) is shown as
 * written. A database error is not: its message quotes SQL and constraint names, which is noise to
 * a clerk and a map of the schema to anyone else.
 */
export function messageFor(err: unknown): string {
  if (err instanceof QueryFailedError) {
    return 'The job stopped because of a database error. Please try again; if it happens again, report it.';
  }
  if (err instanceof HttpException) {
    const response = err.getResponse() as string | { message?: string | string[] };
    const message = typeof response === 'string' ? response : response?.message;
    return clip(Array.isArray(message) ? message[0] : message ?? err.message);
  }
  if (err instanceof Error && err.message) return clip(err.message);
  return 'The job failed without saying why.';
}

function clip(s: string): string {
  const trimmed = (s ?? '').trim() || 'The job failed without saying why.';
  return trimmed.length > 1_000 ? `${trimmed.slice(0, 999)}…` : trimmed;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
