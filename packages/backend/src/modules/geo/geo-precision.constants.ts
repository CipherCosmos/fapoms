/**
 * Queue and job names for the coordinate-precision backfill, in their own leaf file.
 *
 * Same reason as `import-job.constants.ts`: the producer (anything that enqueues — the branch
 * importer, the nightly schedule) and the consumer (`GeoPrecisionWorker`) both need these names,
 * and a cycle between them would leave the constant `undefined` at decorator time. That does not
 * fail loudly — `@Processor(undefined)` binds to Bull's default queue — so producer and consumer
 * would sit on two different queues and every job would wait forever.
 */

/** A queue of its own: a precision sweep is slow on purpose (free providers, ~1 lookup/second)
 *  and must not hold up imports or anything else that shares a worker. */
export const GEO_PRECISION_QUEUE = 'geo-precision';

/** Re-resolve a named set of rows — what an import enqueues for the branches it just placed coarsely. */
export const GEO_PRECISION_TARGETED_JOB = 'backfill-ids';

/** The nightly sweep over whatever is still coarse, bounded. */
export const GEO_PRECISION_SWEEP_JOB = 'sweep';

export interface GeoPrecisionTargetedJobData {
  target: 'branch' | 'assayer';
  ids: string[];
  /** For the log line — which import this came from. */
  reason?: string;
}

export interface GeoPrecisionSweepJobData {
  target: 'branch' | 'assayer';
  limit: number;
}
