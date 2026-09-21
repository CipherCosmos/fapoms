import { GENERAL_ERROR_CODES, isApiErrorCode } from '@fapoms/shared';

/**
 * When the upload outbox may try a failed packet again on its own, and when it must stop.
 *
 * The outbox used to resend every FAILED packet on every drain: each app foreground, each enqueue,
 * each manual retry of something else. Two costs. A packet on a dead connection was re-attempted
 * back to back, burning battery and mobile data on an assayer's handset for nothing. And a packet
 * the server had REFUSED (the assignment no longer takes a return, the file is over the size
 * ceiling, the caller may not write there) was resent forever, when no number of retries could
 * ever change the answer.
 *
 * Plain TypeScript with no React Native in it, so jest can hold it (mobile has no RN test runtime;
 * see jest.config.js).
 */

/** First automatic retry after this long; doubles per consecutive failure. */
export const UPLOAD_RETRY_BASE_MS = 30_000;
/**
 * No automatic retry waits longer than this. A failure with no server verdict is usually "no
 * signal", and signal comes back; a quarter of an hour is the longest a recovered connection sits
 * idle before the outbox notices on its own. Retry on the row always sends at once regardless.
 */
export const UPLOAD_RETRY_CAP_MS = 15 * 60_000;

/** What the uploader could tell about a failure. Either may be missing. */
export interface UploadFailure {
  /** The HTTP status, when the uploader reports one. */
  status?: number;
  /** The server's machine-readable error code (`ApiErrorCode`), when its error body carried one. */
  code?: string;
}

/**
 * Server answers that say "not now" rather than "no". Everything the server can say on a 5xx, plus
 * the two 4xx that are about the moment rather than the packet: throttled, and a session that
 * lapsed (the packet itself is fine; sending it again once signed back in is exactly right).
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  GENERAL_ERROR_CODES.RATE_LIMITED,
  GENERAL_ERROR_CODES.UNAUTHENTICATED,
  GENERAL_ERROR_CODES.INTERNAL_ERROR,
  GENERAL_ERROR_CODES.SERVICE_UNAVAILABLE,
]);

/** The 4xx statuses that are not a verdict on the packet: session lapsed, timed out, throttled. */
const TRANSIENT_4XX: ReadonlySet<number> = new Set([401, 408, 429]);

/**
 * Did the server refuse this packet in a way retrying cannot change?
 *
 * By status when the uploader reports one: a 4xx other than 401/408/429. 401 is kept retryable on
 * purpose, unlike a plain reading of "any 4xx": it is a lapsed session, not a judgement of the file,
 * and the single-shot uploader already treats it the same way.
 *
 * By the server's error code otherwise, which is what the upload calls return today. The server
 * attaches a code to every error response it writes (global-exception.filter.ts), derived from the
 * status unless the thrower named a more specific one, so a code this build recognises and that is
 * not one of the "not now" codes above means the server looked at the request and said no. A 408
 * has no code of its own: the one a timed-out socket gets carries no JSON body, so it lands in the
 * "no verdict" branch and stays retryable.
 *
 * No status and no recognised code is no verdict at all (a dropped connection, a proxy's HTML error
 * page, a chunk that never went, a code from a newer server): retryable, with backoff. Guessing
 * "permanent" there would park an assayer's evidence on a hunch.
 */
export function isPermanentRefusal(failure: UploadFailure): boolean {
  if (typeof failure.status === 'number') {
    return failure.status >= 400 && failure.status < 500 && !TRANSIENT_4XX.has(failure.status);
  }
  return isApiErrorCode(failure.code) && !TRANSIENT_CODES.has(failure.code);
}

/**
 * How long to wait before automatic attempt number `failedAttempts + 1`.
 *
 * Exponential from `UPLOAD_RETRY_BASE_MS`, capped, with "equal jitter" (half fixed, half random):
 * after a server outage every handset in the field comes back to the foreground at once, and
 * without the random half they would all retry in lockstep.
 */
export function uploadRetryDelayMs(failedAttempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, failedAttempts - 1);
  const ceiling = Math.min(UPLOAD_RETRY_CAP_MS, UPLOAD_RETRY_BASE_MS * 2 ** Math.min(exponent, 30));
  const r = Math.max(0, Math.min(1, random()));
  return Math.round(ceiling / 2 + (ceiling / 2) * r);
}

/** The retry bookkeeping an outbox entry carries. All optional: entries from older builds lack them. */
export interface RetryState {
  status: string;
  /** Consecutive failed attempts since the last success or manual retry. */
  attempts?: number;
  /** ISO time before which the drain leaves a FAILED entry alone. */
  nextAttemptAt?: string;
  /** Refused by the server; only the assayer's Retry sends it again. */
  needsAttention?: boolean;
}

/**
 * Should a drain at `now` pick this entry up?
 *
 * PENDING always (never tried, or the assayer just pressed Retry). FAILED only once its backoff has
 * elapsed, and never when the server refused it. An entry written by an older build has no
 * `nextAttemptAt`, so it is due at once, which is what that build would have done.
 */
export function isDueForAttempt(entry: RetryState, now: number): boolean {
  if (entry.status === 'PENDING') return true;
  if (entry.status !== 'FAILED' || entry.needsAttention) return false;
  if (!entry.nextAttemptAt) return true;
  const at = new Date(entry.nextAttemptAt).getTime();
  return !Number.isFinite(at) || at <= now;
}
