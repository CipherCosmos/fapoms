import {
  isDueForAttempt,
  isPermanentRefusal,
  uploadRetryDelayMs,
  UPLOAD_RETRY_BASE_MS,
  UPLOAD_RETRY_CAP_MS,
} from './upload-retry-policy';

/**
 * The rules that decide whether the upload outbox tries a failed packet again on its own.
 *
 * Two failures this replaces: every drain (each app foreground) resent every failed packet with no
 * pause, and a packet the server had refused was resent forever. What must hold: a refusal is told
 * apart from "no verdict" without ever parking a packet on a guess; the wait grows and stops
 * growing; and a drain only picks up what is actually due.
 */

describe('isPermanentRefusal', () => {
  /** With a status in hand the rule is the plain one: a 4xx is a verdict, except the "not now" ones. */
  it('treats a 4xx as a refusal, except a lapsed session, a timeout and throttling', () => {
    for (const status of [400, 403, 404, 409, 413, 422]) expect(isPermanentRefusal({ status })).toBe(true);
    for (const status of [401, 408, 429, 500, 502, 503]) expect(isPermanentRefusal({ status })).toBe(false);
  });

  /**
   * The upload calls report the server's code, not the status. The server derives a code from the
   * status on every error it writes, so a recognised code that is not a "not now" code is a refusal.
   */
  it('reads a recognised server code as a refusal, and the throttled, session and server-fault codes as not', () => {
    for (const code of ['CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED']) {
      expect(isPermanentRefusal({ code })).toBe(true);
    }
    for (const code of ['RATE_LIMITED', 'UNAUTHENTICATED', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE']) {
      expect(isPermanentRefusal({ code })).toBe(false);
    }
  });

  /**
   * No status and no code this build knows is no verdict: a dropped connection, a proxy's HTML
   * error page, a code from a newer server. Calling that permanent would stop an assayer's evidence
   * on a guess.
   */
  it('keeps retrying when there is no verdict at all', () => {
    expect(isPermanentRefusal({})).toBe(false);
    expect(isPermanentRefusal({ code: 'SOMETHING_A_NEWER_SERVER_SENDS' })).toBe(false);
  });
});

describe('uploadRetryDelayMs', () => {
  /** Doubles per failure from the base, and never passes the cap however long the dead spell lasts. */
  it('grows exponentially from the base and stops at the cap', () => {
    const top = () => 1;
    expect(uploadRetryDelayMs(1, top)).toBe(UPLOAD_RETRY_BASE_MS);
    expect(uploadRetryDelayMs(2, top)).toBe(UPLOAD_RETRY_BASE_MS * 2);
    expect(uploadRetryDelayMs(3, top)).toBe(UPLOAD_RETRY_BASE_MS * 4);
    expect(uploadRetryDelayMs(50, top)).toBe(UPLOAD_RETRY_CAP_MS);
    expect(uploadRetryDelayMs(10_000, top)).toBe(UPLOAD_RETRY_CAP_MS);
  });

  /** Half fixed, half random, so a fleet coming back from a server outage does not retry in lockstep. */
  it('jitters within the upper half of the window', () => {
    expect(uploadRetryDelayMs(1, () => 0)).toBe(UPLOAD_RETRY_BASE_MS / 2);
    expect(uploadRetryDelayMs(50, () => 0)).toBe(UPLOAD_RETRY_CAP_MS / 2);
  });
});

describe('isDueForAttempt', () => {
  const now = Date.parse('2026-09-17T10:00:00Z');

  it('always picks up a PENDING packet, and never a SENDING or SENT one', () => {
    expect(isDueForAttempt({ status: 'PENDING', nextAttemptAt: '2026-09-17T11:00:00Z' }, now)).toBe(true);
    expect(isDueForAttempt({ status: 'SENDING' }, now)).toBe(false);
    expect(isDueForAttempt({ status: 'SENT' }, now)).toBe(false);
  });

  it('picks up a FAILED packet only once its backoff has passed', () => {
    expect(isDueForAttempt({ status: 'FAILED', nextAttemptAt: '2026-09-17T10:00:30Z' }, now)).toBe(false);
    expect(isDueForAttempt({ status: 'FAILED', nextAttemptAt: '2026-09-17T09:59:59Z' }, now)).toBe(true);
  });

  /** A refused packet waits for a person, however long ago it failed. */
  it('never picks up a refused packet on its own', () => {
    expect(isDueForAttempt({ status: 'FAILED', needsAttention: true, nextAttemptAt: '2020-01-01T00:00:00Z' }, now)).toBe(false);
  });

  /** A packet written by a build before backoff existed has no schedule; it goes, as it would have. */
  it('treats a failed packet from an older build as due', () => {
    expect(isDueForAttempt({ status: 'FAILED' }, now)).toBe(true);
  });
});
