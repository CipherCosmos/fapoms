import * as fs from 'fs';
import * as path from 'path';

// Shared on-disk cache with the branch/assayer geocoders: one lookup paid,
// every record in the same place free. Persisted so a restart does not re-hit
// Nominatim's rate limit for the same pin/district.
const GEO_CACHE_FILE = path.join(__dirname, '../../infrastructure/database/geocoding-cache.json');
let geoCache: Record<string, { lat: number; lng: number }> = {};
try {
  if (fs.existsSync(GEO_CACHE_FILE)) geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
} catch { /* start with an empty cache */ }
function saveGeoCache() {
  try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache, null, 2), 'utf8'); } catch { /* non-fatal */ }
}

const UA = 'fapoms-geocoder/1.0 (info@fapoms.com)';
const RATE_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Coord { lat: number; lng: number }
export type GeoSource = 'geocoder' | 'pincode' | 'locality' | 'none';
export interface GeocodeResult extends Coord {
  accuracyMeters: number;
  source: GeoSource;
}

function haversineM(a: Coord, b: Coord): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Case/space/punctuation/suffix-insensitive place name normaliser. */
function norm(s?: string | null): string {
  return (s || '')
    .toLowerCase()
    .replace(/\b(urban|rural|district|city|metro|municipality|corporation|municipal)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Nominatim ranks feature types by importance, so `data[0]` is often a big
// landmark (airport) or a coarse region even when the query names a suburb.
// We fetch a batch and re-rank by how spatially precise the feature is.
const GRANULARITY: Record<string, number> = {
  building: 100, house: 100, address: 96, residential: 92, neighbourhood: 86, suburb: 85,
  road: 88, highway: 88, hamlet: 82, village: 78, town: 74, place: 72,
  amenity: 74, shop: 70, tourism: 70, leisure: 70, hotel: 70,
  city: 60, county: 38, district: 30, region: 12, state: 10, country: 5, '': 42,
};
function granularity(row: any): number {
  const t = row?.type || row?.addresstype || '';
  return GRANULARITY[t] ?? (row?.class ? GRANULARITY[row.class] ?? 40 : 40);
}
// Features finer than this are "street/building level" — good enough to trust
// even if the recorded city name is slightly off.
const FINE_LEVEL = 74;
// A fine/street hit may override the pincode anchor only within this radius; a
// precise-looking hit much farther away is a different place with the same
// name, so we discard it instead of accepting a 15–30 km wrong marker.
const MAX_FINE_RADIUS = 10000;

async function nominatim(q: string, limit: number): Promise<any[]> {
  const key = q.replace(/\s+/g, ' ').trim();
  await sleep(RATE_MS);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key)}&format=json&limit=${limit}&addressdetails=1&countrycodes=in`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    });
    clearTimeout(timeoutId);
    if (res.ok) return (await res.json()) as any[];
  } catch { /* fall through to next query */ }
  return [];
}

/** Reverse-geocodes a point to the state it actually sits in. Used only to
 * double-check a forward hit whose addressdetails omitted a state — several
 * localities share a name across states, and OSM sometimes returns a bare
 * feature with no address envelope, so the forward state-name check can't fire. */
async function reverseState(c: Coord): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${c.lat}&lon=${c.lng}&format=jsonv2&addressdetails=1`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = (await res.json()) as any;
      return data?.address?.state || null;
    }
  } catch { /* unverifiable */ }
  return null;
}

/** Google Maps is the PRIMARY geocoder. Set GOOGLE_MAPS_API_KEY to enable it;
 * otherwise we fall back to Nominatim. It fails safely to Nominatim on any
 * error (bad key, quota, HTTP) so geocoding never blocks an import.
 *
 * Precision strategy:
 *  1. Geocoding API with a postal_code component (when the address carries a
 *     6-digit pin) — Google pins the exact postal region, not a stray landmark.
 *  2. Refine an "APPROXIMATE" (postal-level) hit with the Places Find Place
 *     text search, which returns the actual building/POI point when mapped.
 *  Location type (ROOFTOP / RANGE_INTERCEPTED / GEOMETRIC_CENTER / APPROXIMATE)
 *  drives the reported accuracy in metres. */
