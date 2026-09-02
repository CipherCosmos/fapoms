import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { MetricsService } from '../observability/metrics.service';

// Kept in step with ALL_QUEUE_NAMES in main.ts. Duplicated deliberately rather than imported,
// so this file does not pull in the bootstrap module.
const QUEUE_NAMES = [
  'background-jobs',
  'ocr',
  'sla-scanner',
  'document-dispatch',
  'notification-delivery',
  // The outbox relay was missing, so a relay job that exhausted its retries — meaning domain
  // events had stopped being recovered — dead-lettered with nothing watching.
  'outbox',
];

/** A job is dead-lettered once it has used up every configured attempt. */
export function isExhausted(attemptsMade: number | undefined, maxAttempts: number | undefined): boolean {
  return (attemptsMade ?? 0) >= (maxAttempts ?? 1);
}

/**
 * Surfaces dead-letter jobs.
 *
 * A job that exhausts its retries used to fail in silence: nothing logged or alerted, so a
 * persistently failing OCR / dispatch / notification job simply vanished from view (assessment
 * §8, P3). This attaches a `failed` listener to every queue and, only once a job has used up all
 * its attempts, logs a structured dead-letter line and increments `jobs_failed_total` so the
 * failure is both greppable and alertable.
 *
 * It watches the live `failed` event, so it does not depend on the dead job being *kept* in
 * Redis — which matters, because failed-job retention is bounded on every queue now
 * (`FAILED_JOB_RETENTION` in queued-job.ts). An earlier version of this comment asserted the
 * opposite, that `removeOnFail: false` leaves the job in Redis for good; that is no longer true
 * anywhere and was never what this monitor relied on.
 *
 * Runs only on job-processing replicas (`PROCESS_ROLE !== 'api'`): Bull delivers `failed` events
 * to every listener across the cluster, and an API replica does not process jobs — without this
 * gate each dead job would be logged once per replica.
 */
@Injectable()
export class JobFailureMonitor implements OnModuleInit {
  private readonly logger = new Logger('JobFailureMonitor');

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if ((process.env.PROCESS_ROLE || 'all').toLowerCase() === 'api') return;

    for (const name of QUEUE_NAMES) {
      let queue: Queue | undefined;
      try {
        queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      } catch {
        continue; // queue not registered in this deployment — skip, never fatal
      }
      if (!queue) continue;

      queue.on('failed', (job: Job, err: Error) => {
        if (!isExhausted(job?.attemptsMade, job?.opts?.attempts)) return; // will retry — not dead yet
        this.metrics.jobsFailed.inc({ queue: name, job: job?.name ?? 'unknown' });
        this.logger.error(
          `[dead-letter] queue=${name} job=${job?.name} id=${job?.id} attempts=${job?.attemptsMade} error=${err?.message}`,
        );
      });

      queue.on('error', (err: Error) => {
        this.logger.error(`queue=${name} error: ${err?.message}`);
      });
    }
  }
}
