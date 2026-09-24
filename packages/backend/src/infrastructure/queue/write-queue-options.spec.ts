import { BILLING_BULK_JOB_OPTIONS } from '../../modules/billing-engine/billing-bulk-jobs.contract';
import { BILLING_JOB_OPTIONS } from '../../modules/billing-engine/billing-jobs.contract';
import { PLANNING_WRITE_JOB_OPTIONS } from '../../modules/planning/planning-write-jobs.contract';
import { WORKFORCE_BULK_JOB_OPTIONS } from '../../modules/assayer/workforce-bulk-jobs.contract';
import { DISPATCH_BATCH_JOB_OPTIONS } from '../../modules/document/document-dispatch-jobs.contract';
import { TRACKED_JOBS_QUEUE_SETTINGS } from '../background-jobs/background-jobs.module';

/**
 * Bull's `timeout` fails a job WITHOUT stopping its handler. On a queue that writes — pays, offers,
 * rotates passwords, emails branches — that let the next run start beside a run still writing, and
 * told the Jobs tray "failed" about work in progress. Overlap is the tracker's advisory lock's job.
 */
describe('non-idempotent write queues carry no Bull timeout', () => {
  it.each([
    ['billing bulk', BILLING_BULK_JOB_OPTIONS],
    ['billing reconcile', BILLING_JOB_OPTIONS],
    ['planning writes', PLANNING_WRITE_JOB_OPTIONS],
    ['workforce bulk', WORKFORCE_BULK_JOB_OPTIONS],
    ['document dispatch batch', DISPATCH_BATCH_JOB_OPTIONS],
  ])('%s', (_name, options) => {
    expect(options.timeout).toBeUndefined();
    expect(options.attempts).toBe(1);
  });

  it('the tracked-jobs queue holds its lock long enough for a synchronous stretch of an import', () => {
    expect(TRACKED_JOBS_QUEUE_SETTINGS.lockDuration).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
