import * as fs from 'fs';
import * as path from 'path';

/**
 * Live, whole-India place lookup for the type-ahead dropdowns.
 *
 * The geo reference tables hold only a curated handful of cities, so they cannot
 * answer "which district is Udhampur in?" or "is Doraha a real town?" for someone
 * working across the country. Rather than hard-code the entire India map into this
 * repo (unmaintainable and by definition stale), we ask the Google Places
 * Autocomplete API (New). This is the ONLY source — no free-tier fallbacks, so a
 * misleading hit from an unreliable provider never reaches the form. Requires
 * GOOGLE_MAPS_API_KEY with the Places API (New) + billing enabled.
 *
 * Results are cached on disk for 10 minutes so keystroke autocomplete does not
 * hammer the API.
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

/**
 * Whether the place lookup can actually answer anything right now.
 *
 * There is deliberately only one source, so with no API key configured every query returns an
 * empty list. That is indistinguishable from "no such place" unless the caller asks — and a
 * caller that reads it as "no such place" refuses every real address the moment this optional
 * integration is absent. Anything that *rejects* on an empty result must check this first.
 */
export function isPlaceLookupConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
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

  const results = process.env.GOOGLE_MAPS_API_KEY ? await queryGooglePlaces(q) : [];

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