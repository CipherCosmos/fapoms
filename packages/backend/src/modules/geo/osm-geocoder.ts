/**
 * FAPOMS — Free (no-API-key) Indian geocoding, ordered by precision.
 *
 * ## Why this exists
 *
 * Every geocode in the platform ran through Google, which returns null without
 * `GOOGLE_MAPS_API_KEY`. With no key the chain fell straight to the postal/centroid tiers, and
 * the result was visible in the data: 40 of 82 branches sat on a *shared* coordinate — eight
 * Pune branches all at exactly 18.5204, 73.8567 (the city centroid), and two branches in two
 * different Telangana districts on the same state-level point ~100 km from either.
 *
 * That is not a cosmetic problem. Those coordinates are what the assayer-matching radius, the
 * travel-cost calculation, the day-plan clustering and the "no assayer within serviceable
 * range" flag all read. A branch pinned 100 km from where it is gets matched to the wrong
 * people at the wrong price, and nothing on screen says so.
 *
 * ## What precision is actually achievable for free
 *
 * 5–10 m means "the actual building". Free sources reach that ONLY where somebody has mapped
 * that building in OpenStreetMap. For Indian bank branches that is common in cities and rare in
 * villages, so this is a chain, not a single answer:
 *
 *   1. `osm_poi`      ~10 m   — the branch itself, mapped in OSM as amenity=bank/atm/office
 *   2. `osm_building` ~25 m   — a mapped building/house-number at the address
 *   3. `osm_street`   ~120 m  — the road the address names
 *   4. `osm_locality` ~900 m  — the suburb/neighbourhood
 *   5. `pincode`      ~3 km   — India Post post-office centroid (existing tier)
 *   6. `locality`     ~15 km  — static district-HQ centroid (existing tier)
 *   7. `none`         ~100 km — state centroid, i.e. "we do not know" (existing tier)
 *
 * Tiers 1–4 are new and free. Nothing here can *guarantee* 10 m, so the honest design is to
 * report the tier that was actually used and let ops correct what matters — see
 * `GeoPrecision` and the manual-pin path, which is the only way to reach 5 m for certain.
 *
 * ## Wrong answers are worse than vague ones
 *
 * Indian place names repeat heavily — Salem, Hyderabad, Aurangabad, Rampur — across states and
 * across countries. Nominatim and Photon will confidently return the wrong one. Every candidate
 * is therefore gated by `verifyCandidate`: inside India, matching the claimed state, and within
 * a plausible distance of an anchor we already trust (the pincode centroid, else the district
 * centroid). A rejected candidate falls through to the next tier rather than being returned.
 *
 * ## Politeness
 *
 * Nominatim's usage policy is a hard 1 request/second with an identifying User-Agent; Photon
 * and Overpass ask for restraint. `politely()` serialises per host and spaces the calls. That
 * makes the precise chain unsuitable for a 400-row import loop, which is why callers choose:
 * interactive single-record writes resolve precisely, bulk imports take the fast tiers and are
 * upgraded afterwards by the backfill.
 */

import * as path from 'path';
import { calculateHaversineDistance } from '@fapoms/shared';
import { JsonFileCache } from './geo-cache-store';
import { placeCandidates } from './indian-address';

/**
 * Nominatim endpoint, configurable so a deployment can point at a SELF-HOSTED instance instead of
 * the public server. Set `NOMINATIM_URL` (e.g. http://nominatim:8080) to your own instance — it
 * has no 1-request-per-second usage policy, so the politeness delay is dropped for it and the
 * whole roster geocodes at full speed. Left unset, it uses the public server at the public rate.
 */
const NOMINATIM_BASE_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const NOMINATIM_IS_SELF_HOSTED = !!process.env.NOMINATIM_URL && !/nominatim\.openstreetmap\.org/i.test(process.env.NOMINATIM_URL);
// Public Nominatim's policy is an absolute max of 1 request/second, per IP. A self-hosted one has
// no such limit, so we only queue behind it a token amount to avoid hammering a single connection.
const NOMINATIM_MIN_INTERVAL_MS = NOMINATIM_IS_SELF_HOSTED ? 0 : 1100;

export interface Coord {
  lat: number;
  lng: number;
}

/**
 * How the coordinate was obtained, most precise first. Persisted on the row, so the map and
 * every downstream distance decision can tell a front-door pin from a state centroid.
 */
export type GeoPrecision =
  | 'manual'
  | 'geocoder'
  | 'osm_poi'
  | 'osm_building'
  | 'osm_street'
  | 'osm_locality'
  | 'pincode'
  | 'locality'
  | 'none';

/** Nominal accuracy per tier, in metres. Deliberately pessimistic — see the note on 5–10 m. */
export const PRECISION_METERS: Record<GeoPrecision, number> = {
  manual: 5,
  geocoder: 60,
  osm_poi: 10,
  osm_building: 25,
  osm_street: 120,
  osm_locality: 900,
  pincode: 3000,
  locality: 15000,
  none: 100000,
};

export interface OsmGeocodeResult extends Coord {
  accuracyMeters: number;
  precision: GeoPrecision;
  /** What matched, for the audit trail and for ops deciding whether to trust it. */
  matchedName?: string;
}

export interface AddressParts {
  address?: string | null;
  /** The branch/assayer's own name. The single most useful signal for an OSM POI match. */
  name?: string | null;
  /** Client/brand name, e.g. "State Bank of India" — mapped POIs carry the brand, not our code. */
  brand?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pincode?: string | null;
}

// ---------------------------------------------------------------------------
// Cache — one lookup paid, every later record in the same place free
// ---------------------------------------------------------------------------

