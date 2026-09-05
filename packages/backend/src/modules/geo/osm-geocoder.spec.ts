import { verifyCandidate, PRECISION_METERS, politely } from './osm-geocoder';
import { isPlausibleIndianCoord, needsBetterFix, resolveCoordinates } from './coordinate-resolution';

/**
 * These guard the part of free geocoding that decides whether an answer is believable.
 *
 * The providers themselves are network calls and are not exercised here. What is exercised is
 * everything that stands between a provider's confident reply and the database — because on
 * this data the failure mode is never "no answer", it is "a precise-looking wrong answer". A
 * first cut of this geocoder returned a massage centre as one branch, a Lenovo showroom as
 * another, and the same Besant Nagar bank for two branches 9 km apart, each stamped ±10 m.
 */
describe('verifyCandidate', () => {
  const pune = { lat: 18.5204, lng: 73.8567 };
  const anchor = { coord: pune, kind: 'pincode' as const };

  it('accepts a point near its anchor in the claimed state', () => {
    expect(verifyCandidate({ coord: { lat: 18.56, lng: 73.79 }, state: 'Maharashtra' }, 'Maharashtra', anchor)).toBe(true);
  });

  it('rejects a point outside India', () => {
    // Nominatim will happily return the Salem in Oregon for an Indian "Salem".
    expect(verifyCandidate({ coord: { lat: 44.94, lng: -123.03 } }, 'Tamil Nadu', null)).toBe(false);
  });

  it('rejects the null island', () => {
    // 0,0 is what a provider returns when it has nothing, and it is in the Gulf of Guinea.
    expect(verifyCandidate({ coord: { lat: 0, lng: 0 } }, null, null)).toBe(false);
  });

  it('rejects a result whose state contradicts the record', () => {
    expect(verifyCandidate({ coord: pune, state: 'Karnataka' }, 'Maharashtra', null)).toBe(false);
  });

  it('does not treat an unnamed state as a contradiction', () => {
    // Overpass returns no state at all. Absent is unknown, not a mismatch — otherwise the whole
    // POI tier, which is the only one that reaches 10 m, would reject everything it found.
    expect(verifyCandidate({ coord: pune, state: null }, 'Maharashtra', null)).toBe(true);
  });

  it('rejects a same-named place far from a pincode anchor', () => {
    // This is the Pollachi case: a road near Coimbatore named after a town 40 km away.
    const eachanari = { lat: 10.9177, lng: 76.9863 };
    const pollachiPin = { coord: { lat: 10.6617, lng: 77.008 }, kind: 'pincode' as const };
    expect(verifyCandidate({ coord: eachanari, state: 'Tamil Nadu' }, 'Tamil Nadu', pollachiPin)).toBe(false);
  });

  it('allows a wider spread around a district anchor than a pincode one', () => {
    // Indian districts are large; the district bound exists to catch another state, not to
    // second-guess a real address 30 km from the district HQ.
    const thirtyKmNorth = { lat: 18.79, lng: 73.8567 };
    expect(verifyCandidate({ coord: thirtyKmNorth }, null, { coord: pune, kind: 'pincode' })).toBe(false);
    expect(verifyCandidate({ coord: thirtyKmNorth }, null, { coord: pune, kind: 'district' })).toBe(true);
  });
});

describe('isPlausibleIndianCoord', () => {
  it('accepts a real Indian coordinate', () => {
    expect(isPlausibleIndianCoord(18.5204, 73.8567)).toBe(true);
  });

  it('rejects a transposed pair', () => {
    // 73.85, 18.52 — the single most common hand-entry mistake. Longitude 18 is off Africa.
    expect(isPlausibleIndianCoord(73.8567, 18.5204)).toBe(false);
  });

  it('rejects nulls, blanks and 0,0', () => {
    expect(isPlausibleIndianCoord(null, null)).toBe(false);
    expect(isPlausibleIndianCoord('', '')).toBe(false);
    expect(isPlausibleIndianCoord(0, 0)).toBe(false);
  });
});

describe('needsBetterFix', () => {
  it('flags a district or state centroid as needing a real fix', () => {
    expect(needsBetterFix('locality', PRECISION_METERS.locality)).toBe(true);
    expect(needsBetterFix('none', PRECISION_METERS.none)).toBe(true);
  });

  it('flags a coordinate with no recorded provenance', () => {
    // Every row predating the precision columns. Unknown provenance is not the same as good.
    expect(needsBetterFix(null, null)).toBe(true);
  });

  it('accepts a pincode-level fix or better', () => {
    expect(needsBetterFix('pincode', PRECISION_METERS.pincode)).toBe(false);
    expect(needsBetterFix('osm_locality', PRECISION_METERS.osm_locality)).toBe(false);
    expect(needsBetterFix('osm_poi', PRECISION_METERS.osm_poi)).toBe(false);
  });

  it('never asks to re-resolve a hand-placed pin', () => {
    expect(needsBetterFix('manual', PRECISION_METERS.manual)).toBe(false);
  });
});

