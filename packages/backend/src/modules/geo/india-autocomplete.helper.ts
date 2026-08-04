import * as fs from 'fs';
import * as path from 'path';

/**
 * Live, whole-India place lookup for the type-ahead dropdowns.
 *
 * The geo reference tables hold only a curated handful of cities, so they cannot
 * answer "which district is Udhampur in?" or "is Doraha a real town?" for someone
 * working across the country. Rather than hard-code the entire India map into this
 * repo (unmaintainable and by definition stale), we ask a real geocoder.
 *
 * Primary source is the Google Places Autocomplete API (set GOOGLE_MAPS_API_KEY),
 * which returns precise, India-bounded suggestions; when no key is configured it
 * falls back to Nominatim (OpenStreetMap), the same source the geocoders use, with
 * a small on-disk cache so keystroke autocomplete does not hammer a rate-limited API.
 *
 * Each result is normalised to {label, type, state, district, pincode} so the form
 * can type-select a real place and the backend persists real values.
 */

export interface IndiaPlaceResult {
  label: string;
  type: 'state' | 'district' | 'city' | 'town' | 'village' | 'locality' | 'pincode';
  state: string;
  district: string;
  pincode: string;
}

const CACHE_FILE = path.join(__dirname, '../../infrastructure/database/geo-autocomplete-cache.json');
const TTL_MS = 10 * 60 * 1000; // refresh a query's results at most every 10 minutes

let cache: Record<string, { time: number; data: IndiaPlaceResult[] }> = {};
try {
  if (fs.existsSync(CACHE_FILE)) cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch { /* start empty */ }

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

function placeType(t?: string): IndiaPlaceResult['type'] {
  switch (t) {
    case 'administrative': return 'district';
    case 'city':
    case 'town':
      return 'city';
    case 'village':
      return 'village';
    case 'postcode':
      return 'pincode';
    default:
      return 'locality';
  }
}

/**
 * Search India for places matching `query`. `query` may be a 6-digit pincode, a
 * district, a city/town/village name, or "city, state" / "district, state".
 */
export async function autocompleteIndia(query: string): Promise<IndiaPlaceResult[]> {
  const q = (query || '').trim();
  if (!q) return [];

  const key = q.replace(/\s+/g, ' ').toLowerCase();
  const cached = cache[key];
  if (cached && Date.now() - cached.time < TTL_MS) return cached.data;

  // Primary: Google Places Autocomplete (needs GOOGLE_MAPS_API_KEY + Places API).
  let results = process.env.GOOGLE_MAPS_API_KEY ? await queryGooglePlaces(q) : [];
  // Fallback: Nominatim (OpenStreetMap), same source as the address geocoders.
  if (!results.length) results = await queryNominatim(q);

  cache[key] = { time: Date.now(), data: results };
  saveCache();
  return results;
}

/** Google Places Autocomplete (New), India-bounded, normalised to IndiaPlaceResult.
 * Uses the modern `places.googleapis.com/v1/places:autocomplete` endpoint, which
 * is what new GCP projects get (the legacy `/maps/api/place/autocomplete` is
 * deprecated and not provisioned). Requires the Places API (New) + Billing. */
async function queryGooglePlaces(q: string): Promise<IndiaPlaceResult[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return [];
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
      },
      body: JSON.stringify({
        input: q,
        regionCode: 'IN',
        includedRegionCodes: ['IN'],
        languageCode: 'en',
      }),
    });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const data = (await res.json()) as any;

    const out: IndiaPlaceResult[] = [];
    const seen = new Set<string>();
    for (const s of data.suggestions ?? []) {
      const text = s?.placePrediction?.text?.text ?? s?.placePrediction?.structuredFormat?.mainText?.text ?? '';
      // Google returns "Kaggalipura, Karnataka, India" — split to pull the state.
      const tokens = text.split(', ').map((x: string) => x.trim()).filter(Boolean);
      const country = tokens[tokens.length - 1] ?? '';
      const state = tokens.length > 1 ? tokens[tokens.length - 2] : '';
      const city = tokens[0] ?? '';
      if (!city || !state || country.toLowerCase() !== 'india') continue;
      const district = tokens.length > 2 ? tokens[tokens.length - 3] : '';
      const label = [city, district !== city ? district : '', state].filter(Boolean).join(', ');
      const place: IndiaPlaceResult = { label, type: 'locality', state, district, pincode: '' };
      const sig = `${label} ${state} ${district}`.toLowerCase();
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(place);
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function queryNominatim(q: string): Promise<IndiaPlaceResult[]> {
  // Nominatim's usage policy is ~1 req/sec; give the keystroke cadence room.
  await new Promise((r) => setTimeout(r, 500));
  try {
    const url =
      `${'https://nominatim.openstreetmap.org/search?q='}${encodeURIComponent(`${q}, India`)}` +
      `&format=json&limit=14&countrycodes=in&addressdetails=1`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'fapoms-geo-autocomplete/1.0 (info@fapoms.com)' },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return [];

    const data = (await res.json()) as any[];
    const out: IndiaPlaceResult[] = [];
    const seen = new Set<string>();
    for (const d of data) {
      const addr = d.address ?? {};
      const name =
        addr.city || addr.town || addr.village || addr.suburb || addr.county || addr.state_district || d.name;
      const state = addr.state || '';
      const district = addr.state_district || addr.county || addr.district || '';
      if (!name || !state) continue;
      const label = [name, addr.county && addr.county !== name ? addr.county : '', state]
        .filter(Boolean)
        .join(', ');
      const place: IndiaPlaceResult = {
        label,
        type: placeType(addr.addresstype || d.type || 'locality'),
        state,
        district,
        pincode: addr.postcode || '',
      };
      const sig = `${label} ${state} ${district}`.toLowerCase();
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(place);
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}