/**
 * Separate from the legacy `geocoding-cache.json`, which stores bare `{lat,lng}` and therefore
 * cannot remember how precise an entry was. Reusing it would silently promote a 15 km centroid
 * to whatever tier the caller assumed.
 */
/**
 * The debounce this cache already had is now the shared one in geo-cache-store.ts, which the
 * other two geocoding caches were missing entirely. The move also gets the file out of `dist/`:
 * `__dirname/../../infrastructure/database/` resolves inside the build output, which `nest build`
 * never populates and every deploy replaces — so this cache started cold in every container and
 * nothing it learned survived a release.
 */
const cache = new JsonFileCache<OsmGeocodeResult>(
  'osm-geocoding-cache.json',
  path.join(__dirname, '../../infrastructure/database/osm-geocoding-cache.json'),
);

function rememberResult(key: string, value: OsmGeocodeResult): void {
  // Debounced: a backfill resolves hundreds of rows, and writing the whole file per row turns
  // an I/O convenience into the slowest part of the job.
  cache.set(key, value);
}

/** Settle any pending cache write immediately. Kept exported — it is the shutdown escape hatch. */
export function flushCache(): void {
  cache.flush();
}

function cacheKey(kind: string, parts: AddressParts): string {
  return [kind, parts.brand, parts.name, parts.address, parts.city, parts.district, parts.state, parts.pincode]
    .map((p) => (p ?? '').toString().toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|');
}

// ---------------------------------------------------------------------------
// Rate limiting — Nominatim's policy is 1 req/s, and it is enforced by IP ban
// ---------------------------------------------------------------------------

const USER_AGENT =
  process.env.GEOCODER_USER_AGENT ||
  'FAPOMS/1.0 (field-audit operations platform; contact: it@sumeruglobal.in)';

const lastCallAt = new Map<string, number>();
const hostChains = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  t.unref?.();
});

/**
 * How many lookups may be in flight at once against a host with no rate limit — i.e. a
 * self-hosted geocoder. Six is a working default rather than a measured optimum: enough to hide
 * the round trip on a server answering in ~0.2s, small enough that a backfill cannot monopolise
 * the database pool the completed lookups write through. `GEOCODER_CONCURRENCY` overrides it.
 */
const UNTHROTTLED_HOST_CONCURRENCY = Math.max(1, Number(process.env.GEOCODER_CONCURRENCY || 6));

/** In-flight count and the queue of callers waiting for a slot, per host. */
const hostInFlight = new Map<string, number>();
const hostWaiters = new Map<string, Array<() => void>>();

/**
 * Run `fn`, but never more than `limit` at once for this host.
 *
 * The `while` (rather than `if`) re-checks after being woken: a caller arriving synchronously
 * between a release and the woken waiter resuming would otherwise slip past the limit.
 */