describe('resolveCoordinates', () => {
  /**
   * The rule with the most to lose if it drifts. A backfill or a re-imported client file that
   * overwrites hand-placed pins destroys the only genuinely precise data in the table, quietly,
   * and specifically the records somebody cared enough to fix.
   */
  it('leaves a manually pinned record alone', async () => {
    const result = await resolveCoordinates(
      { address: 'somewhere else entirely', city: 'Pune', state: 'Maharashtra' },
      { geoSource: 'manual', latitude: 18.5204, longitude: 73.8567 },
    );
    expect(result).toBeNull();
  });

  it('leaves a manual pin alone even when an import supplies coordinates', async () => {
    // Re-uploading the client's original branch list is exactly when this would happen.
    const result = await resolveCoordinates(
      { suppliedLat: 19.076, suppliedLng: 72.877, suppliedIsManual: false },
      { geoSource: 'manual', latitude: 18.5204, longitude: 73.8567 },
    );
    expect(result).toBeNull();
  });

  it('lets a person replace their own earlier pin', async () => {
    const result = await resolveCoordinates(
      { suppliedLat: 19.076, suppliedLng: 72.877, suppliedIsManual: true },
      { geoSource: 'manual', latitude: 18.5204, longitude: 73.8567 },
    );
    expect(result?.geoSource).toBe('manual');
    expect(result?.latitude).toBe(19.076);
  });

  it('marks a hand-placed coordinate manual and exact', async () => {
    const result = await resolveCoordinates({
      suppliedLat: 18.520430, suppliedLng: 73.856744, suppliedIsManual: true,
    });
    expect(result).toMatchObject({
      geoSource: 'manual',
      geoAccuracyMeters: PRECISION_METERS.manual,
      latitude: 18.520430,
      longitude: 73.856744,
    });
    // The geometry column has to travel with the columns, or the map and every PostGIS
    // distance query keep reading the old point.
    expect(result?.location).toEqual({ type: 'Point', coordinates: [73.856744, 18.520430] });
  });

  it('ignores a supplied pair that is not a coordinate in India', async () => {
    // A transposed pair must fall through to geocoding, not be stored as gospel. `precise:false`
    // keeps this test off the network — it exercises the branch, not the providers.
    const result = await resolveCoordinates({
      suppliedLat: 73.8567, suppliedLng: 18.5204, suppliedIsManual: true,
      city: 'Pune', district: 'Pune', state: 'Maharashtra', precise: false,
    });
    expect(result?.geoSource).not.toBe('manual');
  });
});

/**
 * Whether lookups queue or overlap is the difference between an import that lands on the map in a
 * minute and one that trickles in over twenty.
 *
 * The public providers ask for about one request per second, so `politely` chains them: two
 * concurrent callers that each merely waited would still fire together, which is the burst the
 * policy forbids. A self-hosted Nominatim has no such rule — `NOMINATIM_MIN_INTERVAL_MS` is
 * already 0 for it — but it inherited the chain anyway, so every geocode in the process queued
 * behind every other one. Measured at ~0.23s a call, placing 1,155 people meant ~20 minutes of
 * pure queueing against a server answering in milliseconds.
 */
describe('politely — how lookups are scheduled per host', () => {
  const original = process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS;

  // `politely` short-circuits to `fn` when the network is off, which would bypass the scheduling
  // this describes. The fakes below make no requests, so switching the gate on is safe here.
  beforeAll(() => { process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS = 'true'; });
  afterAll(() => { process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS = original; });

  /** Records the highest number of calls that were ever in flight together. */
  const overlapProbe = () => {
    const state = { inFlight: 0, peak: 0 };
    const call = async () => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight -= 1;
    };
    return { state, call };
  };

  it('runs several at once against a host with no rate limit', async () => {
    const { state, call } = overlapProbe();
    await Promise.all(Array.from({ length: 6 }, () => politely('self-hosted-test', 0, call)));
    expect(state.peak).toBeGreaterThan(1);
  });

  it('never exceeds the bound, so one machine is not flooded', async () => {
    const { state, call } = overlapProbe();
    await Promise.all(Array.from({ length: 40 }, () => politely('bounded-host-test', 0, call)));
    // The default is 6; the assertion is on the bound existing, not on its exact value.
    expect(state.peak).toBeLessThanOrEqual(6);
    expect(state.inFlight).toBe(0);
  });

  it('still runs one at a time against a rate-limited host', async () => {
    const { state, call } = overlapProbe();
    await Promise.all(Array.from({ length: 3 }, () => politely('rate-limited-test', 1, call)));
    expect(state.peak).toBe(1);
  });

  it('releases a waiting caller when the one ahead of it throws', async () => {
    // A failed lookup that never released its slot would deadlock every later call on the host.
    const boom = politely('failing-host-test', 0, async () => { throw new Error('provider down'); });
    await expect(boom).rejects.toThrow('provider down');
    await expect(politely('failing-host-test', 0, async () => 'ok')).resolves.toBe('ok');
  });
});