async function googleGeocode(
  address: string,
  city: string,
  district: string,
  state: string,
  pin: string | null,
): Promise<GeocodeResult | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const addrLine = (address || '').replace(/\b\d{6}\b/g, '').replace(/\s+/g, ' ').trim();

  const googleFetch = async (path: string) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`https://maps.googleapis.com/maps/api/${path}&key=${apiKey}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      if (data.status !== 'OK') return null;
      return data;
    } catch { return null; }
  };

  const geocoder = async (q: string, postal?: string | null): Promise<any[]> => {
    const parts: string[] = ['country:IN'];
    if (postal) parts.push(`postal_code:${postal}`);
    const data = await googleFetch(
      `geocode/json?address=${encodeURIComponent(q)}&region=IN&components=${encodeURIComponent(parts.join('|'))}`,
    );
    return data?.results ?? [];
  };

  const placesFind = async (q: string): Promise<any | null> => {
    // Places API (New) text search — the modern endpoint new GCP projects get.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.formattedAddress,places.location,places.addressComponents',
        },
        body: JSON.stringify({ textQuery: q, regionCode: 'IN', languageCode: 'en' }),
      });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      const place = data?.places?.[0];
      if (!place?.location?.latitude || place?.location?.longitude == null) return null;
      const stateComp = place.addressComponents?.find((c: any) =>
        c.types?.includes('administrativeAreaLevel1'));
      return {
        geometry: { location: { lat: place.location.latitude, lng: place.location.longitude } },
        address_component: stateComp ? [{ long_name: stateComp.longText }] : [],
      };
    } catch {
      clearTimeout(timeoutId);
      return null;
    }
  };

  const stateNorm = norm(state);
  const preferInState = (results: any[]): any | null => {
    const stateOf = (r: any) =>
      r?.address_components?.find((c: any) => c.types?.includes('administrative_area_level_1'))?.long_name;
    return results.find((r) => stateNorm && stateOf(r) && norm(stateOf(r)) === stateNorm) ?? results[0] ?? null;
  };

  let results: any[] = [];
  if (addrLine) results = await geocoder(`${addrLine}${city ? ', ' + city : ''}`, pin);
  if (!results.length && addrLine) results = await geocoder(addrLine, pin);
  if (!results.length && (city || district) && state) results = await geocoder(`${city || district}, ${state}`, undefined);
  let result = preferInState(results);
  if (!result) return null;

  // State sanity: Google usually names the state; a cross-state result is a wrong hit.
  const resState = result.address_components?.find((c: any) => c.types?.includes('administrative_area_level_1'))?.long_name;
  if (stateNorm && resState && norm(resState) !== stateNorm) return null;

  let location = result.geometry?.location;
  let accuracy = googleAccuracy(result);
  if (result.geometry?.location_type === 'APPROXIMATE') {
    const place = await placesFind(`${addrLine}${city ? ', ' + city : ''}${state ? ', ' + state : ''}`);
    if (place?.geometry?.location) {
      const pState = place.address_component?.find((c: any) => c.types?.includes('administrative_area_level_1'))?.long_name;
      if (!stateNorm || !pState || norm(pState) === stateNorm) {
        location = place.geometry.location;
        accuracy = 60;
      }
    }
  }
  if (!location) return null;

  const coords = { lat: location.lat, lng: location.lng };
  const cacheKey = `${address} ${city} ${pin || ''}`.replace(/\s+/g, ' ').trim();
  if (cacheKey.length > 6) { geoCache[cacheKey] = coords; saveGeoCache(); }
  return { ...coords, accuracyMeters: accuracy, source: 'geocoder' };
}

function googleAccuracy(r: any): number {
  const t = r?.geometry?.location_type;
  if (t === 'ROOFTOP' || t === 'RANGE_INTERCEPTED') return 60;
  const vp = r?.geometry?.viewport ?? r?.geometry?.bounds;
  if (vp?.northeast && vp?.southwest) {
    const w = haversineM({ lat: vp.northeast.lat, lng: vp.southwest.lng }, { lat: vp.northeast.lat, lng: vp.northeast.lng });
    const h = haversineM({ lat: vp.southwest.lat, lng: vp.southwest.lng }, { lat: vp.northeast.lat, lng: vp.southwest.lng });
    return Math.max(50, Math.min(2000, Math.round(Math.max(w, h) / 2)));
  }
  return t === 'GEOMETRIC_CENTER' ? 250 : 800;
}

/** Geoapify (free tier) geocoder — the temporary primary until the Google key is
 * configured. Set GEOCODER_API_KEY to enable; no billing required. Falls back to
 * Nominatim on any error. Free tier: ~3 000 requests/day, 3 req/sec. */
async function geoapifyGeocode(
  address: string,
  city: string,
  district: string,
  state: string,
  pin: string | null,
): Promise<GeocodeResult | null> {
  const apiKey = process.env.GEOCODER_API_KEY;
  if (!apiKey) return null;
  const addrLine = (address || '').replace(/\b\d{6}\b/g, '').replace(/\s+/g, ' ').trim();

  const buildQuery = (text: string, usePin: boolean): string => {
    const params = new URLSearchParams({ text, format: 'json', lang: 'en', limit: '5', apiKey });
    params.set('country', 'india');
    if (usePin && pin) params.set('postcode', pin);
    return `https://api.geoapify.com/v1/geocode/search?${params.toString()}`;
  };

  const query = async (text: string, usePin: boolean): Promise<any[]> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(buildQuery(text, usePin), { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return data?.results ?? [];
    } catch { return []; }
  };

  let results = addrLine ? await query(`${addrLine}${city ? ', ' + city : ''}${state ? ', ' + state : ''}`, true) : [];
  if (!results.length && addrLine) results = await query(addrLine, true);
  if (!results.length && (city || district) && state) results = await query(`${city || district}, ${state}`, false);

  const stateNorm = norm(state);
  const inState = (r: any) => r?.state && norm(r.state) === stateNorm;
  const result = results.find(inState) ?? results[0];
  if (!result || typeof result.lat !== 'number' || typeof result.lon !== 'number') return null;
  const rState = result.state;
  if (stateNorm && rState && norm(rState) !== stateNorm) return null;

  const type = result.result_type ?? '';
  const conf = result.rank?.confidence ?? 0.6;
  let accuracy = Math.round((1 - conf) * 4000) + 200;
  if (type === 'building' || type === 'amenity' || type === 'residential' || type === 'house') accuracy = 120;
  else if (type === 'street') accuracy = 180;
  else if (type === 'suburb' || type === 'neighbourhood') accuracy = 450;

  const coords = { lat: result.lat, lng: result.lon };
  const cacheKey = `${address} ${city} ${pin || ''}`.replace(/\s+/g, ' ').trim();
  if (cacheKey.length > 6) { geoCache[cacheKey] = coords; saveGeoCache(); }
  return { ...coords, accuracyMeters: accuracy, source: 'geocoder' };
}