async function withHostLimit<T>(host: string, limit: number, fn: () => Promise<T>): Promise<T> {
  while ((hostInFlight.get(host) ?? 0) >= limit) {
    await new Promise<void>((resolve) => {
      const queue = hostWaiters.get(host) ?? [];
      queue.push(resolve);
      hostWaiters.set(host, queue);
    });
  }
  hostInFlight.set(host, (hostInFlight.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    hostInFlight.set(host, Math.max(0, (hostInFlight.get(host) ?? 1) - 1));
    hostWaiters.get(host)?.shift()?.();
  }
}

/**
 * Serialise calls to one host and space them by `minIntervalMs`.
 *
 * Exported only so the spec can exercise the scheduling itself: whether calls chain or overlap is
 * the whole behaviour here, and it is not observable through the provider functions without
 * making real network requests.
 *
 * Chained rather than merely delayed: two concurrent callers that each independently waited
 * would still fire together, which is precisely the burst the policy forbids.
 */
export function politely<T>(host: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  // Nothing to be polite to when the network is off: `getJson` returns null without making a
  // request, so the rate-limit wait is pure delay. It was charged anyway — several seconds per
  // record for specs that create an assayer or branch, which is most of the slow ones.
  if (!networkAllowed()) return fn();

  /**
   * A host with no rate limit is bounded, not chained.
   *
   * The chain below exists to honour the public providers' "about one request per second" rule,
   * and serialising is the only way to keep concurrent callers from bursting past it. A
   * self-hosted Nominatim (`NOMINATIM_URL`) has no such rule — `NOMINATIM_MIN_INTERVAL_MS` is
   * already 0 for it — but it was still inheriting the chain, so every geocode in the process
   * queued behind every other one. A roster import that placed 1,155 people therefore trickled
   * onto the map one address at a time: measured at ~0.23s per call against the self-hosted
   * instance, that is ~20 minutes of pure queueing against a server answering in milliseconds.
   *
   * So when there is no interval to respect, run a bounded number at once instead. Bounded rather
   * than unbounded because the far side is still one machine, and because each in-flight lookup
   * eventually writes a row through the same database pool.
   */
  if (minIntervalMs <= 0) return withHostLimit(host, UNTHROTTLED_HOST_CONCURRENCY, fn);

  const previous = hostChains.get(host) ?? Promise.resolve();
  const next = previous.then(async () => {
    const since = Date.now() - (lastCallAt.get(host) ?? 0);
    if (since < minIntervalMs) await sleep(minIntervalMs - since);
    lastCallAt.set(host, Date.now());
    return fn();
  });
  // Stored without its rejection so one failure cannot poison every later call on this host.
  hostChains.set(host, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Under test, the free tiers are off unless a test asks for them.
 *
 * Not a convenience. `BranchService.create` and `AssayerService.create` resolve precisely, so
 * without this every spec that creates a branch silently becomes a live network test against
 * Nominatim — slow, flaky, dependent on someone else's uptime, and (because the providers rate
 * limit by IP) capable of getting a CI runner banned. Set GEOCODER_ALLOW_NETWORK_IN_TESTS=true
 * in the rare spec that genuinely wants a real lookup.
 */
export function networkAllowed(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.GEOCODER_ALLOW_NETWORK_IN_TESTS === 'true';
}

async function getJson(url: string, timeoutMs = 12000): Promise<any | null> {
  if (!networkAllowed()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Verification — the part that stops a confident wrong answer
// ---------------------------------------------------------------------------

/** Mainland + islands. A result outside this is not in India, whatever the provider claims. */
const INDIA_BBOX = { minLat: 6.4, maxLat: 37.7, minLng: 68.0, maxLng: 97.5 };

function normalisePlace(value?: string | null): string {
  return (value || '')
    .toLowerCase()
    .replace(/\b(urban|rural|district|dist|city|metro|municipality|corporation|municipal|taluk|tehsil)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * How far a candidate may sit from the anchor before we call it a different place.
 *
 * A pincode anchor is a post-office centroid — tight. A district anchor is the district HQ, and
 * Indian districts are large (Kutch is ~250 km across), so the district bound is generous: it is
 * there to catch a same-named place in another state, not to second-guess a real address.
 */
const MAX_KM_FROM_PINCODE_ANCHOR = 12;
const MAX_KM_FROM_DISTRICT_ANCHOR = 60;

export interface VerificationAnchor {
  coord: Coord;
  kind: 'pincode' | 'district';
}

export interface CandidateFacts {
  coord: Coord;
  /** State the provider says the point is in, when it says. */
  state?: string | null;
}

/**
 * True when a candidate coordinate is plausibly the place we asked about.
 *
 * Exported because this is the rule the whole file rests on and it deserves to be tested
 * directly rather than through four providers' response shapes.
 */
export function verifyCandidate(
  candidate: CandidateFacts,
  claimedState: string | null | undefined,
  anchor: VerificationAnchor | null,
): boolean {
  const { lat, lng } = candidate.coord;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // 0,0 is the classic "provider had nothing" answer, and it is in the Gulf of Guinea.
  if (lat === 0 && lng === 0) return false;
  if (lat < INDIA_BBOX.minLat || lat > INDIA_BBOX.maxLat) return false;
  if (lng < INDIA_BBOX.minLng || lng > INDIA_BBOX.maxLng) return false;

  // When the provider names a state and it contradicts the record, this is a different place.
  // Both must be non-empty: an unnamed state is unknown, not a mismatch.
  const claimed = normalisePlace(claimedState);
  const found = normalisePlace(candidate.state);
  if (claimed && found && claimed !== found) return false;

  if (anchor) {
    const km = calculateHaversineDistance(lat, lng, anchor.coord.lat, anchor.coord.lng);
    const limit = anchor.kind === 'pincode' ? MAX_KM_FROM_PINCODE_ANCHOR : MAX_KM_FROM_DISTRICT_ANCHOR;
    if (km > limit) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tier 1 — the branch itself, as a mapped OSM point of interest (~10 m)
// ---------------------------------------------------------------------------

/** OSM amenity values that can plausibly BE a bank branch. */
const POI_VALUES = new Set(['bank', 'atm', 'bureau_de_change']);

/**
 * Words too generic to prove two places are the same.
 *
 * Indian branch addresses are built almost entirely from these — "1ST FLOOR, KUMARAN COMPLEX,
 * NEAR SURIYA HOSPITAL CORNER, ANNUR ROAD" — so matching on any shared word matches everything.
 * `nagar`, `layout` and `colony` are here for the same reason: half the localities in the
 * country end in one.
 */
const GENERIC_TOKENS = new Set([
  'floor', 'first', 'second', 'third', 'ground', 'road', 'street', 'main', 'cross', 'near',
  'opposite', 'building', 'complex', 'tower', 'plaza', 'centre', 'center', 'branch', 'india',
  'bank', 'limited', 'ltd', 'door', 'shop', 'above', 'below', 'behind', 'beside', 'plot',
  'survey', 'east', 'west', 'north', 'south', 'nagar', 'layout', 'colony', 'phase', 'sector',
  'block', 'stage', 'extension', 'town', 'city', 'village', 'post', 'district', 'state', 'pin',
  'no', 'new', 'old', 'sri', 'shri', 'saint', 'temple', 'kovil', 'koil', 'hospital', 'school',
  'college', 'market', 'bus', 'stand', 'station', 'gate', 'circle', 'junction', 'bazaar',
]);

/**
 * Distinctive words in a string: alphabetic, four characters or more, not generic.
 *
 * Four is deliberate — three-letter fragments ("sai", "mth") collide constantly across a
 * country's worth of place names.
 */
function tokenise(...values: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    for (const word of (value || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 4 && !GENERIC_TOKENS.has(word) && !/^\d+$/.test(word)) out.add(word);
    }
  }
  return out;
}

/**
 * The record's own city, district and state, which must never count as evidence.
 *
 * Every address in Chennai contains "Chennai", so matching on it proves only that both places
 * are in the same city — which the anchor already established. Left in, it corroborated a port
 * trust and a dental college as "the branch", each stamped ±25 m. The words are removed from
 * BOTH sides of the comparison, so what remains is the locality: Virugambakkam, Royapuram,
 * Pollachi — the part that actually distinguishes one branch from the next.
 */
function placeNoise(parts: AddressParts): Set<string> {
  return tokenise(parts.city, parts.district, parts.state);
}

function without(tokens: Set<string>, noise: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) if (!noise.has(t)) out.add(t);
  return out;
}

/**
 * Do these two descriptions name the same place?
 *
 * Substring both ways, because OSM and a bank's branch list spell the same locality differently
 * — "MOGAPAIR" vs "Mogappair", "VIRUGUMBAKKOM" vs "Virugambakkam". An exact set intersection
 * misses all of those; a shared distinctive stem catches them.
 */
function corroborates(ours: Set<string>, theirs: Set<string>): boolean {
  for (const a of ours) {
    for (const b of theirs) {
      if (a === b) return true;
      if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true;
    }
  }
  return false;
}

/**
 * What precision a Photon result has EARNED, given what corroborates it.
 *
 * This is the correction for a mistake worth stating plainly: an earlier version mapped
 * `osm_key` straight to a tier, so any shop or office Photon returned became a ±10 m "POI". On
 * real branch data that produced a massage centre for one branch, a Lenovo showroom for
 * another, and — worst — the *same* RBL branch in Besant Nagar for two different branches 9 km
 * away, each labelled ±10 m. A confidently wrong pin is worse than an admitted coarse one: the
 * coarse one is visibly wrong to anyone who looks at the map, and gets fixed.
 *
 * So precision is now evidence, not a type tag:
 *   - POI (10 m)      needs a bank amenity AND a locality that corroborates ours. Being an
 *                     RBL branch is not enough; it has to be an RBL branch in our locality.
 *   - building (25 m) needs a house number on a street we named.
 *   - street (120 m)  needs a road we named.
 *   - locality (900 m) needs the suburb/locality to corroborate — the honest answer for most
 *                     Indian branch addresses, and still 15× better than a district centroid.
 * No corroboration at all returns null, and the caller falls through to the postal tier.
 */
function gradePhotonCandidate(props: any, parts: AddressParts): GeoPrecision | null {
  const noise = placeNoise(parts);
  const ourPlace = without(tokenise(parts.name, parts.address), noise);
  const ourBrand = tokenise(parts.brand);

  const theirPlace = without(
    tokenise(props?.district, props?.locality, props?.city, props?.suburb, props?.street, props?.name),
    noise,
  );
  const theirName = tokenise(props?.name);

  if (!corroborates(ourPlace, theirPlace)) return null;

  const isBank = props?.osm_key === 'amenity' && POI_VALUES.has(props?.osm_value);
  if (isBank && corroborates(ourBrand, theirName)) return 'osm_poi';

  /**
   * Everything else that corroborates is locality-grade, and only locality-grade.
   *
   * Two tempting shortcuts were tried and are wrong on this data. A matched *street* is not
   * street-precise: Photon packs the whole address blob into `street`, so it fires on locality
   * text, and an OSM road feature returns one representative point for a way that can run 35 km
   * — "Coimbatore-Mettupalayam Road" is not 120 m of anything. A *house number* is not
   * building-precise either: it graded a massage centre and a Lenovo showroom at ±25 m, because
   * a numbered shop in the right locality is still not the branch.
   *
   * What survives is honest: if the branch itself is mapped we say 10 m, otherwise we say "in
   * this locality, ±900 m". That is still sixteen times better than the district centroid it
   * replaces, and — unlike ±25 m on a spa — it is true.
   */
  return 'osm_locality';
}

/**
 * Photon (Komoot's OSM geocoder) — free, no key, and far more tolerant of the messy,
 * abbreviation-heavy addresses on real Indian branch lists than Nominatim's structured search.
 *
 * Biased towards the anchor with `lat`/`lon`, which is what makes "SBI Aundh" resolve to the
 * Pune one rather than any of the other Aundhs.
 */
async function photonSearch(
  query: string,
  anchor: VerificationAnchor | null,
  parts: AddressParts,
): Promise<OsmGeocodeResult | null> {
  const params = new URLSearchParams({ q: query, limit: '10', lang: 'en' });
  if (anchor) {
    params.set('lat', String(anchor.coord.lat));
    params.set('lon', String(anchor.coord.lng));
  }
  const data = await politely('photon', 1100, () =>
    getJson(`https://photon.komoot.io/api/?${params.toString()}`),
  );

  const features: any[] = data?.features ?? [];
  let best: OsmGeocodeResult | null = null;

  for (const feature of features) {
    const props = feature?.properties ?? {};
    if (props.countrycode && props.countrycode !== 'IN') continue;

    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const candidate: Coord = { lat: Number(coords[1]), lng: Number(coords[0]) };

    if (!verifyCandidate({ coord: candidate, state: props.state }, parts.state, anchor)) continue;

    const precision = gradePhotonCandidate(props, parts);
    if (!precision) continue;

    const result: OsmGeocodeResult = {
      ...candidate,
      precision,
      accuracyMeters: PRECISION_METERS[precision],
      matchedName: [props.name, props.street, props.city].filter(Boolean).join(', ') || undefined,
    };
    // Results are ranked by Photon, but a later POI still beats an earlier street: we want the
    // most precise verified match, not merely the first plausible one.
    if (!best || result.accuracyMeters < best.accuracyMeters) best = result;
    if (best.precision === 'osm_poi') break;
  }

  return best;
}

/**
 * Overpass — asks OSM directly for bank POIs around the anchor and picks the one whose name
 * matches the branch. Slower and heavier than Photon, so it runs only when Photon found no POI
 * and we actually have a brand or branch name to match on; in exchange it searches the tag data
 * rather than a text index, which finds branches Photon's ranking buries.
 */
async function overpassBankSearch(
  parts: AddressParts,
  anchor: VerificationAnchor | null,
): Promise<OsmGeocodeResult | null> {
  if (!anchor) return null;
  const needle = normalisePlace(parts.name) || normalisePlace(parts.brand);
  if (!needle || needle.length < 4) return null;

  const radius = anchor.kind === 'pincode' ? 8000 : 25000;
  const { lat, lng } = anchor.coord;
  const query =
    `[out:json][timeout:20];(` +
    `node["amenity"~"^(bank|atm)$"](around:${radius},${lat},${lng});` +
    `way["amenity"~"^(bank|atm)$"](around:${radius},${lat},${lng});` +
    `);out center 60;`;

  const data = await politely('overpass', 2500, () =>
    getJson(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, 25000),
  );

  const elements: any[] = data?.elements ?? [];
  const ourLocality = tokenise(parts.name, parts.address, parts.city);
  const ourBrand = tokenise(parts.brand);
  let best: OsmGeocodeResult | null = null;

  for (const element of elements) {
    const point: Coord = {
      lat: Number(element.lat ?? element.center?.lat),
      lng: Number(element.lon ?? element.center?.lon),
    };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    // Overpass returns no state, so the bbox and anchor-distance checks carry the verification.
    if (!verifyCandidate({ coord: point }, null, anchor)) continue;

    const tags = element.tags ?? {};
    const theirName = tokenise(tags.name, tags['name:en'], tags.brand, tags.operator);
    const theirPlace = tokenise(tags['addr:suburb'], tags['addr:city'], tags['addr:street'], tags.branch, tags.name);
    if (theirName.size === 0) continue;

    /**
     * Brand AND locality, never brand alone.
     *
     * Brand alone is what put the same Besant Nagar branch on two different Chennai records: it
     * is an RBL Bank, we were looking for an RBL Bank, and it was the nearest one Overpass
     * returned. "A branch of the right bank somewhere in this district" is not this branch.
     */
    if (!corroborates(ourBrand, theirName)) continue;
    if (!corroborates(ourLocality, theirPlace)) continue;

    const precision: GeoPrecision = element.type === 'node' ? 'osm_poi' : 'osm_building';
    const result: OsmGeocodeResult = {
      ...point,
      precision,
      accuracyMeters: PRECISION_METERS[precision],
      matchedName: tags.name || tags.brand || tags.operator,
    };
    if (!best || result.accuracyMeters < best.accuracyMeters) best = result;
  }

  return best;
}

// ---------------------------------------------------------------------------
// Tier 2 — the address, via Nominatim's structured search
// ---------------------------------------------------------------------------

/**
 * What precision a Nominatim result has earned. Same evidence rule as Photon — the feature type
 * caps the claim, corroboration decides whether it is granted.
 *
 * Nominatim's structured search returns the best *interpretation of the query it could parse*,
 * which for "S S KOVIL STREET, POLLACHI" was the Pollachi–Coimbatore Road 45 km from Pollachi.
 * Its own `place_rank` cheerfully calls that road-level, so the rank is a ceiling here, never a
 * grant.
 */
/**
 * Road classes that are short enough for a street-level claim to mean something.
 *
 * Deliberately excludes motorway/trunk/primary/secondary: those run for tens of kilometres, and
 * Nominatim's `place_rank` calls a 45 km highway "road-level" exactly as it does a housing-estate
 * lane. Matching the name of a national highway tells you the state, not the street.
 */
/**
 * OSM categories that describe a business or facility rather than a place people live.
 *
 * Rejected outright for a record that does not name a place (see `namesAPlace`): matching a home
 * address onto one of these is never right, and the finer the grade the more damage it does.
 */
const POI_CATEGORIES = new Set([
  'amenity', 'shop', 'office', 'tourism', 'leisure', 'healthcare', 'craft', 'club', 'emergency',
]);

const LOCAL_ROAD_TYPES = new Set([
  'residential', 'living_street', 'unclassified', 'service', 'tertiary', 'pedestrian', 'footway',
]);

/**
 * Half the diagonal of the object OSM actually matched, in metres — a measured error bar rather
 * than a tier's nominal one.
 *
 * This is what keeps a finer grade honest. A corroborated road name is not by itself evidence of
 * street-level precision, because the road may be two kilometres long and the coordinate is its
 * midpoint. The bounding box says how big the matched thing really is, so the claim can be made
 * from the geometry instead of from the hope. Returns null when the provider sent no box.
 */
export function matchedExtentMeters(entry: any): number | null {
  const box = (entry?.boundingbox ?? []).map(Number);
  if (box.length !== 4 || box.some((n: number) => !Number.isFinite(n))) return null;
  const [minLat, maxLat, minLon, maxLon] = box;
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const dLat = (maxLat - minLat) * 111320;
  const dLon = (maxLon - minLon) * 111320 * Math.cos(midLat);
  return Math.round(Math.hypot(dLat, dLon) / 2);
}

export function gradeNominatimCandidate(entry: any, parts: AddressParts): GeoPrecision | null {
  const address = entry?.address ?? {};
  const noise = placeNoise(parts);
  const ourPlace = without(tokenise(parts.name, parts.address), noise);
  const ourBrand = tokenise(parts.brand);

  /**
   * Whether this record names a place a map might hold as a point of interest.
   *
   * A branch does — that is what `name` and `brand` are for, and the POI rung below is the whole
   * reason they are sent. A person's home does not, and every rule keyed on this exists for that
   * case: without them a home address falls into the POI tiers by coincidence of a shared word.
   */
  const namesAPlace = Boolean(parts.name || parts.brand);

  /**
   * What counts as "the same place" — and, for a home, the building's own name does not.
   *
   * `entry.name` is the name of the matched object. For a branch that is the point: the POI is
   * literally what we are looking for. For a home it is the trap, and a measured one — an address
   * reading "Vyayam Shala, Chopra, Vidhisha" matched **Chopra Clinic**, a surgery OSM happens to
   * tag `place=house`, on the single shared word "Chopra". Corroborating a home against the place
   * hierarchy (the suburb, village, town and road it sits in) and not against whatever the
   * building is called is what separates "this person lives in Chopra" from "there is a business
   * called Chopra".
   */
  const theirPlace = without(
    tokenise(
      address.suburb, address.neighbourhood, address.village, address.town,
      address.city_district, address.road, ...(namesAPlace ? [entry?.name] : []),
    ),
    noise,
  );
  const theirName = tokenise(entry?.name, address.amenity);

  if (!corroborates(ourPlace, theirPlace)) return null;

  const isBank = entry?.category === 'amenity' && POI_VALUES.has(entry?.type);
  if (isBank && corroborates(ourBrand, theirName)) return 'osm_poi';

  /**
   * A person's home is not a business, however well the names line up.
   *
   * Measured on the live roster: an address reading "Vyayam Shala, Chopra, Vidhisha" matched
   * **Chopra Clinic** and, because the clinic carries a house number, was graded building-level at
   * 25 m. That is the namesake trap that pinned 52 appraisers onto shops and surgeries, returning
   * in a better disguise — a single common token corroborating against a POI, now with a finer
   * grade attached. One shared word is not evidence that somebody lives there.
   */
  if (!namesAPlace && POI_CATEGORIES.has(entry?.category)) return null;

  /**
   * A road that runs between districts locates the district, not the house.
   *
   * Also measured: two rows matched "Khargone - Indore Hwy" and "Karnal - Ladwa Highway" and were
   * graded 900 m. Nominatim's own `place_rank` calls a 45 km highway road-level exactly as it does
   * a housing lane, so the class is the only thing that separates them.
   */
  if (!namesAPlace && entry?.category === 'highway' && !LOCAL_ROAD_TYPES.has(entry?.type)) return null;

  /**
   * A house number in the ANSWER is not evidence about the question we asked.
   *
   * We never send one: OSM holds almost no Indian house numbers, so `placeCandidates` strips them
   * and the ladder asks about roads and localities. A match that happens to carry a house number
   * therefore tells us the map knows that building — not that it is *this person's* building. It
   * was graded 25 m on exactly that reasoning and put an appraiser inside a clinic.
   *
   * So building level is reachable only for a record that names a place and matched on that name.
   * For a home the honest ceiling is the street it is on.
   */
  if (namesAPlace && address.house_number) return 'osm_building';

  /**
   * A corroborated local road, and only when its own geometry is small enough to justify the
   * claim.
   *
   * The name matching is necessary but not sufficient — hence the extent check. Where the
   * provider sends no bounding box there is no evidence, so the coarser grade stands. This is the
   * same discipline as everywhere else here: never state a precision the data has not earned.
   */
  if (entry?.category === 'highway' && LOCAL_ROAD_TYPES.has(entry?.type)) {
    const extent = matchedExtentMeters(entry);
    if (extent !== null && extent <= PRECISION_METERS.osm_street) return 'osm_street';
  }

  // Same rule as Photon, for the same reasons — see gradePhotonCandidate.
  return 'osm_locality';
}

/**
 * Nominatim structured search. Structured rather than free-text on purpose: passing `street`,
 * `city`, `state` and `postalcode` as separate fields stops the parser reading "Branch" or a
 * SOL ID as part of the street name, which is what a free-text query on this data does.
 */
async function nominatimSearch(
  parts: AddressParts,
  anchor: VerificationAnchor | null,
): Promise<OsmGeocodeResult | null> {
  const pincode = parts.pincode && /^\d{6}$/.test(parts.pincode) ? parts.pincode : null;
  const city = (parts.city || '').trim() || null;
  const state = (parts.state || '').trim() || null;

  /**
   * The address is asked about in pieces, best piece first.
   *
   * It used to be asked about whole: the entire postal address went in as `street`, and because
   * structured search ANDs its components, a `street` that is not a street name returns nothing
   * however good the rest of the query is. Measured on a live record whose address was perfectly
   * good, the blob scored 0 hits and the same query without the street scored 1 — so every row
   * paid for a query that could not succeed and then fell back to a pincode centroid. That is why
   * the roster sat at a uniform 3 km however detailed the address was.
   *
   * `placeCandidates` returns the road first, then the named colony, then the bare village name,
   * which is also the order of decreasing precision — so the first candidate that a map recognises
   * is also the best answer available, and the ladder can stop there.
   */
  const candidates = placeCandidates(parts.address);
  if (candidates.length === 0 && !city && !pincode) return null;

  /**
   * How many rungs the ladder is allowed, which depends on whose server is answering.
   *
   * Against the self-hosted instance a lookup costs ~0.27s and there is no rate limit, so trying
   * three candidates two ways is cheap and pays for itself. Against a public Nominatim every call
   * is serialised at ~1 request/second by `politely`, and a deep ladder would multiply the whole
   * estate's sweep by six. So the depth follows the budget rather than being tuned to one
   * deployment.
   */
  const depth = NOMINATIM_MIN_INTERVAL_MS > 0 ? 1 : 3;

  const attempts: Array<Record<string, string>> = [];
  for (const candidate of candidates.slice(0, depth)) {
    // Pincode first: it is the tightest anchor on the record, and it is present on almost every
    // row. City is skipped here on purpose — the roster's city column disagrees with OSM's
    // spelling often enough ("Palayam Kottai" vs "Palayamkottai") to kill an otherwise good match.
    if (pincode) attempts.push({ street: candidate, postalcode: pincode });
    if (city) attempts.push({ street: candidate, city, ...(state ? { state } : {}) });
  }
  // No street at all — the coarse rung that still beats a centroid, and the one that was quietly
  // doing all the work before the ladder existed.
  if (city) attempts.push({ city, ...(state ? { state } : {}), ...(pincode ? { postalcode: pincode } : {}) });

  let best: OsmGeocodeResult | null = null;

  for (const attempt of attempts) {
    const params = new URLSearchParams({
      format: 'jsonv2',
      countrycodes: 'in',
      limit: '10',
      addressdetails: '1',
      ...attempt,
    });

    // Nominatim's usage policy: absolute maximum 1 request per second, per IP.
    const data = await politely('nominatim', NOMINATIM_MIN_INTERVAL_MS, () =>
      getJson(`${NOMINATIM_BASE_URL}/search?${params.toString()}`),
    );

    for (const entry of (Array.isArray(data) ? data : [])) {
      const candidate: Coord = { lat: Number(entry.lat), lng: Number(entry.lon) };
      if (!verifyCandidate({ coord: candidate, state: entry?.address?.state }, parts.state, anchor)) continue;

      const precision = gradeNominatimCandidate(entry, parts);
      if (!precision) continue;
      const result: OsmGeocodeResult = {
        ...candidate,
        precision,
        accuracyMeters: PRECISION_METERS[precision],
        matchedName: entry.display_name?.split(',').slice(0, 3).join(',').trim(),
      };
      if (!best || result.accuracyMeters < best.accuracyMeters) best = result;
    }

    // Good enough to stop paying for the rungs below, which are coarser by construction.
    if (best && best.accuracyMeters <= PRECISION_METERS.osm_street) break;
  }

  return best;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * The centroid of a 6-digit pincode, from OSM.
 *
 * This is the anchor everything else is judged against, and it matters more than any single
 * provider. The existing India Post lookup returns nothing for many pincodes because that API
 * frequently omits coordinates — and with no anchor, verification widens to the district HQ,
 * which let "Pollachi - Coimbatore Road" (a road near Coimbatore, named after a town 45 km
 * away) be accepted as the Pollachi branch.
 *
 * A pincode is unambiguous, so this is both reliable and cheap to cache: one lookup serves
 * every branch and every assayer in that pincode, forever.
 */
export async function pincodeCentroid(
  pincode: string,
  state?: string | null,
  /**
   * The district the record claims. Checked, not decorative: OSM's postcode areas for Chennai
   * place 600013 (Royapuram) and 600092 (Virugambakkam) in *Chengalpattu*, 30 km and 19 km from
   * where those pincodes actually are. Unchecked, that bad anchor does double damage — it
   * becomes the answer, and it rejects the correct candidates for being too far from it.
   */
  district?: string | null,
): Promise<OsmGeocodeResult | null> {
  if (!/^\d{6}$/.test(pincode)) return null;
  const key = `pin|${pincode}|${normalisePlace(district)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    format: 'jsonv2',
    countrycodes: 'in',
    postalcode: pincode,
    limit: '1',
    addressdetails: '1',
  });
  const data = await politely('nominatim', NOMINATIM_MIN_INTERVAL_MS, () =>
    getJson(`${NOMINATIM_BASE_URL}/search?${params.toString()}`),
  );

  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry) return null;
  const coord: Coord = { lat: Number(entry.lat), lng: Number(entry.lon) };
  // No anchor to check against — this IS the anchor — so the bbox and state checks carry it.
  if (!verifyCandidate({ coord, state: entry?.address?.state }, state, null)) return null;

  // Refuse an anchor that lands in a different district than the record claims. Both names must
  // be present to disagree; an unnamed district is unknown, not a mismatch.
  const claimedDistrict = normalisePlace(district);
  const foundDistrict = entry?.address ?? {};
  if (claimedDistrict) {
    const candidates = [foundDistrict.state_district, foundDistrict.county, foundDistrict.city, foundDistrict.town]
      .map(normalisePlace)
      .filter(Boolean);
    if (candidates.length > 0 && !candidates.some((d) => d.includes(claimedDistrict) || claimedDistrict.includes(d))) {
      return null;
    }
  }

  const result: OsmGeocodeResult = {
    ...coord,
    precision: 'pincode',
    accuracyMeters: PRECISION_METERS.pincode,
    matchedName: entry.display_name?.split(',').slice(0, 3).join(',').trim(),
  };
  rememberResult(key, result);
  return result;
}

/**
 * The centroid of a district, from OSM (a self-hosted Nominatim carries every Indian district).
 *
 * The precise tiers key off `street`/`city`. When those are hyper-local names OSM cannot match —
 * a neighbourhood, a shop-front street, a village too small to be tagged — and the pincode is
 * also unknown, the record used to fall straight past the incomplete static district set to its
 * *state* centroid, collapsing whole states onto a single shared point. A "<district>, <state>"
 * lookup instead places it in its own district: ~15 km coarse, so graded `locality`, but honestly
 * distinct. One lookup serves every record in that district, so it is cached like the pincode one.
 */
export async function districtCentroidOsm(
  district?: string | null,
  state?: string | null,
): Promise<OsmGeocodeResult | null> {
  const dist = (district || '').trim();
  if (!dist) return null;
  const key = `dist|${normalisePlace(dist)}|${normalisePlace(state)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    format: 'jsonv2',
    countrycodes: 'in',
    q: [dist, state, 'India'].filter(Boolean).join(', '),
    limit: '1',
    addressdetails: '1',
  });
  const data = await politely('nominatim', NOMINATIM_MIN_INTERVAL_MS, () =>
    getJson(`${NOMINATIM_BASE_URL}/search?${params.toString()}`),
  );

  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry) return null;
  const coord: Coord = { lat: Number(entry.lat), lng: Number(entry.lon) };
  // This IS the anchor for these records, so only the state check guards it against a same-named
  // district in the wrong state (Hamirpur is in both HP and UP; the state in the query settles it).
  if (!verifyCandidate({ coord, state: entry?.address?.state }, state, null)) return null;

  const result: OsmGeocodeResult = {
    ...coord,
    precision: 'locality',
    accuracyMeters: PRECISION_METERS.locality,
    matchedName: entry.display_name?.split(',').slice(0, 2).join(',').trim(),
  };
  rememberResult(key, result);
  return result;
}

/**
 * Resolve an Indian address to the most precise free coordinate available, or null.
 *
 * Null means "none of the free sources could place this confidently" — the caller falls through
 * to its own pincode/centroid tiers. It never guesses: an unverified candidate is dropped, on
 * the reasoning that a plausible wrong pin is worse than an admitted coarse one, because only
 * the coarse one is visibly wrong to whoever looks at the map.
 *
 * `anchor` is a coordinate already trusted for this record (its pincode centroid, else its
 * district centroid). Supply it whenever possible — without it the verification degrades to
 * "somewhere in India", which for repeated Indian place names is close to no check at all.
 */
export async function resolveFreely(
  parts: AddressParts,
  anchor: VerificationAnchor | null = null,
): Promise<OsmGeocodeResult | null> {
  /**
   * With nothing to check an answer against, a home address is not worth guessing at.
   *
   * `verifyCandidate` applies its distance test only when it has an anchor — a pincode or district
   * centroid. Without one, the only surviving checks are "inside India" and "state does not
   * contradict", and a state is the size of a country: that is how a Vidisha appraiser was matched
   * to a clinic in Indore, 200 km away, and how a cleared cache (which is where the anchors come
   * from) can quietly turn verification off.
   *
   * A record that names a place keeps the old behaviour — a branch is looked up BY its name, and
   * the POI rung is the point of asking. For a home the honest answer with no anchor is the coarse
   * tier the caller already holds, so this returns nothing rather than something unfalsifiable.
   */
  if (!anchor && !(parts.name || parts.brand)) return null;

  const key = cacheKey('free', parts);
  const cached = cache.get(key);
  if (cached) return cached;

  const brandAndName = [parts.brand, parts.name].filter(Boolean).join(' ').trim();
  const locality = [parts.city, parts.district, parts.state].filter(Boolean).join(', ');

  /**
   * Tried in order of how likely each is to land on the actual building.
   *
   * The name-first query leads because a bank branch is usually mapped in OSM as a named POI:
   * "State Bank of India Aundh Branch, Pune, Maharashtra" hits the node someone surveyed, while
   * the same record's address line hits the road it is on, 120 m away.
   */
  const attempts: Array<() => Promise<OsmGeocodeResult | null>> = [];

  if (brandAndName && locality) {
    attempts.push(() => photonSearch(`${brandAndName}, ${locality}`, anchor, parts));
  }
  if (parts.address) {
    attempts.push(() => nominatimSearch(parts, anchor));
    attempts.push(() => photonSearch(`${parts.address}, ${locality}`, anchor, parts));
  }
  // Overpass last: it is the heaviest call, and it only pays off for a branch whose POI exists
  // but whose text ranking buried it in the two searches above.
  attempts.push(() => overpassBankSearch(parts, anchor));

  let best: OsmGeocodeResult | null = null;
  for (const attempt of attempts) {
    const result = await attempt().catch(() => null);
    if (result && (!best || result.accuracyMeters < best.accuracyMeters)) best = result;
    // Good enough to stop paying for the remaining providers.
    if (best && best.accuracyMeters <= PRECISION_METERS.osm_building) break;
  }

  if (best) rememberResult(key, best);
  return best;
}

/**
 * Free reverse geocoding — what is at this coordinate?
 *
 * Used to confirm a manual pin actually lands in the district the record claims, so a mis-drop
 * (or a transposed lat/lng, which puts an Indian branch in the Indian Ocean or China) is caught
 * at the moment it is made rather than by whoever reads the map three weeks later.
 */
export async function reverseFreely(
  coord: Coord,
): Promise<{ state?: string; district?: string; city?: string; pincode?: string; display?: string } | null> {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(coord.lat),
    lon: String(coord.lng),
    // zoom 16 (village/suburb) so the address carries the postcode and settlement, not just the
    // district — one call now fills district, city AND pincode instead of only the district.
    zoom: '16',
    addressdetails: '1',
  });
  const data = await politely('nominatim', NOMINATIM_MIN_INTERVAL_MS, () =>
    getJson(`${NOMINATIM_BASE_URL}/reverse?${params.toString()}`),
  );
  if (!data?.address) return null;
  const a = data.address;
  return {
    state: a.state,
    district: a.state_district || a.county || a.city || a.town,
    city: a.city || a.town || a.village || a.suburb || a.municipality,
    // Indian postcodes are 6 digits; ignore anything else Nominatim may hand back.
    pincode: typeof a.postcode === 'string' && /^[1-9]\d{5}$/.test(a.postcode.trim()) ? a.postcode.trim() : undefined,
    display: data.display_name,
  };
}
