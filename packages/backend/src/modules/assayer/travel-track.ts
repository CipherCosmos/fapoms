import { calculateHaversineDistance } from '@fapoms/shared';

/**
 * Turning a list of GPS fixes into a defensible statement about a journey.
 *
 * This is pure and dependency-free on purpose. It decides whether somebody's travel claim looks
 * right, so every rule in it has to be inspectable and testable on its own, and re-runnable over
 * stored history when a threshold is later judged wrong. Nothing here reads or writes anything.
 *
 * The governing principle, and the reason for most of the code below: **absence of evidence is not
 * evidence of absence.** These are field workers in rural India, in bank basements and strongrooms,
 * on handsets that lose signal and run out of battery. A gap in the trail is the normal case, not a
 * suspicious one. So this module reports what it actually observed *and how much of the window it
 * could see*, and refuses to express a shortfall it has not earned the right to claim. An
 * under-observed journey returns INSUFFICIENT_COVERAGE, never SHORTFALL.
 */

/** One position as reported by a device. `recordedAt` is device time; see the entity docs. */
export interface TrackFix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  recordedAt: Date;
  isMocked?: boolean;
}

export interface TrackOptions {
  /**
   * Assumed accuracy when a platform reports none. 50 m is a normal open-sky smartphone fix;
   * assuming better would let jitter be counted as travel.
   */
  assumedAccuracyMeters?: number;
  /**
   * A fix this imprecise cannot support a distance claim at all — a 1 km-accurate cell-tower fix
   * says "somewhere in this town". Such fixes still count as *coverage* (the device was on and
   * reporting), they just cannot contribute kilometres.
   */
  maxUsableAccuracyMeters?: number;
  /**
   * Above this implied ground speed a segment is treated as a jump rather than travel: bad
   * multipath, a resumed trail, or a spoofed coordinate. Set high enough (300 km/h) that no road
   * or rail journey in India trips it. Air travel does exceed it, and will therefore be raised for
   * a human to look at — which is the right outcome for a per-kilometre road allowance anyway.
   */
  maxPlausibleSpeedKmh?: number;
  /**
   * Silence longer than this counts as unobserved time. The field app fixes every 30 s, so five
   * minutes is ten missed fixes — comfortably past a hiccup, well short of penalising a tunnel.
   */
  maxGapMinutes?: number;
}

const DEFAULTS: Required<TrackOptions> = {
  assumedAccuracyMeters: 50,
  maxUsableAccuracyMeters: 250,
  maxPlausibleSpeedKmh: 300,
  maxGapMinutes: 5,
};

export interface TrackSummary {
  /** Kilometres actually evidenced by the fixes. A floor, never an estimate of the true journey. */
  observedDistanceKm: number;
  /** First fix to last fix, as the crow flies. A sanity bound on the above. */
  straightLineDistanceKm: number;
  fixCount: number;
  /** Fixes precise enough to contribute distance. */
  usableFixCount: number;
  firstFixAt: Date | null;
  lastFixAt: Date | null;
  /** Minutes from first to last fix. */
  observedSpanMinutes: number;
  /** The longest silence between consecutive fixes. The headline honesty number. */
  longestGapMinutes: number;
  /** Fraction of the requested window the trail can actually speak for, 0..1. */
  coverage: number;
  /** Segments dropped because the movement was inside the combined accuracy of its endpoints. */
  segmentsWithinNoise: number;
  /** Segments dropped because the implied speed was not physically plausible. */
  segmentsImplausible: number;
  /** Fastest implied speed across counted segments, km/h. */
  maxImpliedSpeedKmh: number;
  /** Fixes the OS flagged as coming from a mock provider. */
  mockedFixCount: number;
}

const MINUTE_MS = 60_000;
const round = (n: number, dp = 2) => Number(n.toFixed(dp));

/**
 * Summarise a set of fixes over a window.
 *
 * `windowStart`/`windowEnd` describe the period the caller wants a statement about (typically the
 * journey to a branch). Coverage is measured against that window, so unobserved time before the
 * first fix and after the last one counts against it — otherwise a device switched on for the last
 * two minutes of a four-hour journey would report perfect coverage of the trail it did produce.
 */
