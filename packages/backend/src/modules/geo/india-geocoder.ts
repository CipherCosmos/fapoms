import * as fs from 'fs';
import * as path from 'path';
import { calculateHaversineDistance } from '@fapoms/shared';

// Shared on-disk cache with the branch/assayer geocoders: one lookup paid,
// every record in the same place free. Persisted so a restart does not re-hit
// the geocoding API for the same pin/district.
const GEO_CACHE_FILE = path.join(__dirname, '../../infrastructure/database/geocoding-cache.json');
let geoCache: Record<string, { lat: number; lng: number }> = {};
try {
  if (fs.existsSync(GEO_CACHE_FILE)) geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
} catch { /* start with an empty cache */ }
function saveGeoCache() {
  try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache, null, 2), 'utf8'); } catch { /* non-fatal */ }
}

export interface Coord { lat: number; lng: number }
export type GeoSource = 'geocoder' | 'pincode' | 'locality' | 'none';
export interface GeocodeResult extends Coord {
  accuracyMeters: number;
  source: GeoSource;
}

/** Metres, from the one shared kilometre implementation. */
function haversineM(a: Coord, b: Coord): number {
  return calculateHaversineDistance(a.lat, a.lng, b.lat, b.lng) * 1000;
}

/** Case/space/punctuation/suffix-insensitive place name normaliser. */
function norm(s?: string | null): string {
  return (s || '')
    .toLowerCase()
    .replace(/\b(urban|rural|district|city|metro|municipality|corporation|municipal)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Google Maps is the ONLY geocoder. Requires GOOGLE_MAPS_API_KEY with the
 * Geocoding API (+ billing) enabled. Returns null on any error (bad key,
 * quota, HTTP, no result) so geocoding never blocks an import with a wrong
 * guess — callers must treat null as "unknown" rather than invent a point.
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

/** Resolves the authoritative state and district a 6-digit Indian pincode
 * belongs to, via the same Google Geocoding API. Returns null when the pin
 * can't be verified (or Google is not configured) — the caller must then skip
 * the check rather than invent one. */
export async function pincodeAuthority(pin: string): Promise<{ state: string; district: string } | null> {
  if (!/^\d{6}$/.test(pin)) return null;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pin)}&components=${encodeURIComponent('country:IN|postal_code:' + pin)}&key=${apiKey}`,
      { signal: controller.signal },
    );
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.status !== 'OK' || !data.results?.[0]) return null;
    const comps = data.results[0].address_components ?? [];
    const state = comps.find((c: any) => c.types?.includes('administrative_area_level_1'))?.long_name;
    const district =
      comps.find((c: any) => c.types?.includes('administrative_area_level_2'))?.long_name ||
      comps.find((c: any) => c.types?.includes('locality'))?.long_name ||
      comps.find((c: any) => c.types?.includes('sublocality_level_1'))?.long_name ||
      '';
    if (!state) return null;
    return { state, district };
  } catch {
    return null;
  }
}

/** Geocode an Indian address using ONLY Google Maps. No free-tier fallbacks:
 * a wrong guess from an unreliable source is worse than "unknown", so when
 * Google has no key, errors, or returns no sane in-state result, we return
 * null and let the caller treat the location as missing. */
export async function geocodeIndia(
  address: string,
  city: string,
  district: string,
  state: string,
  pincode?: string | null,
): Promise<GeocodeResult | null> {
  if (!process.env.GOOGLE_MAPS_API_KEY) return null;
  const pin = pincode || (address || '').match(/\b\d{6}\b/)?.[0] || null;
  return googleGeocode(address, city, district, state, pin);
}
