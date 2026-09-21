import { api } from './api';

/**
 * Waiting on a server job that was accepted rather than performed.
 *
 * The shape every `POST … → 202 { jobId }` endpoint answers its poll with (`QueuedJobStatus` in
 * `infrastructure/queue/queued-job.ts` on the server): four states a screen can act on, a progress
 * label, and the result or the error at the end.
 */
export interface QueuedJobStatus<TResult> {
  jobId: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: { percent: number; stage: string };
  result?: TResult;
  error?: string;
}

export interface EnqueuedJob {
  jobId: string;
  deduplicated: boolean;
}

export const QUEUED_JOB_POLL_MS = 1500;
/** Past this the job is reported as still running, not as failed — it may well finish. */
export const QUEUED_JOB_GIVE_UP_MS = 20 * 60_000;

export class QueuedJobTimeout extends Error {}

/** The server no longer has the job for this person (expired, or not theirs). */
export class QueuedJobGone extends Error {}

export const JOB_GONE_MESSAGE =
  'This job is no longer available — its result may have expired. Check the page before running it again.';

/**
 * Poll `statusPath` until the job is done, and resolve with its result.
 *
 * A poll that fails (a network blip, a deploy) is retried rather than reported: a failed read of a
 * job's state says nothing about the job. Only the job's own `failed` state, or running past the
 * give-up time, rejects.
 */
export async function waitForQueuedJob<TResult>(
  statusPath: string,
  opts: {
    onProgress?: (progress: { percent: number; stage: string }) => void;
    signal?: { cancelled: boolean };
    pollMs?: number;
    giveUpMs?: number;
  } = {},
): Promise<TResult> {
  const pollMs = opts.pollMs ?? QUEUED_JOB_POLL_MS;
  const giveUpMs = opts.giveUpMs ?? QUEUED_JOB_GIVE_UP_MS;
  const startedAt = Date.now();

  for (;;) {
    if (opts.signal?.cancelled) throw new Error('Stopped watching the job.');
    try {
      const status = await api.request<QueuedJobStatus<TResult>>(statusPath);
      if (status.state === 'done') return status.result as TResult;
      if (status.state === 'failed') throw new JobFailed(status.error ?? 'The job failed without saying why.');
      opts.onProgress?.(status.progress);
    } catch (err) {
      if (err instanceof JobFailed) throw new Error(err.message);
      /*
        404 / 403 is the server saying this job is not there for this person — it expired from the
        queue's retention, or was never theirs. Retrying cannot change that, and treating it like a
        network blip left the page spinning for the whole give-up window.
      */
      const status = (err as { status?: number } | null)?.status;
      if (status === 404 || status === 403) throw new QueuedJobGone(JOB_GONE_MESSAGE);
      // Otherwise the poll itself failed; try again below.
    }
    if (Date.now() - startedAt > giveUpMs) {
      throw new QueuedJobTimeout(
        'This is still running after a long while. It carries on in the background — check back shortly.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

class JobFailed extends Error {}
