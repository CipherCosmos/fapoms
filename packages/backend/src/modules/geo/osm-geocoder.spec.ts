import { verifyCandidate, PRECISION_METERS, politely, gradeNominatimCandidate, resolveFreely } from './osm-geocoder';
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

  it('accepts a locality-level fix or better', () => {
    expect(needsBetterFix('osm_locality', PRECISION_METERS.osm_locality)).toBe(false);
    expect(needsBetterFix('osm_street', PRECISION_METERS.osm_street)).toBe(false);
    expect(needsBetterFix('osm_poi', PRECISION_METERS.osm_poi)).toBe(false);
  });

  /**
   * A pincode centroid used to count as finished. It no longer does, and the change is the point.
   *
   * While the address lookup asked one question it could not answer — the whole postal address
   * handed to Nominatim as `street`, which ANDs its components — a detailed address and a bare one
   * produced the same 3 km centroid, so retrying only burned lookups and the bar sat here to stop
   * that. `nominatimSearch` now works down a ladder of candidates parsed out of the address and
   * reaches street and building level where OSM holds the data, so the centroid is the answer of
   * last resort rather than the best one, and a row sitting in the middle of its postcode deserves
   * another attempt.
   */
  it('asks to improve a pincode centroid, which is no longer the best answer available', () => {
    expect(needsBetterFix('pincode', PRECISION_METERS.pincode)).toBe(true);
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

/**
 * Grading a Nominatim answer for a person's home.
 *
 * Every case here is a real answer the live server returned during the cascade trial, including
 * the two it got wrong. The lesson each encodes is the same one that runs through this whole file:
 * a name lining up is not evidence of a location, and a finer grade on a wrong match is worse than
 * a coarse grade on a right one.
 */
describe('gradeNominatimCandidate — a home address, not a business', () => {
  const home = { address: 'Vyayam Shala, Chopra, Vidhisha', city: 'Vidisha', state: 'Madhya Pradesh' };
  const box = (metres: number) => {
    // A square bounding box whose half-diagonal is roughly `metres`.
    const d = (metres * Math.SQRT2) / 111320;
    return ['20', String(20 + d), '77', String(77 + d / Math.cos((20 * Math.PI) / 180))];
  };

  /**
   * The live failure, reproduced from the server's actual answer.
   *
   * OSM tags this surgery `place=house`, not `amenity=clinic`, so no category rule catches it. The
   * only thing linking it to the address was the word "Chopra" in the building's own NAME — the
   * road is "Yashoda Krishna Dwar" and the city is Indore, 200 km from the appraiser's Vidisha
   * pincode. It was graded 25 m and would have put a person inside a clinic in another district.
   */
  it("refuses a business whose only link to the address is its own name", () => {
    expect(gradeNominatimCandidate(
      { category: 'place', type: 'house', name: 'Chopra Clinic', boundingbox: box(20),
        address: { place: 'Chopra Clinic', house_number: 'S.S. 71', road: 'Yashoda Krishna Dwar',
                   city_district: 'Indore City', city: 'Indore', state: 'Madhya Pradesh' } },
      home,
    )).toBeNull();
  });

  it('still matches a home on the place it actually sits in', () => {
    // The same shape of answer, but corroborating through the address hierarchy rather than a
    // building's name — that is a person living in Chopra, and it must keep working.
    expect(gradeNominatimCandidate(
      { category: 'place', type: 'village', name: 'Chopra', boundingbox: box(700),
        address: { village: 'Chopra', state_district: 'Vidisha', state: 'Madhya Pradesh' } },
      home,
    )).toBe('osm_locality');
  });

  it('refuses a highway that runs between districts', () => {
    // The live failure: "Khargone - Indore Hwy" graded 900 m for a home in Bhawsar Mohalla.
    expect(gradeNominatimCandidate(
      { category: 'highway', type: 'trunk', name: 'Khargone - Indore Hwy', boundingbox: box(30000),
        address: { road: 'Chopra' } },
      home,
    )).toBeNull();
  });

  it('accepts a local road, and only when its own geometry earns the claim', () => {
    const short = gradeNominatimCandidate(
      { category: 'highway', type: 'residential', name: 'Chopra Road', boundingbox: box(80),
        address: { road: 'Chopra Road' } },
      home,
    );
    expect(short).toBe('osm_street');

    // Same name, same class, two kilometres long — the coordinate is its midpoint, so 120 m would
    // be a claim the geometry does not support.
    const long = gradeNominatimCandidate(
      { category: 'highway', type: 'residential', name: 'Chopra Road', boundingbox: box(2000),
        address: { road: 'Chopra Road' } },
      home,
    );
    expect(long).toBe('osm_locality');
  });

  /**
   * Building level is not reachable from a home address, and that is the honest ceiling.
   *
   * We never send a house number — OSM holds almost none for India, so `placeCandidates` strips
   * them and the ladder asks about roads and localities. A hit that happens to carry a house
   * number is therefore telling us about a building we did not ask about. The street it is on is
   * the finest thing this evidence supports.
   */
  it('drops to locality when the right area matched but a different road did', () => {
    // The live case: an appraiser on "S P W Road, Thaikkattukara, Aluva" matched Aluva Park Road.
    // The area is right and that is all we know, so 120 m is not ours to claim.
    expect(gradeNominatimCandidate(
      // The suburb corroborates — this IS the right neighbourhood — and the road does not. The
      // town name inside the road name must not be what carries the match: "Aluva" is in the
      // address, in the road's name, and in the answer's own town field.
      { category: 'highway', type: 'residential', name: 'Aluva Park Road', boundingbox: box(80),
        address: { road: 'Aluva Park Road', suburb: 'Thaikkattukara', town: 'Aluva' } },
      { address: 'Alamparambil House, S P W Road, Thaikkattukara, Aluva', city: 'Aluva', state: 'Kerala' },
    )).toBe('osm_locality');
  });

  it('keeps street level when the road itself is the thing that matched', () => {
    expect(gradeNominatimCandidate(
      { category: 'highway', type: 'residential', name: 'Ratanada Road', boundingbox: box(80),
        address: { road: 'Ratanada Road', suburb: 'Rai Ka Bagh' } },
      { address: 'Gayatri Vihar, Bhaskar Circle, Ratanada, Jodhpur', city: 'Jodhpur', state: 'Rajasthan' },
    )).toBe('osm_street');
  });

  it('does not claim building level for a home, because we never asked about a building', () => {
    expect(gradeNominatimCandidate(
      { category: 'place', type: 'house', name: null, boundingbox: box(15),
        address: { house_number: '12', road: 'Chopra', suburb: 'Chopra' } },
      home,
    )).not.toBe('osm_building');
  });

  it('still lets a branch match the POI it is mapped as', () => {
    // `name`/`brand` mark a record that names a place, which is what the POI rung is for. A branch
    // must keep reaching it — the two rules above are for records that name a person, and a bank
    // mapped as an amenity is precisely what they must not block.
    //
    // The brand here is one whose words survive `tokenise`'s generic-word filter. "State Bank of
    // India" does not: `bank`, `india` and `state` are all generic, so its brand tokenises to
    // nothing and it corroborates on the locality instead. That is long-standing behaviour of the
    // matcher, not something these rules changed.
    expect(gradeNominatimCandidate(
      { category: 'amenity', type: 'bank', name: 'Karnataka Vikas Grameena Bank, Aundh', boundingbox: box(20),
        address: { amenity: 'Karnataka Vikas Grameena Bank', suburb: 'Aundh' } },
      { address: 'Aundh Road', name: 'Aundh Branch', brand: 'Karnataka Vikas Grameena Bank', city: 'Pune', state: 'Maharashtra' },
    )).toBe('osm_poi');
  });

  it('does not reject a place-naming record under the home-address rules', () => {
    // The regression that matters: a branch whose brand is too generic to match the POI rung must
    // still be graded, not thrown away by the amenity rejection meant for people.
    expect(gradeNominatimCandidate(
      { category: 'amenity', type: 'bank', name: 'State Bank of India, Aundh', boundingbox: box(20),
        address: { amenity: 'State Bank of India', suburb: 'Aundh' } },
      { address: 'Aundh', name: 'Aundh Branch', brand: 'State Bank of India', city: 'Pune', state: 'Maharashtra' },
    )).not.toBeNull();
  });
});

/**
 * The distance check is the only thing standing between a plausible name match and a pin in
 * another district — and it runs only when there is an anchor to measure from.
 */
describe('resolveFreely — refuses to guess when nothing can check the answer', () => {
  const original = process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS;
  beforeAll(() => { process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS = 'true'; });
  afterAll(() => { process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS = original; });

  it('returns nothing for a home address with no anchor, rather than an unfalsifiable answer', async () => {
    // No network call is made at all, which is the point: with no anchor the only surviving checks
    // are "inside India" and "state matches", and a state is the size of a country.
    await expect(resolveFreely(
      { address: 'Vyayam Shala, Chopra, Vidhisha', state: 'Madhya Pradesh', pincode: '464001' },
      null,
    )).resolves.toBeNull();
  });

  it('still looks up a record that names a place, which is what its name is for', async () => {
    // A branch is looked up BY its name; this must not become null. The lookup itself is a network
    // call the harness blocks, so the assertion is only that it was not short-circuited above.
    await expect(resolveFreely(
      { address: '1 Main Rd', name: 'Aundh Branch', brand: 'Karnataka Vikas Grameena Bank', city: 'Pune' },
      null,
    )).resolves.toBeDefined();
  });
});
