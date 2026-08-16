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
 * Bull runs with `removeOnFail: false`, so a job that exhausts its retries stays in Redis — but
 * nothing logged or alerted, so a persistently failing OCR / dispatch / notification job simply
 * vanished from view (assessment §8, P3). This attaches a `failed` listener to every queue and,
 * only once a job has used up all its attempts, logs a structured dead-letter line and increments
 * `jobs_failed_total` so the failure is both greppable and alertable.
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