export function summariseTrack(
  fixes: TrackFix[],
  windowStart: Date,
  windowEnd: Date,
  options: TrackOptions = {},
): TrackSummary {
  const opt = { ...DEFAULTS, ...options };
  const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());

  // Sort defensively: batches arrive out of order after an offline spell, and every calculation
  // below assumes chronological order.
  const ordered = [...fixes].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  const empty: TrackSummary = {
    observedDistanceKm: 0,
    straightLineDistanceKm: 0,
    fixCount: 0,
    usableFixCount: 0,
    firstFixAt: null,
    lastFixAt: null,
    observedSpanMinutes: 0,
    longestGapMinutes: round(windowMs / MINUTE_MS, 1),
    coverage: 0,
    segmentsWithinNoise: 0,
    segmentsImplausible: 0,
    maxImpliedSpeedKmh: 0,
    mockedFixCount: 0,
  };
  if (ordered.length === 0) return empty;

  const mockedFixCount = ordered.filter((f) => f.isMocked).length;
  const accuracyOf = (f: TrackFix) =>
    f.accuracyMeters == null ? opt.assumedAccuracyMeters : Math.max(0, f.accuracyMeters);

  // Coverage counts every fix, including imprecise ones: a poor fix still proves the handset was
  // on and reporting, which is exactly what coverage is about. Distance is stricter (below).
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  let unobservedMs =
    Math.max(0, first.recordedAt.getTime() - windowStart.getTime()) +
    Math.max(0, windowEnd.getTime() - last.recordedAt.getTime());
  let longestGapMs = Math.max(
    first.recordedAt.getTime() - windowStart.getTime(),
    windowEnd.getTime() - last.recordedAt.getTime(),
    0,
  );
  const gapToleranceMs = opt.maxGapMinutes * MINUTE_MS;
  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].recordedAt.getTime() - ordered[i - 1].recordedAt.getTime();
    if (gap > longestGapMs) longestGapMs = gap;
    if (gap > gapToleranceMs) unobservedMs += gap;
  }

  // Distance uses only fixes precise enough to mean something.
  const usable = ordered.filter((f) => accuracyOf(f) <= opt.maxUsableAccuracyMeters);

  let observedKm = 0;
  let segmentsWithinNoise = 0;
  let segmentsImplausible = 0;
  let maxImpliedSpeedKmh = 0;

  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1];
    const b = usable[i];
    const km = calculateHaversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
    const elapsedMs = b.recordedAt.getTime() - a.recordedAt.getTime();

    // Movement smaller than the combined uncertainty of its two endpoints is indistinguishable
    // from a stationary device jittering. Counting it turns a lunch break into kilometres.
    const noiseFloorKm = (accuracyOf(a) + accuracyOf(b)) / 1000;
    if (km <= noiseFloorKm) {
      segmentsWithinNoise++;
      continue;
    }

    // A jump. Excluded rather than counted: including it would inflate the observed distance,
    // and inflation is the direction that could wrongly *support* a claim.
    if (elapsedMs > 0) {
      const speedKmh = km / (elapsedMs / 3_600_000);
      if (speedKmh > opt.maxPlausibleSpeedKmh) {
        segmentsImplausible++;
        continue;
      }
      if (speedKmh > maxImpliedSpeedKmh) maxImpliedSpeedKmh = speedKmh;
    } else {
      // Two fixes at the same instant in different places: not a journey, a contradiction.
      segmentsImplausible++;
      continue;
    }

    observedKm += km;
  }

  const straightLineKm =
    usable.length >= 2
      ? calculateHaversineDistance(
          usable[0].latitude,
          usable[0].longitude,
          usable[usable.length - 1].latitude,
          usable[usable.length - 1].longitude,
        )
      : 0;

  return {
    observedDistanceKm: round(observedKm),
    straightLineDistanceKm: round(straightLineKm),
    fixCount: ordered.length,
    usableFixCount: usable.length,
    firstFixAt: first.recordedAt,
    lastFixAt: last.recordedAt,
    observedSpanMinutes: round((last.recordedAt.getTime() - first.recordedAt.getTime()) / MINUTE_MS, 1),
    longestGapMinutes: round(longestGapMs / MINUTE_MS, 1),
    coverage: windowMs === 0 ? 0 : round(Math.max(0, Math.min(1, 1 - unobservedMs / windowMs)), 3),
    segmentsWithinNoise,
    segmentsImplausible,
    maxImpliedSpeedKmh: round(maxImpliedSpeedKmh, 1),
    mockedFixCount,
  };
}

/**
 * What the trail lets us say about a claim.
 *
 * Ordered by how much they should worry a reviewer. Note what is absent: there is no "FRAUD"
 * verdict, and no verdict withholds payment. This module reports evidence; a person decides.
 */
export type TravelVerdict =
  /** No fixes at all in the window. Says nothing about whether the journey happened. */
  | 'NO_DATA'
  /** Too little of the window observed to compare distances honestly. */
  | 'INSUFFICIENT_COVERAGE'
  /** Well observed, and the movement is consistent with the distance claimed. */
  | 'CONSISTENT'
  /** Well observed, and materially less movement than claimed. Worth asking about. */
  | 'SHORTFALL'
  /** The trail itself is not trustworthy: mocked fixes, or impossible jumps. */
  | 'IMPLAUSIBLE';

