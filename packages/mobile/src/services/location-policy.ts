import { calculateHaversineDistance } from '@fapoms/shared';

/**
 * When a position fix is worth spending battery, storage and radio on — and when it is not.
 *
 * The trail exists to answer one question: can this assayer's travel claim be confirmed? Every fix
 * that cannot move that answer is pure cost — a GNSS wake-up, a row on a cheap handset's flash, a
 * request over a metered rural connection, and a row in a table that will hold millions of them.
 *
 * The rules below are deliberately *derived from the server's judgement*, not invented here. The
 * assessment module in `travel-track.ts` already throws away movement smaller than the combined
 * accuracy of its endpoints, and already treats silence longer than five minutes as unobserved.
 * So the device's job is simply to stop paying for data that is guaranteed to be discarded, and to
 * keep paying for the one thing that cannot be reconstructed later: proof the handset was on.
 *
 * The asymmetry matters. Sending a redundant fix wastes a few bytes. *Not* sending one turns into
 * unobserved time, and unobserved time is what stops an honest assayer's claim being confirmed. So
 * every threshold here errs towards recording, and the heartbeat below is the floor nothing may
 * fall through.
 */

/**
 * Mirrors `DEFAULTS.maxGapMinutes` in `packages/backend/src/modules/assayer/travel-track.ts`.
 *
 * This is the ceiling the whole cadence hangs from: silence longer than this is scored as time the
 * platform could not see, which pushes a journey towards INSUFFICIENT_COVERAGE no matter how
 * honest it was. If that server constant ever changes, this must change with it.
 */
export const SERVER_MAX_GAP_MINUTES = 5;

/**
 * Mirrors `DEFAULTS.maxUsableAccuracyMeters`. A fix vaguer than this cannot contribute kilometres
 * server-side — but it still proves the device was on and reporting, so it is never discarded for
 * imprecision alone. See `decideFix`.
 */
export const SERVER_MAX_USABLE_ACCURACY_M = 250;

/** Mirrors `DEFAULTS.assumedAccuracyMeters`, used when a platform reports no accuracy at all. */
export const SERVER_ASSUMED_ACCURACY_M = 50;

/**
 * How long the trail may go quiet before a fix is recorded regardless of movement.
 *
 * Held a minute below the server's five-minute gap ceiling on purpose: one dropped OS callback at
 * a four-minute cadence still lands inside the window, where a five-minute cadence would score the
 * gap as unobserved every time it slipped. A stationary assayer therefore costs 15 fixes an hour
 * rather than 120, and loses nothing — a stationary person's path is fully described by its two
 * endpoints, and the beats in between exist only to say "still here, still on".
 */
export const HEARTBEAT_MS = 4 * 60_000;

/**
 * How often to check whether the heartbeat is overdue.
 *
 * The heartbeat cannot ride on the position subscription, because the thing that makes that
 * subscription cheap is `distanceInterval` — and a handset that has not moved gets *no callbacks
 * at all*. Left there, an assayer sitting in a branch for three hours would produce complete
 * silence, which is precisely the reading that cannot be told apart from a switched-off phone.
 *
 * So a timer checks, and only asks the platform for a position when the trail has actually gone
 * quiet. On a moving device it costs a subtraction every thirty seconds and nothing else. The
 * period has to be well under the slack between the heartbeat and the server's gap ceiling, or a
 * beat landing just after a tick would push the real gap past that ceiling — see the test that
 * pins `HEARTBEAT_MS + HEARTBEAT_CHECK_MS` below it.
 */
export const HEARTBEAT_CHECK_MS = 30_000;

/**
 * The floor on how often movement alone may be recorded — the sampling rate of a journey.
 *
 * Thirty seconds is not a guess: it is the rate `travel-track.ts` states the field app fixes at,
 * and the rate its five-minute gap ceiling is reasoned from ("ten missed fixes"). Matching it keeps
 * a drive at roughly 120 fixes an hour however chatty the platform is being — turn-by-turn
 * navigation delivers one every couple of seconds, and feeding all of those into the trail would
 * multiply its volume for resolution no distance question asks for.
 *
 * It costs a little: at 100 km/h the chords are ~830 m, so a winding road measures slightly short.
 * That is the direction every rule in this system already errs, and what the shortfall threshold
 * leaves room for. It also doubles as a guard against a burst of callbacks from a fusion engine
 * that has just re-acquired a signal.
 */
export const MIN_MOVED_INTERVAL_MS = 30_000;

/**
 * How long a recorded fix may wait on the device before the queue is drained.
 *
 * Uploading per fix is what this replaced. Waking the radio is the dominant cost of sending
 * anything at all, so ten fixes in one request is roughly a tenth of the battery of ten requests,
 * and the queue already survives the wait — it is written to storage precisely so nothing depends
 * on shipping it immediately.
 */
