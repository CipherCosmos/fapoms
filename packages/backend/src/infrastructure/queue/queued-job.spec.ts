import { NotFoundException } from '@nestjs/common';
import type { Job } from 'bull';
import {
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
  progressReporter,
  FAILED_JOB_RETENTION,
} from './queued-job';

/**
 * A Bull job stub. Only the fields `describeJob` reads are present; anything the tests do not
 * set is deliberately absent so a field being read that should not be shows up as undefined
 * rather than as a plausible-looking default.
 */
function jobStub(overrides: Partial<Record<string, any>> = {}): Job {
  return {
    id: 7,
    name: 'coverage-plan',
    data: { requestedBy: 'user-1', dedupeKey: 'k' },
    timestamp: 1_700_000_000_000,
    processedOn: null,
    finishedOn: null,
    returnvalue: null,
    failedReason: undefined,
    progress: jest.fn().mockReturnValue(0),
    getState: jest.fn().mockResolvedValue('waiting'),
    ...overrides,
  } as unknown as Job;
}

describe('queued-job', () => {
  describe('dedupeKeyFor', () => {
    it('gives the same fingerprint whatever order the payload keys arrive in', () => {
      // The whole point: the same request reaching the enqueue through two code paths must
      // collapse onto one job, and JSON.stringify preserves insertion order.
      const a = dedupeKeyFor('coverage-plan', 'u1', { projectId: 'p1', scope: { state: 'MH', regions: null } });
      const b = dedupeKeyFor('coverage-plan', 'u1', { scope: { regions: null, state: 'MH' }, projectId: 'p1' });
      expect(a).toBe(b);
    });

    it('separates two users asking for the same thing', () => {
      // Scope is already in the payload, but keying on the requester too means a scoping bug
      // can never become a cross-user leak through a shared job.
      const a = dedupeKeyFor('coverage-plan', 'u1', { projectId: 'p1' });
      const b = dedupeKeyFor('coverage-plan', 'u2', { projectId: 'p1' });
      expect(a).not.toBe(b);
    });

    it('separates different scopes for the same user and project', () => {
      const west = dedupeKeyFor('coverage-plan', 'u1', { projectId: 'p1', scope: { regions: ['WEST'] } });
      const all = dedupeKeyFor('coverage-plan', 'u1', { projectId: 'p1', scope: { regions: null } });
      expect(west).not.toBe(all);
    });

    it('treats an absent optional and an explicit undefined as the same request', () => {
      // `{ targetDate: undefined }` is what a controller produces from a missing query param;
      // it must not fingerprint differently from a payload that omits the key.
      const a = dedupeKeyFor('day-plans', 'u1', { projectIds: ['p1'], targetDate: undefined });
      const b = dedupeKeyFor('day-plans', 'u1', { projectIds: ['p1'] });
      expect(a).toBe(b);
    });
  });

  describe('progressReporter', () => {
    it('writes percent and a counted stage label', async () => {
      const job = jobStub({ progress: jest.fn().mockResolvedValue(undefined) });
      await progressReporter(job)(50, 200, 'Scoring branches');

      expect(job.progress).toHaveBeenCalledWith({ percent: 25, stage: 'Scoring branches (50/200)' });
    });

    it('suppresses writes that would not change what the poller sees', async () => {
      // 200 branches move a bar through at most 100 integers, so half the per-branch calls are
      // Redis round trips that render identically. This is what keeps that cost off the loop.
      const job = jobStub({ progress: jest.fn().mockResolvedValue(undefined) });
      const report = progressReporter(job);

      for (let i = 1; i <= 200; i++) await report(i, 200, 'Scoring branches');

      expect((job.progress as jest.Mock).mock.calls.length).toBeLessThanOrEqual(100);
      // Rounding means 100% is first written at branch 199 and branch 200 is then suppressed, so
      // the last label lags by one item. Nobody ever sees that: `describeJob` reports a completed
      // job as { percent: 100, stage: 'Complete' } regardless of the last write.
      expect((job.progress as jest.Mock).mock.calls.at(-1)![0].percent).toBe(100);
    });

    it('drops the counter when there is only one unit of work', async () => {
      // "(1/1)" on an opening phase reads as a countdown that is already over.
      const job = jobStub({ progress: jest.fn().mockResolvedValue(undefined) });
      await progressReporter(job)(0, 1, 'Loading project and workforce');

      expect(job.progress).toHaveBeenCalledWith({ percent: 0, stage: 'Loading project and workforce' });
    });

    it('never lets a failed progress write abort the work', async () => {
      // A Redis blip mid-plan must not throw away six seconds of completed scoring in order to
      // fail at updating a progress bar.
      const job = jobStub({ progress: jest.fn().mockRejectedValue(new Error('Redis is down')) });
      await expect(progressReporter(job)(1, 10, 'Scoring branches')).resolves.toBeUndefined();
    });

    it('clamps a done count that overshoots its total', async () => {
      const job = jobStub({ progress: jest.fn().mockResolvedValue(undefined) });
      await progressReporter(job)(12, 10, 'Scoring branches');

      expect(job.progress).toHaveBeenCalledWith({ percent: 100, stage: 'Scoring branches (10/10)' });
    });
  });

  describe('describeJob', () => {
    it('collapses waiting, delayed and paused onto "queued"', async () => {
      for (const raw of ['waiting', 'delayed', 'paused']) {
        const status = await describeJob(jobStub({ getState: jest.fn().mockResolvedValue(raw) }));
        expect(status.state).toBe('queued');
      }
    });

    it('reports an active job as running with its last written progress', async () => {
      const status = await describeJob(
        jobStub({
          getState: jest.fn().mockResolvedValue('active'),
          progress: jest.fn().mockReturnValue({ percent: 37, stage: 'Scoring branches (74/200)' }),
          processedOn: 1_700_000_005_000,
        }),
      );

      expect(status.state).toBe('running');
      expect(status.progress).toEqual({ percent: 37, stage: 'Scoring branches (74/200)' });
      expect(status.startedAt).toBe(new Date(1_700_000_005_000).toISOString());
    });

    it('forces a completed job to 100 percent whatever its last progress write said', async () => {
      // The final progress write happens before the last chunk of work, so a finished plan would
      // otherwise be reported as still at 99%.
      const status = await describeJob(
        jobStub({
          getState: jest.fn().mockResolvedValue('completed'),
          progress: jest.fn().mockReturnValue({ percent: 99, stage: 'Scoring branches (199/200)' }),
          returnvalue: { coveragePercentage: 88 },
          finishedOn: 1_700_000_012_000,
        }),
      );

      expect(status.state).toBe('done');
      expect(status.progress).toEqual({ percent: 100, stage: 'Complete' });
      expect(status.result).toEqual({ coveragePercentage: 88 });
      expect(status.finishedAt).toBe(new Date(1_700_000_012_000).toISOString());
    });

    it('omits the result when the caller asked for metadata only', async () => {
      // The report queue polls this way: its result is a twenty-megabyte workbook and a client
      // polling every two seconds must not drag it across the wire on every tick.
      const status = await describeJob(
        jobStub({ getState: jest.fn().mockResolvedValue('completed'), returnvalue: { huge: true } }),
        { includeResult: false },
      );

      expect(status.state).toBe('done');
      expect(status.result).toBeUndefined();
    });

    it('surfaces the failure message and never a stack trace', async () => {
      const status = await describeJob(
        jobStub({
          getState: jest.fn().mockResolvedValue('failed'),
          failedReason: '  Project 123 not found.  ',
          stacktrace: ['at CoveragePlanningEngine.generateCoveragePlan (/srv/app/dist/…)'],
        }),
      );

      expect(status.state).toBe('failed');
      expect(status.error).toBe('Project 123 not found.');
      expect(JSON.stringify(status)).not.toContain('/srv/app');
    });

    it('gives a failed job with no reason something an operator can act on', async () => {
      const status = await describeJob(
        jobStub({ getState: jest.fn().mockResolvedValue('failed'), failedReason: undefined }),
      );
      expect(status.error).toBe('The job failed without reporting a reason.');
    });

    it('terminates the polling loop on a stuck job rather than reporting it as running', async () => {
      // Bull reports `stuck` for a job whose worker died holding the lock. It will never finish,
      // so anything but a terminal state leaves the client polling forever.
      const status = await describeJob(jobStub({ getState: jest.fn().mockResolvedValue('stuck') }));

      expect(status.state).toBe('failed');
      expect(status.error).toMatch(/no longer tracking this job/i);
    });

    it('reads Bull\'s initial numeric progress without treating it as malformed', async () => {
      const status = await describeJob(
        jobStub({ getState: jest.fn().mockResolvedValue('active'), progress: jest.fn().mockReturnValue(0) }),
      );
      expect(status.progress).toEqual({ percent: 0, stage: 'Working' });
    });
  });

  describe('assertJobVisibleTo', () => {
    it('returns the job to the account that enqueued it', () => {
      const job = jobStub();
      expect(assertJobVisibleTo(job, 'user-1')).toBe(job);
    });

    it('refuses another account, with wording that does not confirm the id exists', () => {
      // Bull ids are a per-queue incrementing integer, so `GET /planning/jobs/2` is a guess. A
      // 403 here and a 404 on an unused id would together enumerate which jobs exist.
      const job = jobStub();
      let thrown: unknown;
      try {
        assertJobVisibleTo(job, 'someone-else');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as Error).message).toBe(
        'No such job. Results are kept for a limited time and are only readable by the account that requested them.',
      );
    });

    it('refuses a missing job with the identical message', () => {
      let missing: unknown;
      let foreign: unknown;
      try {
        assertJobVisibleTo(null, 'user-1');
      } catch (err) {
        missing = err;
      }
      try {
        assertJobVisibleTo(jobStub(), 'user-2');
      } catch (err) {
        foreign = err;
      }

      expect((missing as Error).message).toBe((foreign as Error).message);
    });

    it('refuses an unauthenticated caller even when the job has no requester recorded', () => {
      // Without the explicit userId check, `undefined === undefined` would hand a malformed job
      // to anyone who could reach the route.
      expect(() => assertJobVisibleTo(jobStub({ data: {} }), undefined)).toThrow(NotFoundException);
    });
  });

  describe('retention', () => {
    it('never keeps jobs unboundedly', () => {
      // `removeOnComplete: false` / `removeOnFail: false` — "keep everything forever" — is what
      // filled Redis previously, on `BullQueueManager` and on the `ocr` queue; both are bounded
      // now. Both bounds here must be real numbers, not `false` reintroduced by another name.
      expect(FAILED_JOB_RETENTION.age).toBeGreaterThan(0);
      expect(FAILED_JOB_RETENTION.count).toBeGreaterThan(0);
    });
  });
});