export async function geocodeIndia(
  address: string,
  city: string,
  district: string,
  state: string,
  pincode?: string | null,
): Promise<GeocodeResult | null> {
  const pin = pincode || (address || '').match(/\b\d{6}\b/)?.[0] || null;
  const addrLine = (address || '').replace(/\b\d{6}\b/g, '').replace(/\s+/g, ' ').trim();

  // 1. Primary providers (precise enough to trust directly):
  //    Google Maps, then Geoapify (temporary free-tier), then Nominatim.
  if (process.env.GOOGLE_MAPS_API_KEY) {
    const g = await googleGeocode(address, city, district, state, pin);
    if (g) return g;
  }
  if (process.env.GEOCODER_API_KEY) {
    const g = await geoapifyGeocode(address, city, district, state, pin);
    if (g) return g;
  }

  // 2. Region anchor: the pincode (or nearest city) centroid is the "floor" we
  //    must not drift absurdly far from — it is what disqualifies the airport
  //    type of wrong hit and what we return if nothing finer resolves.
  let anchor: Coord | null = null;
  if (pin) {
    const key = `${pin}, India`;
    if (geoCache[key]) anchor = geoCache[key];
    else {
      const rows = await nominatim(key, 1);
      if (rows[0]) { anchor = { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon) }; geoCache[key] = anchor; saveGeoCache(); }
    }
  }
  if (!anchor) {
    const q = [city && state ? `${city}, ${state}, India` : null, district && state ? `${district}, ${state}, India` : null]
      .filter((x): x is string => !!x)[0];
    if (q) {
      const rows = await nominatim(q, 1);
      if (rows[0]) anchor = { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon) };
    }
  }

  // 3. Candidate query ladder — many formulations of the same address so a
  //    slightly-wrong or partially-typed address still hits the right place.
  const queries: string[] = [];
  if (addrLine) queries.push(`${addrLine}, ${city || ''}, ${state || ''}, India`);
  if (addrLine) queries.push(`${addrLine}, ${state || ''}, India`);
  if (addrLine && pin) queries.push(`${addrLine}, ${pin}, India`);
  if (addrLine && city) queries.push(`${addrLine}, ${city}, India`);
  if (addrLine && district) queries.push(`${addrLine}, ${district}, India`);
  if (pin && city) queries.push(`${city}, ${pin}, India`);
  if (pin && district) queries.push(`${district}, ${pin}, India`);
  if (city && district && state) queries.push(`${city}, ${district}, ${state}, India`);
  if (city && state) queries.push(`${city}, ${state}, India`);
  if (district && state) queries.push(`${district}, ${state}, India`);
  // Drop leading fragments progressively so "street X, layout Y, village" still
  // matches on the last, most-specific tokens even if the front is junk.
  const parts = addrLine.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  for (let keep = Math.min(parts.length, 3); keep >= 1; keep--) {
    const suffix = parts.slice(-keep).join(', ');
    if (suffix) queries.push(`${suffix}, ${state || ''}, India`);
  }

  const seen = new Set<string>();
  const ladder: string[] = [];
  for (const q of queries) {
    const k = q.replace(/\s+/g, ' ').replace(/,\s*,+/g, ',').replace(/,\s*$/g, '').replace(/,\s+/g, ', ').trim();
    if (k.length > 6 && !seen.has(k)) { seen.add(k); ladder.push(k); }
  }

  // 4. Score every candidate across all queries and pick the best.
  const stateNorm = norm(state);
  let best: any = null;
  let bestScore = -Infinity;
  let bestQuery = '';
  for (const q of ladder.slice(0, 7)) {
    const rows = await nominatim(q, 8);
    for (const r of rows) {
      const c = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
      const candState = norm(r.address?.state);
      // A candidate that positively names a DIFFERENT state is a wrong hit —
      // there are several places in India sharing the same locality name (e.g.
      // "Kaggalipura" exists in Karnataka AND Kerala). Reject it outright.
      if (stateNorm && candState && candState !== stateNorm) continue;
      let score = granularity(r);
      // A candidate in the right state beats one we cannot verify (its state
      // field was missing). Heavily penalise unverifiable hits so a same-state
      // match wins even when both are equidistant.
      if (stateNorm && !candState) score -= 60;
      if (anchor) {
        const d = haversineM(c, anchor);
        score -= Math.min(d, 100000) / 1000 * 2; // 2 pts per km of drift
      }
      if (score > bestScore) { bestScore = score; best = r; bestQuery = q; }
    }
  }

  // 5. Decide. The anchor (pincode → city → district centroid) is the region we
  //    must trust as ground truth. A candidate may override it only when it is
  //    actually CLOSE to that region — a fine/street-level hit up to ~10 km, a
  //    coarse locality hit up to ~3 km. Anything farther is a wrong hit (e.g. a
  //    different suburb sharing the locality name), so we discard it and fall
  //    back to the anchor rather than putting the marker 15–30 km away.
  if (best) {
    const c = { lat: parseFloat(best.lat), lng: parseFloat(best.lon) };
    const g = granularity(best);
    const d = anchor ? haversineM(c, anchor) : 0;
    // Unverifiable forward hit (no state envelope) → confirm by reverse geocode
    // so a same-name out-of-state place is never accepted.
    if (stateNorm && !norm(best.address?.state)) {
      const rev = await reverseState(c);
      if (rev && norm(rev) !== stateNorm) return null;
    }
    const fine = g >= FINE_LEVEL;
    if (fine && d <= MAX_FINE_RADIUS) {
      const key = bestQuery.replace(/\s+/g, ' ').trim();
      if (key) { geoCache[key] = c; saveGeoCache(); }
      return { ...c, accuracyMeters: Math.max(100, Math.min(500, Math.round(d))), source: 'geocoder' };
    }
  }

  // 6. Nothing precise enough — the region floor is still far better than a
  //    random wrong point or no location at all.
  if (anchor) {
    return { ...anchor, accuracyMeters: pin ? 800 : 1500, source: pin ? 'pincode' : 'locality' };
  }
  return null;
}