export const UPLOAD_MAX_WAIT_MS = 3 * 60_000;

/** Drain early once this many fixes are waiting, so a fast drive does not sit on a long backlog. */
export const UPLOAD_BATCH_SIZE = 12;

/**
 * Minimum spacing between "where are they now" pushes.
 *
 * This is the disposable PUT the desk reads, not the evidence trail. It is only worth sending when
 * the answer has actually changed, so a stationary assayer sends none at all — the position the
 * desk already holds is still true, and overwriting it with the same coordinate tells nobody
 * anything. There is no freshness column behind it for this to break.
 */
export const LIVE_PUSH_MIN_INTERVAL_MS = 60_000;

export interface PolicyFix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  /** Milliseconds since epoch. */
  at: number;
}

export type RecordReason = 'first' | 'moved' | 'heartbeat';
export type SkipReason = 'within-noise' | 'too-soon';

export type FixDecision =
  | { record: true; reason: RecordReason; movedMeters: number }
  | { record: false; reason: SkipReason; movedMeters: number };

const accuracyOf = (f: PolicyFix) =>
  f.accuracyMeters == null ? SERVER_ASSUMED_ACCURACY_M : Math.max(0, f.accuracyMeters);

/**
 * The distance below which two fixes are indistinguishable from a device sitting still.
 *
 * Identical to the server's noise floor — the sum of both endpoints' reported accuracy. Movement
 * under it is dropped there as jitter, so shipping it from the device buys a row that is
 * guaranteed to be thrown away.
 */
export function noiseFloorMeters(a: PolicyFix, b: PolicyFix): number {
  return accuracyOf(a) + accuracyOf(b);
}

/**
 * Decide whether a fix earns its place in the trail.
 *
 * Order matters. The heartbeat is checked before the noise floor so that a device standing still
 * still reports in — dropping those would save a trickle of data and cost the assayer their
 * coverage, which is exactly the wrong trade. Imprecision is never on its own grounds to discard:
 * a 900 m cell-tower fix carries no kilometres but is still proof the handset was alive.
 */
export function decideFix(previous: PolicyFix | null, next: PolicyFix): FixDecision {
  if (!previous) return { record: true, reason: 'first', movedMeters: 0 };

  const elapsed = next.at - previous.at;
  const movedMeters =
    calculateHaversineDistance(
      previous.latitude,
      previous.longitude,
      next.latitude,
      next.longitude,
    ) * 1000;

  if (elapsed >= HEARTBEAT_MS) return { record: true, reason: 'heartbeat', movedMeters };
  if (elapsed < MIN_MOVED_INTERVAL_MS) return { record: false, reason: 'too-soon', movedMeters };
  if (movedMeters > noiseFloorMeters(previous, next)) {
    return { record: true, reason: 'moved', movedMeters };
  }
  return { record: false, reason: 'within-noise', movedMeters };
}

/** Whether the trail has been quiet long enough that a position is worth asking the OS for. */
export function heartbeatOverdue(lastKept: PolicyFix | null, now: number): boolean {
  return lastKept === null || now - lastKept.at >= HEARTBEAT_MS;
}

/** Drain when a batch has built up, or when the oldest fix has waited long enough. */
export function shouldUpload(queuedCount: number, msSinceLastUpload: number): boolean {
  if (queuedCount <= 0) return false;
  return queuedCount >= UPLOAD_BATCH_SIZE || msSinceLastUpload >= UPLOAD_MAX_WAIT_MS;
}

/**
 * Whether to refresh the desk's "where are they now" position.
 *
 * Only movement changes the answer, so a heartbeat from a stationary device sends nothing.
 */
export function shouldPushLive(reason: RecordReason, msSinceLastPush: number): boolean {
  if (reason === 'first') return true;
  if (reason !== 'moved') return false;
  return msSinceLastPush >= LIVE_PUSH_MIN_INTERVAL_MS;
}

/**
 * What to ask the OS for while tracking.
 *
 * `distanceInterval` is the real saving: it hands the filtering to the platform's fusion engine,
 * which can leave the GNSS chip asleep and answer from cell and wifi, instead of a JS timer
 * demanding a fresh fix every thirty seconds whether or not anyone has moved. It is set below the
 * noise floor so the decision above — not the OS — remains the thing that defines "moved", and
 * `timeInterval` is short enough that the heartbeat is never starved by a stationary device.
 *
 * Balanced accuracy, not High: it is comfortably inside the 250 m the server can use, its jitter
 * sits under the noise floor that would discard it anyway, and it does not pin the GPS radio on
 * for a working day.
 *
 * The cost of `distanceInterval` is that a stationary device produces no callbacks whatsoever,
 * which is why `HEARTBEAT_CHECK_MS` exists rather than the heartbeat riding on this stream.
 */
export const WATCH_OPTIONS = {
  timeInterval: 30_000,
  distanceInterval: 25,
} as const;
