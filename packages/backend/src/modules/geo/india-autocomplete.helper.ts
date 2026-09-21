import * as path from 'path';
import { JsonFileCache } from './geo-cache-store';
import { nominatimPlaceSearch, nominatimIsSelfHosted, type NominatimPlace } from './osm-geocoder';

/**
 * Live, whole-India place lookup for the type-ahead dropdowns.
 *
 * The geo reference tables hold only a curated handful of cities, so they cannot answer "which
 * district is Udhampur in?" or "is Doraha a real town?" for someone working across the country.
 * Hard-coding the India map into this repo is unmaintainable and stale by definition, so the
 * question goes to a map service.
 *
 * ── Why this is Nominatim and not Google ──────────────────────────────────────────────────────
 * It used to be Google Places Autocomplete, and `GOOGLE_MAPS_API_KEY` was never set — so
 * EVERY query returned an empty list, for the whole life of the feature. Address type-ahead was
 * dead, and `validateGeography` had to be taught to treat "no results" as "lookup absent" so it
 * did not refuse real branches for it.
 *
 * The owner's decision (2026-09-19) was to stay self-hosted rather than buy a Google key, on
 * cost and on licence: Google's Maps Platform terms permit caching a latitude/longitude for at
 * most 30 consecutive days, which this product cannot honour because it stores a branch's and an
 * assayer's coordinates permanently. OSM data under ODbL carries no such deletion clause. So the
 * one source is the Nominatim we already run — the same instance `osm-geocoder` geocodes
 * against, reached through the same client, rate limiter and test-network guard rather than a
 * second HTTP path of its own.
 *
 * Results are cached on disk for 10 minutes so keystroke autocomplete does not hammer it.
 */

export interface IndiaPlaceResult {
  label: string;
  type: 'state' | 'district' | 'city' | 'town' | 'village' | 'locality' | 'pincode';
  state: string;
  district: string;
  pincode: string;
}

const TTL_MS = 10 * 60 * 1000; // refresh a query's results at most every 10 minutes

/**
 * Debounced and stored outside `dist/` — see geo-cache-store.ts.
 *
 * This was the worse of the two synchronous writers. `saveCache()` rewrote the entire file
 * with `writeFileSync` on *every* cache miss, and this cache is fed by a type-ahead: each
 * keystroke in a district or city field is its own query string, so each keystroke was a
 * distinct miss and a full blocking rewrite of a file that only ever grew. Every other request
 * on the process stalled behind someone typing an address.
 */
const cache = new JsonFileCache<{ time: number; data: IndiaPlaceResult[] }>(
  'geo-autocomplete-cache.json',
  path.join(__dirname, '../../infrastructure/database/geo-autocomplete-cache.json'),
);

/**
 * Whether the place lookup can actually answer anything right now.
 *
 * True only for a SELF-HOSTED Nominatim. The public server at nominatim.openstreetmap.org names
 * auto-complete search in its unacceptable-use list, so pointing a type-ahead at it is not a
 * slower option, it is not an option — a deployment that has not set `NOMINATIM_URL` has no
 * place lookup, and must be able to find that out.
 *
 * That matters because with no lookup every query returns an empty list, which is
 * indistinguishable from "no such place" unless the caller asks. A caller that reads it as "no
 * such place" refuses every real address the moment this optional integration is absent.
 * Anything that *rejects* on an empty result must check this first.
 */
export function isPlaceLookupConfigured(): boolean {
  return nominatimIsSelfHosted();
}

/**
 * Search India for places matching `query`. `query` may be a 6-digit pincode, a
 * district, a city/town/village name, or "city, state" / "district, state".
 */
export async function autocompleteIndia(query: string): Promise<IndiaPlaceResult[]> {
  const q = (query || '').trim();
  if (!q) return [];

  /**
   * An unconfigured lookup is not a result worth remembering.
   *
   * Caching the empty list here wrote "no such place" into a cache that outlives the process —
   * `JsonFileCache` persists to disk — so a deployment that started once without
   * `NOMINATIM_URL` went on answering every one of those queries with nothing for a further ten
   * minutes after it was configured properly. There is nothing to rate-limit when no request is
   * made, so there is nothing to cache.
   */
  if (!isPlaceLookupConfigured()) return [];

  const key = q.replace(/\s+/g, ' ').toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < TTL_MS) return cached.data;

  const results = await queryNominatim(q);

  // Expired entries can never be served again, but they were still kept and re-serialised on
  // every write — one entry per partial word anyone ever typed, forever. Dropped before the
  // write so the file (and the flush it costs) stays proportional to what is actually live.
  cache.prune((entry) => Date.now() - entry.time < TTL_MS);
  cache.set(key, { time: Date.now(), data: results });
  return results;
}

/**
 * Nominatim's `addresstype` in the vocabulary this product's forms use.
 *
 * Anything unrecognised is a 'locality' rather than a guess: the type drives which dropdown a
 * hit may fill, and a suburb promoted to 'city' puts a neighbourhood in the city field.
 */
const ADDRESS_TYPE: Record<string, IndiaPlaceResult['type']> = {
  state: 'state',
  state_district: 'district',
  county: 'district',
  district: 'district',
  city: 'city',
  municipality: 'city',
  town: 'town',
  village: 'village',
  hamlet: 'village',
  postcode: 'pincode',
};

/**
 * The OSM categories that hold a place a person could be posted to.
 *
 * `place` is settlements, `boundary` is administrative areas. Everything else shares only a
 * name: searching "Bagalkot" against the live instance returns, in rank order, a cement works
 * (`landuse`), the District Commissioner's Office (`landuse`) and five roads called Bagalkot
 * Road (`highway`) BEFORE the city itself. Offering those in a district field is worse than
 * offering nothing — the operator picks one and the branch is filed under a road.
 */
const PLACE_CATEGORIES = new Set(['place', 'boundary']);

/** Nominatim rows, India-bounded, normalised to IndiaPlaceResult. */
async function queryNominatim(q: string): Promise<IndiaPlaceResult[]> {
  // Asked wide because most of what comes back is discarded by category below.
  const rows = await nominatimPlaceSearch(q, 20);

  const out: IndiaPlaceResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!PLACE_CATEGORIES.has(row.category)) continue;
    const place = toPlace(row);
    if (!place) continue;
    const sig = `${place.label} ${place.state} ${place.district}`.toLowerCase();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(place);
    if (out.length >= 8) break;
  }
  return out;
}

function toPlace(row: NominatimPlace): IndiaPlaceResult | null {
  const a = row.address || {};
  const state = (a.state || '').trim();
  // A state's own row carries no `state_district`; a district's may arrive under either key.
  const district = (a.state_district || a.county || '').trim();
  const pincode = (a.postcode || '').trim();

  // Without a state there is nothing a form can do with the hit — every dropdown it could fill
  // is keyed by state — so an unplaceable row is dropped rather than shown.
  if (!state) return null;

  const type = ADDRESS_TYPE[row.addressType] ?? 'locality';
  const name = (
    a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality
    || (type === 'state' ? state : '')
    || district
    || row.displayName.split(',')[0]
    || ''
  ).trim();
  if (!name) return null;

  const label = type === 'state'
    ? state
    : [name, district && district !== name ? district : '', state].filter(Boolean).join(', ');

  return { label, type, state, district, pincode };
}
