import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { TRACKED_JOBS_QUEUE, type TrackedJobData } from './background-jobs.contract';
import { BackgroundJobRunner } from './background-job.runner';

/**
 * Wakes a `BackgroundJobRunner` for each tracked job (see `background-job.runner.ts` for what a run
 * does, and `background-jobs.service.ts` for how one is started).
 *
 * ONE `'*'` loop at concurrency 2, dispatching on nothing: every kind goes through the same runner,
 * which finds the kind's handler in the registry. Bull's loops belong to the queue, so a named
 * handler per kind would only have added shared loops, not per-kind lanes. "One at a time" for a
 * kind that needs it is enforced on the row instead (`exclusive`, a unique index over RUNNING rows),
 * which holds across every worker replica rather than inside one process.
 *
 * Two slots so one long import (a 5,000-branch file geocoding at a polite one lookup a second) does
 * not hold every other upload behind it. Each slot holds a database connection only for the
 * statements its handler makes; see `WORKER_CONCURRENCY.trackedJobs`.
 */
@Processor(TRACKED_JOBS_QUEUE)
export class BackgroundJobsWorker {
  constructor(private readonly runner: BackgroundJobRunner) {}

  @Process({ name: '*', concurrency: 2 })
  async run(job: Job<TrackedJobData>) {
    return this.runner.run(job);
  }
}
