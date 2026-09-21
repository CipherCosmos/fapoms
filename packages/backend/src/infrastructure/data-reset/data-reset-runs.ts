/**
 * FAPOMS — Data-reset runs: the wipe is accepted, then watched.
 *
 * ## Why this exists
 *
 * `POST /admin/data-reset/execute` used to do everything inside the request: an optional `pg_dump`
 * (allowed five minutes, see backup-on-demand.service.ts) and then the multi-table wipe. The web
 * client stops waiting at 180 s. On a database with real volume the screen therefore said "Wipe
 * failed" while the server carried on and deleted everything — the one screen in the app where
 * a false "failed" invites the worst possible next move.
 *
 * So execute now answers 202 with a job id at once, and the developer's screen polls
 * `GET /admin/data-reset/runs/:jobId` in the same `QueuedJobStatus` shape every other accepted job
 * uses (infrastructure/queue/queued-job.ts), so the web's one `waitForQueuedJob` loop reads it.
 *
 * ## Why in-process, not a Bull queue
 *
 * Deliberately NOT the queue those other jobs use. A Bull job would move the wipe onto the worker
 * replica, and Bull re-runs a job whose worker died holding its lock ("stalled"): a destructive
 * action retried by a machine, minutes later, with no human watching. It would also persist the
 * keep-list and the typed confirmation into Redis, and add a processor to the worker's concurrency
 * table for an action that happens a handful of times in the life of a deployment. The API already
 * ran this work with its own runtime credentials (it holds no admin DB credentials — see
 * deploy/docker-compose.prod.yml), so running it in the same process, just not inside the request,
 * changes nothing about who can do what.
 *
 * ## What it does not change
 *
 * Nothing about the two-person rule or the audit trail. The work handed to `start()` is exactly
 * what the controller used to await: the backup, then `DataResetService.execute` with the
 * approval consumed inside the wipe's own transaction and the unguarded audit write beside it.
 * The one addition is a refusal: the same developer cannot start a second run of the same request
 * while one is still going in this process. That is earlier and stricter than the database's own
 * guard (one APPROVED → EXECUTED flip), which still decides everything across processes.
 *
 * ## Known limits, said out loud
 *
 * State lives in this process's memory. A restart mid-run loses the record (the wipe's transaction
 * rolls back with the connection unless it had already committed), and a second API replica would
 * not know a run the first one started. Either way the poll answers 404, the web stops waiting with
 * an "outcome unknown — check the request's status" message, and the request row is the truth:
 * EXECUTED means the wipe committed, still APPROVED means nothing was deleted.
 */

