/**
 * FAPOMS — putting background jobs right after a worker dies.
 *
 * ## The gap this closes
 *
 * The row says RUNNING; the process that was running it is gone (a deploy, an out-of-memory kill, a
 * host reboot). Bull covers part of this: a job whose lock lapses is "stalled" and redelivered once,
 * and the runner then decides — idempotent kinds run again, the rest fail as interrupted. But Bull
 * cannot cover a job it no longer has (Redis restarted without persistence, the job aged out of its
 * lists) or one it gave up on (stalled past its limit, failed outside the handler). Those rows would
 * say RUNNING or QUEUED for ever, and the Jobs tray would spin for ever with them.
 *
 * So, on every job-processing replica, shortly after boot and then every few minutes, this asks Bull
 * about every open row nobody has touched for a while:
 *
 *  - Bull still has it waiting, delayed or active → leave it alone; it is fine.
 *  - Bull has lost it, or holds it as finished/failed:
 *      QUEUED   → queue it again. It never started, so nothing can be doubled.
 *      RUNNING  → an idempotent kind is queued again (it will restart from the top, up to
 *                 `MAX_ATTEMPTS`); any other kind is FAILED "interrupted — please retry".
 *
 * Every write here is a conditional transition, so it cannot overwrite a run that finished while the
 * sweep was looking.
 */

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobRegistry } from './background-job.registry';
import { BackgroundJobStore } from './background-job.store';
import { BackgroundJobsService, INTERRUPTED_MESSAGE } from './background-jobs.service';
import { TRACKED_JOBS_QUEUE } from './background-jobs.contract';

/** First sweep after boot — after Bull's own stalled check has had its chance (30 s). */
export const FIRST_SWEEP_DELAY_MS = 45_000;
export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** A row updated more recently than this is assumed to be in someone's hands. */
export const STALE_AFTER_MS = 60_000;
/** An idempotent kind is restarted at most this many times in total before it is failed. */
export const MAX_ATTEMPTS = 3;

export type RecoveryAction = 'left' | 'requeued' | 'interrupted' | 'settled';

@Injectable()
export class BackgroundJobRecovery implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BackgroundJobRecovery.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly store: BackgroundJobStore,
    private readonly registry: BackgroundJobRegistry,
    private readonly jobs: BackgroundJobsService,
    @InjectQueue(TRACKED_JOBS_QUEUE) private readonly queue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // An api replica runs no jobs, and a sweep there would race the workers for no reason.
    if ((process.env.PROCESS_ROLE || 'all').toLowerCase() === 'api') return;

    const first = setTimeout(() => void this.sweepSafely(), FIRST_SWEEP_DELAY_MS);
    const every = setInterval(() => void this.sweepSafely(), SWEEP_INTERVAL_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private async sweepSafely(): Promise<void> {
    try {
      const actions = await this.sweep();
      const acted = actions.filter((a) => a !== 'left').length;
      if (acted > 0) this.logger.warn(`Recovered ${acted} background job(s) whose worker had gone.`);
    } catch (err) {
      this.logger.error(`Background job recovery sweep failed: ${(err as Error).message}`);
    }
  }

  async sweep(): Promise<RecoveryAction[]> {
    const rows = await this.store.findStaleOpen(STALE_AFTER_MS);
    const actions: RecoveryAction[] = [];
    for (const row of rows) actions.push(await this.reconcile(row));
    return actions;
  }

  async reconcile(row: BackgroundJobEntity): Promise<RecoveryAction> {
    if (row.runnerQueue) return this.reconcileTracked(row);
    const state = await this.bullState(row.bullJobId);
    if (state === 'waiting' || state === 'delayed' || state === 'active' || state === 'paused' || state === 'stuck') {
      // `stuck` can be a healthy job crossing between Bull's lists (see queued-job.ts); the next
      // sweep will see it again if it really is dead, and Bull's stalled check will have acted.
      return 'left';
    }

    if (row.status === 'QUEUED') {
      await this.jobs.enqueue(row, { fresh: true });
      return 'requeued';
    }

    const definition = this.registry.get(row.kind);
    if (definition?.idempotent && row.attempts < MAX_ATTEMPTS) {
      await this.store.patch(row.id, {
        progress: { ...row.progress, stage: 'Restarting after an interruption', message: null },
      });
      await this.jobs.enqueue(row, { fresh: true });
      return 'requeued';
    }

    const failed = await this.store.transition(row.id, ['RUNNING'], {
      status: 'FAILED',
      error: definition?.interruptedMessage ?? INTERRUPTED_MESSAGE,
      finishedAt: new Date(),
      progress: { ...row.progress, stage: 'Interrupted' },
    });
    if (failed) this.jobs.publish(failed);
    return failed ? 'interrupted' : 'left';
  }

  /**
   * A row whose run lives on its FEATURE'S queue (`runner_queue`). It is never re-queued — the
   * foundation has no handler for it, and whether the work may run twice is the feature queue's own
   * rule (its `attempts`, its stalled count), which Bull has already applied. So the row only
   * follows what Bull says became of the job:
   *
   *  - still waiting, delayed, active, paused or stuck → leave it;
   *  - completed → SUCCEEDED (the worker died between finishing and writing the row);
   *  - failed → FAILED with Bull's reason (for a stalled one, the interrupted sentence);
   *  - gone, or a QUEUED row that never got its Bull id → FAILED, interrupted.
   *
   * A queue this process cannot find is "cannot ask", never "gone": the row is left alone.
   */
  private async reconcileTracked(row: BackgroundJobEntity): Promise<RecoveryAction> {
    const queue = this.jobs.queueFor(row);
    if (!queue) return 'left';
    let state = 'missing';
    let failedReason: string | undefined;
    if (row.bullJobId) {
      try {
        const job = await queue.getJob(row.bullJobId);
        if (job) {
          state = await job.getState();
          failedReason = job.failedReason;
        }
      } catch {
        return 'left';
      }
    } else if (Date.now() - new Date(row.createdAt).getTime() < STALE_AFTER_MS * 5) {
      // Written a moment ago and its Bull id not recorded yet — give the request time to finish.
      return 'left';
    }
    if (['waiting', 'delayed', 'active', 'paused', 'stuck'].includes(state)) return 'left';

    const patch =
      state === 'completed'
        ? {
            status: 'SUCCEEDED' as const,
            result: row.result ?? { summary: 'Finished.' },
            error: null,
            progress: { ...row.progress, percent: 100, stage: 'Done', message: null },
          }
        : {
            status: 'FAILED' as const,
            error:
              state === 'failed' && failedReason && !/stalled/i.test(failedReason)
                ? failedReason
                : INTERRUPTED_MESSAGE,
            progress: { ...row.progress, stage: state === 'failed' ? 'Failed' : 'Interrupted' },
          };
    const settled = await this.store.transition(row.id, ['QUEUED', 'RUNNING'], { ...patch, finishedAt: new Date() });
    if (settled) this.jobs.publish(settled);
    if (!settled) return 'left';
    return state === 'completed' ? 'settled' : 'interrupted';
  }

  private async bullState(bullJobId: string | null): Promise<string> {
    if (!bullJobId) return 'missing';
    try {
      const job = await this.queue.getJob(bullJobId);
      if (!job) return 'missing';
      return await job.getState();
    } catch {
      // Cannot ask Bull right now: assume it is fine rather than fail or restart a live job.
      return 'active';
    }
  }
}
