import { waitForQueuedJob, QueuedJobTimeout, QueuedJobGone, QUEUED_JOB_POLL_MS } from './queued-job';
import { api } from './api';

/**
 * Waiting on a job the server accepted rather than performed.
 *
 * The roster's bulk credential and notify runs used to hold one request for up to half an hour and
 * time out in the browser at 30 s while the server carried on. They now answer 202 with a job id and
 * this polls it. What must not regress: a blip while reading the job's state is not the job failing
 * (else a clerk re-runs 540 credential emails), the job's own failure IS reported with its words,
 * a job that runs past the patience limit is reported as still running — a distinct error the
 * screen can phrase differently — and a screen that stopped caring stops asking.
 */

jest.mock('./api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const status = (state: string, over: Record<string, unknown> = {}) => ({
  jobId: 'job-1', state, progress: { percent: 0, stage: 'Queued' }, ...over,
});

/** Records how a promise settled without awaiting it, so a test can move the clock first. */
const track = <T>(p: Promise<T>) => {
  const out: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { state: 'pending' };
  p.then((value) => { out.state = 'resolved'; out.value = value; }, (error) => { out.state = 'rejected'; out.error = error; });
  return out;
};

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  jest.useFakeTimers();
  mockRequest.mockReset();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('waitForQueuedJob', () => {
  it('polls the status path until the job is done, and resolves with its result', async () => {
    const result = { succeeded: [{ id: 'a-1', channels: ['EMAIL'], emailId: 'em-1' }], skipped: [], failed: [] };
    mockRequest
      .mockResolvedValueOnce(status('queued'))
      .mockResolvedValueOnce(status('running', { progress: { percent: 50, stage: 'Issued 1 of 2' } }))
      .mockResolvedValueOnce(status('done', { progress: { percent: 100, stage: 'Done' }, result }));

    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 100 }));
    await advance(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('/assayers/bulk-jobs/job-1');
    expect(job.state).toBe('pending');

    await advance(100);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(job.state).toBe('pending');

    await advance(100);
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(job).toEqual({ state: 'resolved', value: result });
  });

  it('waits QUEUED_JOB_POLL_MS between reads when no interval is given', async () => {
    mockRequest.mockResolvedValue(status('running'));
    track(waitForQueuedJob('/assayers/bulk-jobs/job-1'));
    await advance(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await advance(QUEUED_JOB_POLL_MS - 1);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects with the job\'s own error when it failed, and stops asking', async () => {
    mockRequest.mockResolvedValue(status('failed', { error: 'Email is not set up, so no credentials were sent.' }));

    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 100 }));
    await advance(0);
    expect(job.state).toBe('rejected');
    expect(job.error).toBeInstanceOf(Error);
    expect(job.error).not.toBeInstanceOf(QueuedJobTimeout);
    expect((job.error as Error).message).toBe('Email is not set up, so no credentials were sent.');

    await advance(10_000);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('still says something when a failed job gave no reason', async () => {
    mockRequest.mockResolvedValue(status('failed'));
    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 100 }));
    await advance(0);
    expect((job.error as Error).message).toBe('The job failed without saying why.');
  });

  it('treats a read that threw as a read that failed — asks again rather than failing the job', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502 }))
      .mockResolvedValueOnce(status('done', { result: { ok: true } }));

    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 100 }));
    await advance(0);
    expect(job.state).toBe('pending');
    await advance(100);
    expect(job.state).toBe('pending');
    await advance(100);
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(job).toEqual({ state: 'resolved', value: { ok: true } });
  });

  it('reports each progress reading it gets while the job runs', async () => {
    mockRequest
      .mockResolvedValueOnce(status('queued', { progress: { percent: 0, stage: 'Waiting for a worker' } }))
      .mockResolvedValueOnce(status('running', { progress: { percent: 40, stage: 'Issued 216 of 540' } }))
      .mockResolvedValueOnce(status('done', { result: {} }));
    const onProgress = jest.fn();

    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 100, onProgress }));
    await advance(250);

    expect(job.state).toBe('resolved');
    expect(onProgress.mock.calls).toEqual([
      [{ percent: 0, stage: 'Waiting for a worker' }],
      [{ percent: 40, stage: 'Issued 216 of 540' }],
    ]);
  });

  it('gives up past giveUpMs with QueuedJobTimeout — the job may still finish, so it is not a failure', async () => {
    mockRequest.mockResolvedValue(status('running'));

    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 1000, giveUpMs: 5000 }));
    await advance(4000);
    expect(job.state).toBe('pending');

    await advance(3000);
    expect(job.state).toBe('rejected');
    expect(job.error).toBeInstanceOf(QueuedJobTimeout);
    expect((job.error as Error).message).toMatch(/carries on in the background/);

    const asked = mockRequest.mock.calls.length;
    await advance(60_000);
    expect(mockRequest).toHaveBeenCalledTimes(asked);
  });

  it('gives up on time even when every read is failing', async () => {
    mockRequest.mockRejectedValue(new Error('Network request failed'));
    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 1000, giveUpMs: 5000 }));
    await advance(7000);
    expect(job.error).toBeInstanceOf(QueuedJobTimeout);
  });

  it('stops asking once the caller cancels, and says it stopped watching', async () => {
    mockRequest.mockResolvedValue(status('running'));
    const signal = { cancelled: false };

    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { pollMs: 100, signal }));
    await advance(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);

    signal.cancelled = true;
    await advance(100);
    expect(job.state).toBe('rejected');
    expect(job.error).not.toBeInstanceOf(QueuedJobTimeout);
    expect((job.error as Error).message).toBe('Stopped watching the job.');

    await advance(10_000);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('never asks at all when cancelled before it starts', async () => {
    const job = track(waitForQueuedJob('/assayers/bulk-jobs/job-1', { signal: { cancelled: true } }));
    await advance(0);
    expect(job.state).toBe('rejected');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  /**
   * A job past its retention answers 404. Retrying every poll error made that spin for the whole
   * twenty-minute give-up window instead of saying so.
   */
  it('stops at once when the server says the job is gone, instead of polling for twenty minutes', async () => {
    const gone = Object.assign(new Error('Not Found'), { status: 404 });
    mockRequest.mockRejectedValue(gone);

    const job = track(waitForQueuedJob('/jobs/expired', { pollMs: 100, giveUpMs: 60_000 }));
    await advance(0);
    expect(job.state).toBe('rejected');
    expect(job.error).toBeInstanceOf(QueuedJobGone);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient poll failure that is not a 404', async () => {
    const blip = Object.assign(new Error('Bad Gateway'), { status: 502 });
    mockRequest.mockRejectedValueOnce(blip).mockResolvedValueOnce(status('done', { result: 7 }));

    const job = track(waitForQueuedJob('/jobs/blip', { pollMs: 100 }));
    await advance(0);
    expect(job.state).toBe('pending');
    await advance(100);
    expect(job).toEqual({ state: 'resolved', value: 7 });
  });
});
