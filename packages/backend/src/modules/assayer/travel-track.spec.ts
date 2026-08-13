import { summariseTrack, assessTravel, TrackFix } from './travel-track';

/**
 * These rules decide whether somebody gets accused of overclaiming travel, so the cases below are
 * written around the ways that judgement can be *wrong about an honest person*, not just the ways
 * it catches a dishonest one. The field reality this has to survive: rural signal, bank basements,
 * handsets that die, and a per-kilometre allowance that is a meaningful part of the pay.
 */

const T0 = new Date('2026-08-13T04:00:00.000Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** A fix builder. Defaults to a good open-sky accuracy so tests opt in to imprecision. */
const fix = (minutes: number, lat: number, lng: number, over: Partial<TrackFix> = {}): TrackFix => ({
  latitude: lat,
  longitude: lng,
  accuracyMeters: 20,
  recordedAt: at(minutes),
  ...over,
});

/**
 * A straight run north from Thrissur. One degree of latitude is ~111 km, so 0.009deg is ~1 km.
 */
const leg = (i: number) => 10.5 + i * 0.009;

/**
 * A realistic well-observed drive: 45 minutes at roughly 60 km/h, sampled once a minute.
 *
 * The sampling rate matters to the result and is not incidental. The field app fixes every 30 s,
 * and the module treats silence longer than five minutes as time it cannot speak for — because it
 * genuinely cannot: between two fixes a quarter of an hour apart the assayer could have gone
 * anywhere, so counting that span as "observed" would be the module asserting more than it knows.
 */
const drive = () => Array.from({ length: 46 }, (_, i) => fix(i, leg(i), 76.2));

describe('summariseTrack', () => {
  it('measures a clean journey as the sum of its legs', () => {
    const t = summariseTrack(drive(), at(0), at(45));

    // 45 legs of ~1 km.
    expect(t.observedDistanceKm).toBeGreaterThan(44);
    expect(t.observedDistanceKm).toBeLessThan(46);
    expect(t.fixCount).toBe(46);
    expect(t.usableFixCount).toBe(46);
    expect(t.coverage).toBe(1);
    expect(t.segmentsImplausible).toBe(0);
  });

  /**
   * Sparse sampling is not the same as a measured route, and the module says so rather than
   * joining the dots. This is what keeps a battery-saving ping interval from being read as
   * confident evidence about the path taken between fixes.
   */
  it('treats widely-spaced fixes as unobserved time rather than a measured route', () => {
    const sparse = [0, 15, 30, 45].map((m, i) => fix(m, 10.5 + i * 0.09, 76.2));

    const t = summariseTrack(sparse, at(0), at(45));

    expect(t.coverage).toBeLessThan(0.2);
  });

  /**
   * The failure that would quietly manufacture kilometres: a phone sitting still on a desk all
   * afternoon still reports a slightly different position every fix. Summed naively, a stationary
   * assayer "travels" — and the number would support a claim rather than test it.
   */
  it('does not turn a stationary handset jittering into distance', () => {
    const fixes = Array.from({ length: 60 }, (_, i) =>
      fix(i, 10.5 + (i % 2 ? 0.00012 : -0.00012), 76.2 + (i % 3 ? 0.0001 : -0.0001), {
        accuracyMeters: 30,
      }),
    );

    const t = summariseTrack(fixes, at(0), at(59));

    expect(t.observedDistanceKm).toBe(0);
    expect(t.segmentsWithinNoise).toBeGreaterThan(50);
    // It was watching the whole time — it simply saw no movement.
    expect(t.coverage).toBe(1);
  });

  it('reports a gap honestly instead of interpolating across it', () => {
    // Fixes for the first 5 minutes, then silence, then the last 5 of a 60-minute window.
    const fixes = [fix(0, leg(0), 76.2), fix(5, leg(1), 76.2), fix(55, leg(2), 76.2), fix(60, leg(3), 76.2)];

    const t = summariseTrack(fixes, at(0), at(60));

    expect(t.longestGapMinutes).toBe(50);
    // 50 unobserved minutes out of 60.
    expect(t.coverage).toBeCloseTo(1 - 50 / 60, 2);
  });

  it('counts time before the first fix and after the last against coverage', () => {
    // Device only switched on for the final two minutes of a two-hour window.
    const fixes = [fix(118, leg(0), 76.2), fix(120, leg(1), 76.2)];

    const t = summariseTrack(fixes, at(0), at(120));

    // Without this, a device switched on at the destination would claim perfect coverage.
    expect(t.coverage).toBeLessThan(0.05);
  });

  it('excludes a teleport rather than counting it as travel', () => {
    // A 10 km leg, then a jump to ~1100 km away one minute later.
    const fixes = [fix(0, 10.5, 76.2), fix(10, leg(1), 76.2), fix(11, 20.5, 76.2)];

    const t = summariseTrack(fixes, at(0), at(11));

    expect(t.segmentsImplausible).toBe(1);
    // The impossible leg contributed nothing — inflation is the dangerous direction.
    expect(t.observedDistanceKm).toBeLessThan(15);
  });

  it('treats two different places at the same instant as a contradiction, not a journey', () => {
    const fixes = [fix(0, 10.5, 76.2), fix(0, 11.5, 76.2)];

    const t = summariseTrack(fixes, at(0), at(30));

    expect(t.segmentsImplausible).toBe(1);
    expect(t.observedDistanceKm).toBe(0);
  });

  it('will not build distance out of fixes too imprecise to mean anything', () => {
    // 2 km-accurate cell-tower fixes: "somewhere in this town", not a measured position.
    const fixes = [0, 2, 4].map((m, i) => fix(m, 10.5 + i * 0.09, 76.2, { accuracyMeters: 2000 }));

    const t = summariseTrack(fixes, at(0), at(4));

    expect(t.usableFixCount).toBe(0);
    expect(t.observedDistanceKm).toBe(0);
    // They still prove the handset was on and reporting, so coverage is unaffected.
    expect(t.coverage).toBe(1);
    expect(t.fixCount).toBe(3);
  });

  it('sorts fixes that arrive out of order after an offline spell', () => {
    const inOrder = drive();
    const shuffled = [...inOrder].reverse();

    expect(summariseTrack(shuffled, at(0), at(45)).observedDistanceKm).toBe(
      summariseTrack(inOrder, at(0), at(45)).observedDistanceKm,
    );
  });

  it('returns an empty summary, not an error, for a window with no fixes', () => {
    const t = summariseTrack([], at(0), at(60));

    expect(t.fixCount).toBe(0);
    expect(t.observedDistanceKm).toBe(0);
    expect(t.coverage).toBe(0);
    expect(t.firstFixAt).toBeNull();
  });
});

describe('assessTravel', () => {
  const goodJourney = drive;

  it('confirms a well-observed journey that matches the claim', () => {
    const a = assessTravel(goodJourney(), at(0), at(45), 45);

    expect(a.verdict).toBe('CONSISTENT');
    expect(a.observedRatio).toBeGreaterThan(0.9);
  });

  it('raises a shortfall only when the window was well observed', () => {
    // Watched throughout, ~45 km of movement, but 200 km claimed.
    const a = assessTravel(goodJourney(), at(0), at(45), 200);

    expect(a.verdict).toBe('SHORTFALL');
    expect(a.summary).toContain('Worth asking');
  });

  /**
   * The most important test here. An honest assayer whose phone lost signal for most of the drive
   * must never be reported as having fallen short — the system saw too little to say so. This is
   * the difference between a tool that finds fraud and one that manufactures accusations.
   */
  it('never calls a shortfall on a patchy trail, however small the observed distance', () => {
    const fixes = [fix(0, 10.5, 76.2), fix(2, 10.52, 76.2), fix(118, 10.54, 76.2), fix(120, 10.56, 76.2)];

    const a = assessTravel(fixes, at(0), at(120), 200);

    expect(a.verdict).toBe('INSUFFICIENT_COVERAGE');
    expect(a.verdict).not.toBe('SHORTFALL');
    expect(a.summary).toContain('minimum, not a measurement');
    expect(a.summary).toContain('Not evidence against the claim');
  });

  it('says nothing either way when there is no trail at all', () => {
    const a = assessTravel([], at(0), at(120), 200);

    expect(a.verdict).toBe('NO_DATA');
    expect(a.summary).toContain('neither confirmed nor contradicted');
  });

  it('flags a mocked position above every other consideration', () => {
    // Thin AND mocked: thinness must not be allowed to excuse the mock provider.
    const fixes = [fix(0, 10.5, 76.2, { isMocked: true }), fix(119, 10.9, 76.2)];

    const a = assessTravel(fixes, at(0), at(120), 50);

    expect(a.verdict).toBe('IMPLAUSIBLE');
    expect(a.summary).toContain('mock location provider');
  });

  it('flags an impossible jump even when the distance would otherwise satisfy the claim', () => {
    const fixes = [fix(0, 10.5, 76.2), fix(1, 20.5, 76.2), fix(2, 20.6, 76.2)];

    const a = assessTravel(fixes, at(0), at(2), 5);

    expect(a.verdict).toBe('IMPLAUSIBLE');
  });

  it('still reports a journey when no claimed distance is supplied', () => {
    const a = assessTravel(goodJourney(), at(0), at(45), null);

    expect(a.verdict).toBe('CONSISTENT');
    expect(a.expectedDistanceKm).toBeNull();
    expect(a.observedRatio).toBeNull();
    expect(a.summary).toContain('of movement recorded');
  });

  /**
   * Every rule in the module rounds downward — the trail starts late, jitter is discarded, jumps
   * are dropped. A journey therefore measures short by design, and the shortfall threshold has to
   * leave room for that or honest claims trip it.
   */
  it('tolerates conservative under-measurement without crying shortfall', () => {
    // ~45 km observed against 60 km claimed: 75%, short but explainable.
    const a = assessTravel(goodJourney(), at(0), at(45), 60);

    expect(a.verdict).toBe('CONSISTENT');
  });

  it('does not withhold anything — the verdict set contains no payment decision', () => {
    const verdicts = [
      assessTravel([], at(0), at(60), 100).verdict,
      assessTravel(goodJourney(), at(0), at(45), 500).verdict,
      assessTravel([fix(0, 10.5, 76.2, { isMocked: true })], at(0), at(60), 10).verdict,
    ];

    // Nothing in the vocabulary asserts fraud or denies pay; each is a finding for a human.
    for (const v of verdicts) {
      expect(['NO_DATA', 'INSUFFICIENT_COVERAGE', 'CONSISTENT', 'SHORTFALL', 'IMPLAUSIBLE']).toContain(v);
    }
  });
});