export interface TravelAssessment {
  verdict: TravelVerdict;
  /** One sentence a reviewer can act on, written for a person, not a log. */
  summary: string;
  track: TrackSummary;
  /** The distance the claim/quote was based on, when the caller supplied one. */
  expectedDistanceKm: number | null;
  /** observedDistanceKm / expectedDistanceKm, when both are known. */
  observedRatio: number | null;
}

export interface AssessOptions extends TrackOptions {
  /**
   * Whether the assayer had location sharing switched on for this window.
   *
   * Changes what an empty trail *means*, and the distinction is worth stating precisely: "the
   * handset could not reach us" and "the feature was off" are different facts about different
   * people. Neither is evidence about the travel, but only one of them is anybody's decision.
   */
  trackingEnabled?: boolean;
  /** Below this coverage the window is too patchy to argue about distance. */
  minCoverageForComparison?: number;
  /**
   * How much less movement than claimed is worth raising. A journey legitimately measures short:
   * the trail starts after the assayer set off, fixes are dropped as noise, and every rule here
   * rounds downward. 0.6 means "we saw less than 60% of the claimed distance despite watching
   * most of the window" — a gap too large to be explained by conservative measurement alone.
   */
  shortfallRatio?: number;
}

const ASSESS_DEFAULTS: Required<Pick<AssessOptions, 'minCoverageForComparison' | 'shortfallRatio'>> = {
  minCoverageForComparison: 0.7,
  shortfallRatio: 0.6,
};

const km = (n: number) => `${n.toFixed(1)} km`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Assess a window of fixes against an optionally-claimed distance. */
export function assessTravel(
  fixes: TrackFix[],
  windowStart: Date,
  windowEnd: Date,
  expectedDistanceKm: number | null,
  options: AssessOptions = {},
): TravelAssessment {
  const opt = { ...ASSESS_DEFAULTS, ...options };
  const track = summariseTrack(fixes, windowStart, windowEnd, options);
  const expected =
    expectedDistanceKm != null && Number.isFinite(expectedDistanceKm) && expectedDistanceKm > 0
      ? expectedDistanceKm
      : null;
  const observedRatio = expected ? round(track.observedDistanceKm / expected, 3) : null;

  const base = { track, expectedDistanceKm: expected, observedRatio };

  // Checked before coverage: a trail containing mocked fixes or teleports is not a thin record,
  // it is a questionable one, and thinness must not be allowed to excuse it.
  if (track.mockedFixCount > 0) {
    return {
      ...base,
      verdict: 'IMPLAUSIBLE',
      summary:
        `${track.mockedFixCount} of ${track.fixCount} positions were reported by a mock location ` +
        `provider. Confirm the device before using this trail as evidence either way.`,
    };
  }
  if (track.segmentsImplausible > 0) {
    const speedLimit = options.maxPlausibleSpeedKmh ?? DEFAULTS.maxPlausibleSpeedKmh;
    return {
      ...base,
      verdict: 'IMPLAUSIBLE',
      summary:
        `${track.segmentsImplausible} jump(s) in the trail exceed ${speedLimit} km/h ` +
        `and were excluded. This is usually poor signal, but it can also mean the position was set by hand.`,
    };
  }

  if (track.fixCount === 0) {
    return {
      ...base,
      verdict: 'NO_DATA',
      summary:
        options.trackingEnabled === false
          ? 'Location sharing was switched off for this assayer, so no journey was recorded. That ' +
            'is a gap in the record, not evidence about the travel.'
          : 'No positions were recorded in this window, so the journey can be neither confirmed nor ' +
            'contradicted. Check whether location sharing was on, and whether the handset had signal.',
    };
  }

  if (track.coverage < opt.minCoverageForComparison) {
    return {
      ...base,
      verdict: 'INSUFFICIENT_COVERAGE',
      summary:
        `Only ${pct(track.coverage)} of the window was observed (longest gap ` +
        `${track.longestGapMinutes} min), so ${km(track.observedDistanceKm)} is a minimum, not a measurement. ` +
        'Not evidence against the claim.',
    };
  }

  if (expected && observedRatio != null && observedRatio < opt.shortfallRatio) {
    return {
      ...base,
      verdict: 'SHORTFALL',
      summary:
        `${pct(track.coverage)} of the window was observed and the movement recorded was ` +
        `${km(track.observedDistanceKm)} against ${km(expected)} claimed. Worth asking the assayer about.`,
    };
  }

  return {
    ...base,
    verdict: 'CONSISTENT',
    summary: expected
      ? `${km(track.observedDistanceKm)} of movement recorded against ${km(expected)} claimed, ` +
        `with ${pct(track.coverage)} of the window observed.`
      : `${km(track.observedDistanceKm)} of movement recorded, with ${pct(track.coverage)} of the window observed.`,
  };
}
