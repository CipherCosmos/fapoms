import {
  decideFix,
  shouldUpload,
  shouldPushLive,
  heartbeatOverdue,
  noiseFloorMeters,
  HEARTBEAT_MS,
  HEARTBEAT_CHECK_MS,
  MIN_MOVED_INTERVAL_MS,
  UPLOAD_BATCH_SIZE,
  UPLOAD_MAX_WAIT_MS,
  LIVE_PUSH_MIN_INTERVAL_MS,
  SERVER_MAX_GAP_MINUTES,
  SERVER_ASSUMED_ACCURACY_M,
  type PolicyFix,
} from './location-policy';

const BASE = 1_700_000_000_000;

/** A fix `metresNorth` from the origin, `msLater` after it. 1 degree latitude ≈ 111,320 m. */
const at = (metresNorth: number, msLater: number, accuracyMeters: number | null = 20): PolicyFix => ({
  latitude: 12.9716 + metresNorth / 111_320,
  longitude: 77.5946,
  accuracyMeters,
  at: BASE + msLater,
});

describe('location policy — what a fix has to earn', () => {
  describe('decideFix', () => {
    it('always keeps the first fix, since there is nothing to compare it against', () => {
      expect(decideFix(null, at(0, 0))).toMatchObject({ record: true, reason: 'first' });
    });

    it('drops movement smaller than the combined accuracy of the two fixes', () => {
      // 20 m apart, but each fix claims ±20 m — indistinguishable from a device sitting still,
      // and the server would discard the segment as jitter anyway.
      const decision = decideFix(at(0, 0), at(20, 60_000));
      expect(decision.record).toBe(false);
      expect(decision.reason).toBe('within-noise');
    });

    it('keeps movement past the noise floor', () => {
      const decision = decideFix(at(0, 0), at(200, 60_000));
      expect(decision).toMatchObject({ record: true, reason: 'moved' });
      expect(Math.round(decision.movedMeters)).toBe(200);
    });

    it('scales the noise floor with a vague fix rather than trusting it', () => {
      const previous = at(0, 0, 20);
      const next = at(200, 60_000, 400);
      expect(noiseFloorMeters(previous, next)).toBe(420);
      // 200 m of apparent movement inside a 420 m uncertainty proves nothing.
      expect(decideFix(previous, next).record).toBe(false);
    });

    it('assumes the server default when a platform reports no accuracy at all', () => {
      expect(noiseFloorMeters(at(0, 0, null), at(0, 0, null))).toBe(SERVER_ASSUMED_ACCURACY_M * 2);
    });

    it('records a stationary device on the heartbeat, so silence is never mistaken for absence', () => {
      // Not moved an inch, but four minutes have passed. This is the fix that proves the handset
      // is on, which is the one thing that cannot be reconstructed after the fact.
      const decision = decideFix(at(0, 0), at(0, HEARTBEAT_MS));
      expect(decision).toMatchObject({ record: true, reason: 'heartbeat' });
    });

    it('keeps an imprecise heartbeat, because coverage does not require precision', () => {
      // A 900 m cell-tower fix carries no kilometres, but it still says the device was alive.
      const decision = decideFix(at(0, 0), at(0, HEARTBEAT_MS, 900));
      expect(decision).toMatchObject({ record: true, reason: 'heartbeat' });
    });

    it('beats faster than the server counts a gap as unobserved time', () => {
      // The whole cadence hangs off this: a heartbeat at or past the server's gap ceiling would
      // manufacture INSUFFICIENT_COVERAGE for a perfectly honest, stationary assayer. The check
      // period is included because a beat falling just after a tick waits a whole period more —
      // that worst case, not the nominal interval, is what the server sees as the gap.
      expect(HEARTBEAT_MS + HEARTBEAT_CHECK_MS).toBeLessThan(SERVER_MAX_GAP_MINUTES * 60_000);
    });

    it('ignores movement arriving faster than the sampling floor', () => {
      const decision = decideFix(at(0, 0), at(500, MIN_MOVED_INTERVAL_MS - 1));
      expect(decision).toMatchObject({ record: false, reason: 'too-soon' });
    });

    it('still keeps real movement once the floor has passed', () => {
      expect(decideFix(at(0, 0), at(500, MIN_MOVED_INTERVAL_MS)).record).toBe(true);
    });

    it('records a driving assayer at road resolution', () => {
      // 60 km/h sampled every 30 s is ~500 m a leg — well past a ±20 m noise floor, all kept.
      let previous = at(0, 0);
      let kept = 0;
      for (let i = 1; i <= 6; i++) {
        const next = at(500 * i, MIN_MOVED_INTERVAL_MS * i);
        if (decideFix(previous, next).record) {
          kept++;
          previous = next;
        }
      }
      expect(kept).toBe(6);
    });

    it('holds a drive to the sampling rate however fast the platform offers fixes', () => {
      // Turn-by-turn navigation delivers a fix every 2.5 s. An hour of that is ~1,440 positions;
      // the trail keeps 120, which is the rate the server's own gap reasoning assumes.
      let previous = at(0, 0);
      let kept = 0;
      for (let ms = 2_500; ms <= 60 * 60_000; ms += 2_500) {
        // 60 km/h — ~42 m every 2.5 s.
        const next = at((ms / 1000) * 16.7, ms);
        if (decideFix(previous, next).record) {
          kept++;
          previous = next;
        }
      }
      expect(kept).toBe(120);
    });

    it('settles a stationary assayer at the heartbeat rather than the sampling rate', () => {
      // An hour parked at a branch, the OS offering a fix every 30 s. Only the beats survive.
      const start = at(0, 0);
      let previous = start;
      let kept = 0;
      for (let ms = 30_000; ms <= 60 * 60_000; ms += 30_000) {
        // Jitter of a few metres, as a real stationary handset produces.
        const next = at((ms / 30_000) % 3, ms);
        if (decideFix(previous, next).record) {
          kept++;
          previous = next;
        }
      }
      // 120 offered fixes an hour become 15 — one every four minutes.
      expect(kept).toBe(15);
    });
  });

  describe('heartbeatOverdue', () => {
    it('is due when nothing has ever been recorded', () => {
      expect(heartbeatOverdue(null, BASE)).toBe(true);
    });

    it('spends nothing while the stream is still delivering movement', () => {
      expect(heartbeatOverdue(at(0, 0), BASE + HEARTBEAT_MS - 1)).toBe(false);
    });

    it('asks the platform for a position once the trail has gone quiet', () => {
      // The case this exists for: a handset parked in a branch gets no subscription callbacks at
      // all, because `distanceInterval` suppresses them. Without this the trail would simply stop.
      expect(heartbeatOverdue(at(0, 0), BASE + HEARTBEAT_MS)).toBe(true);
    });
  });

  describe('shouldUpload', () => {
    it('sends nothing when there is nothing queued', () => {
      expect(shouldUpload(0, UPLOAD_MAX_WAIT_MS * 10)).toBe(false);
    });

    it('waits rather than waking the radio for a single fix', () => {
      expect(shouldUpload(1, 1_000)).toBe(false);
    });

    it('drains once a batch has built up', () => {
      expect(shouldUpload(UPLOAD_BATCH_SIZE, 0)).toBe(true);
    });

    it('drains a small backlog once it has waited long enough', () => {
      expect(shouldUpload(2, UPLOAD_MAX_WAIT_MS)).toBe(true);
    });
  });

  describe('shouldPushLive', () => {
    it('pushes immediately when sharing has just been switched on', () => {
      expect(shouldPushLive('first', 0)).toBe(true);
    });

    it('sends nothing for a heartbeat — the desk already holds that position', () => {
      expect(shouldPushLive('heartbeat', LIVE_PUSH_MIN_INTERVAL_MS * 10)).toBe(false);
    });

    it('refreshes the desk when the assayer has actually moved', () => {
      expect(shouldPushLive('moved', LIVE_PUSH_MIN_INTERVAL_MS)).toBe(true);
    });

    it('rate-limits movement so a drive does not become a request per fix', () => {
      expect(shouldPushLive('moved', LIVE_PUSH_MIN_INTERVAL_MS - 1)).toBe(false);
    });
  });
});
