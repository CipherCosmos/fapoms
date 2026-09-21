import { api } from '../../../services/api';
import { AppError, userMessage } from '../../../services/errors';
import { EnqueuedJob, QueuedJobGone, QueuedJobTimeout, waitForQueuedJob } from '../../../services/queued-job';

/**
 * Running an approved wipe from the Danger Zone, and saying truthfully how it ended.
 *
 * The execute call used to hold one request open for the backup and the wipe together, and gave up
 * at 180 s — on a large database the screen said "Wipe failed" while the server went on deleting.
 * The server now accepts the wipe (202 + a job id) and this watches `runs/:jobId` through the same
 * poller every accepted job uses. What it adds is the one thing a destructive screen must not get
 * wrong: telling "the server refused, nothing happened" apart from "we could not find out".
 */

export interface WipeResult {
  removed: Record<string, number>;
  backup: { filename: string; sizeBytes: number } | null;
}

export interface WipeRequestBody {
  requestId?: string;
  domainKeys: string[];
  keepUserIds: string[];
  billingConfirmed?: boolean;
  takeBackupFirst: boolean;
  confirmationPhrase: string;
}

export type WipeOutcome =
  /** The wipe committed; `result` is what the server measured as removed. */
  | { kind: 'done'; result: WipeResult }
  /** The server answered the start with a refusal: nothing was started, so nothing was deleted. */
  | { kind: 'refused'; message: string }
  /** The run started and ended in failure; `message` is the server's own explanation. */
  | { kind: 'failed'; message: string }
  /** This screen could not learn the ending. The request's status on the page is the truth. */
  | { kind: 'unknown'; message: string };

/**
 * How long this screen keeps watching. A backup is allowed five minutes on the server, and the
 * wipe follows it; past this the screen says it stopped waiting — never that the wipe failed.
 */
export const WIPE_WATCH_GIVE_UP_MS = 15 * 60_000;

/** Grounded in the server's guarantee: the approval flips to Executed in the wipe's own transaction. */
export const WIPE_OUTCOME_UNKNOWN =
  'This screen stopped waiting before the server said how the wipe ended — it may still be running. ' +
  "Check this request's status on the Danger Zone page: Executed means the wipe went through. While it " +
  'still shows Approved, nothing has been deleted — the deletes and that status change commit together.';

export async function runApprovedWipe(
  body: WipeRequestBody,
  opts: {
    onStage?: (stage: string) => void;
    signal?: { cancelled: boolean };
    pollMs?: number;
    giveUpMs?: number;
  } = {},
): Promise<WipeOutcome> {
  let jobId: string;
  try {
    ({ jobId } = await api.request<EnqueuedJob>('/admin/data-reset/execute', {
      method: 'POST',
      body: JSON.stringify(body),
    }));
  } catch (err) {
    /**
     * Only a 4xx is a refusal the server made before starting anything. No answer at all (network,
     * timeout) or a 5xx (a proxy mid-deploy) leaves open that it was accepted, so it is "unknown",
     * not "failed" — calling it failed is exactly the lie this file exists to stop telling.
     */
    if (err instanceof AppError && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      return { kind: 'refused', message: userMessage(err) };
    }
    return { kind: 'unknown', message: WIPE_OUTCOME_UNKNOWN };
  }

  try {
    const result = await waitForQueuedJob<WipeResult>(`/admin/data-reset/runs/${jobId}`, {
      onProgress: (progress) => opts.onStage?.(progress.stage),
      signal: opts.signal,
      pollMs: opts.pollMs,
      giveUpMs: opts.giveUpMs ?? WIPE_WATCH_GIVE_UP_MS,
    });
    return { kind: 'done', result };
  } catch (err) {
    // Gave up waiting, the screen closed, or the server no longer knows the run (a restart forgets
    // it — every poll then answers 404): the ending was never seen, so it is not a failure. A wipe
    // reported "failed" that actually committed is the one lie this file exists to prevent.
    if (err instanceof QueuedJobTimeout || err instanceof QueuedJobGone || opts.signal?.cancelled) {
      return { kind: 'unknown', message: WIPE_OUTCOME_UNKNOWN };
    }
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