import {
  BeforeApplicationShutdown,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { QueuedJobStatus } from '../queue/queued-job';
import type { ExecuteResult } from './data-reset.service';

/** What the developer's spinner says. Shown verbatim by the web (followed by an ellipsis). */
export type DataResetRunStage = 'Taking a backup first' | 'Wiping';

/** Who started a run, and which approved request it spends. */
export interface DataResetRunOwner {
  requestId: string;
  requestedBy: string;
}

/**
 * How long a finished run stays readable. The screen reads it within seconds of finishing; an hour
 * covers a laptop that slept through the end of a long backup. Runs are human-gated and rare, so
 * the map never holds more than a handful of entries.
 */
export const DATA_RESET_RUN_RETENTION_MS = 60 * 60_000;

/**
 * How long shutdown waits for an in-flight wipe. Kept under the container's 60 s stop grace period
 * so the rest of the shutdown hooks still run before SIGKILL. The request-scoped version had this
 * property for free: the HTTP server's close waited for the open request before the database pool
 * was torn down.
 */
export const DATA_RESET_SHUTDOWN_WAIT_MS = 45_000;

/**
 * Said when a run fails with something other than a deliberate refusal. Not the raw error: a
 * driver message names tables and internals, and the full error is in the server log. It does not
 * claim "nothing was deleted", because a commit whose acknowledgement was lost is the one case
 * where that would be false. It sends the reader to the request's status, which is the fact.
 */
export const DATA_RESET_RUN_UNEXPECTED_FAILURE =
  'The wipe stopped on the server without a reason it could report. It runs as a single transaction, ' +
  "so either all of it or none of it was applied — check this request's status: Executed means it " +
  'went through, still Approved means nothing was deleted.';

interface RunRecord extends DataResetRunOwner {
  jobId: string;
  state: 'running' | 'done' | 'failed';
  stage: DataResetRunStage;
  result?: ExecuteResult;
  error?: string;
  startedAt: number;
  finishedAt: number | null;
  settled: Promise<void>;
}

@Injectable()
export class DataResetRuns implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DataResetRuns.name);
  private readonly runs = new Map<string, RunRecord>();

  /**
   * Starts `work` without awaiting it and returns the id to poll. Never rejects for a failure of
   * the work itself: that is recorded on the run and reported by `describe()`.
   */
  start(
    owner: DataResetRunOwner,
    initialStage: DataResetRunStage,
    work: (setStage: (stage: DataResetRunStage) => void) => Promise<ExecuteResult>,
  ): { jobId: string; deduplicated: false } {
    this.prune();

    const inFlight = [...this.runs.values()].find(
      (r) => r.state === 'running' && r.requestId === owner.requestId && r.requestedBy === owner.requestedBy,
    );
    if (inFlight) {
      throw new ConflictException(
        'A wipe for this request is already running. Wait for it to finish; this screen shows the outcome when it does.',
      );
    }

    const record: RunRecord = {
      ...owner,
      jobId: randomUUID(),
      state: 'running',
      stage: initialStage,
      startedAt: Date.now(),
      finishedAt: null,
      settled: Promise.resolve(),
    };
    this.runs.set(record.jobId, record);

    // `.then(ok, fail)` on a promise that cannot itself throw synchronously: `work` is wrapped in
    // an async arrow so a synchronous throw inside it lands in `fail` too, and neither handler
    // throws, so no rejection can escape unhandled and take the process down.
    record.settled = (async () => work((stage) => { record.stage = stage; }))().then(
      (result) => {
        record.state = 'done';
        record.result = result;
        record.finishedAt = Date.now();
      },
      (error: unknown) => {
        record.state = 'failed';
        record.error = operatorMessage(error);
        record.finishedAt = Date.now();
        if (!(error instanceof HttpException)) {
          this.logger.error(
            `Data-reset run ${record.jobId} (request ${record.requestId}) failed: ${(error as Error)?.message}`,
            (error as Error)?.stack,
          );
        }
      },
    );

    return { jobId: record.jobId, deduplicated: false };
  }

  /**
   * The poll answer, for the developer who started the run and nobody else. 404 with the same
   * words whether the id is unknown or someone else's, so the answer confirms nothing about which
   * ids exist (the rule `assertJobVisibleTo` holds for queued jobs).
   */
  describe(jobId: string, userId: string | undefined): QueuedJobStatus<ExecuteResult> {
    this.prune();
    const run = this.runs.get(jobId);
    if (!run || !userId || run.requestedBy !== userId) {
      throw new NotFoundException(
        "No such wipe run on this server. It may have finished more than an hour ago, or the server restarted while it ran — check the request's status: Executed means the wipe went through, still Approved means nothing was deleted.",
      );
    }

    const status: QueuedJobStatus<ExecuteResult> = {
      jobId: run.jobId,
      state: run.state,
      progress:
        run.state === 'done'
          ? { percent: 100, stage: 'Complete' }
          : { percent: 0, stage: run.state === 'failed' ? 'Failed' : run.stage },
      enqueuedAt: new Date(run.startedAt).toISOString(),
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
    };
    if (run.state === 'done') status.result = run.result;
    if (run.state === 'failed') status.error = run.error;
    return status;
  }

  /** Lets an in-flight wipe finish before the database pool closes under it — bounded, see above. */
  async beforeApplicationShutdown(): Promise<void> {
    const running = [...this.runs.values()].filter((r) => r.state === 'running');
    if (running.length === 0) return;
    this.logger.warn(`Waiting up to ${DATA_RESET_SHUTDOWN_WAIT_MS} ms for ${running.length} data-reset run(s) to finish.`);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(running.map((r) => r.settled)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, DATA_RESET_SHUTDOWN_WAIT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private prune(): void {
    const cutoff = Date.now() - DATA_RESET_RUN_RETENTION_MS;
    for (const [id, run] of this.runs) {
      if (run.finishedAt !== null && run.finishedAt < cutoff) this.runs.delete(id);
    }
  }
}

/**
 * A deliberate refusal (every guard in the wipe path throws an HttpException written for the
 * operator: approval expired, selection drifted, backup failed, conflicts) is reported in its own
 * words. Anything else gets the fixed message above.
 */
function operatorMessage(error: unknown): string {
  if (!(error instanceof HttpException)) return DATA_RESET_RUN_UNEXPECTED_FAILURE;
  const body = error.getResponse();
  if (typeof body === 'string' && body.trim()) return body;
  const message = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(message) && message.length > 0) return message.join('; ');
  if (typeof message === 'string' && message.trim()) return message;
  return error.message;
}
