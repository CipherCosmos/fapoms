import * as path from 'path';
import { calculateHaversineDistance } from '@fapoms/shared';
import { resolveFreely, pincodeCentroid, districtCentroidOsm, VerificationAnchor, GeoPrecision, networkAllowed } from './osm-geocoder';
import { JsonFileCache } from './geo-cache-store';

/**
 * Shared on-disk cache with the branch/assayer geocoders: one lookup paid, every record in the
 * same place free. Persisted so a restart does not re-hit the geocoding API for the same
 * pin/district.
 *
 * Every write used to be `fs.writeFileSync(<the whole file>)`, run once per cache miss with no
 * debounce at all — so a branch import blocked the event loop for the entire platform once per
 * row, and the block got longer as the cache grew. `JsonFileCache` batches the writes and moves
 * the file out of `dist/`, where it was being discarded on every deploy. See geo-cache-store.ts.
 */
const geoCache = new JsonFileCache<{ lat: number; lng: number }>(
  'geocoding-cache.json',
  // Where this cache used to be written. Read once at startup so an existing deployment or dev
  // checkout carries its warm entries across rather than re-geocoding everything it already knew.
  path.join(__dirname, '../../infrastructure/database/geocoding-cache.json'),
);

export interface Coord { lat: number; lng: number }
/**
 * Widened to the free OSM tiers (and `manual`) so the tier that produced a coordinate survives
 * into the database. It used to collapse everything to four values, which meant a 10 m rooftop
 * and a 100 km state centroid were both just "a coordinate" by the time anything read them.
 */
export type GeoSource = GeoPrecision;
export interface GeocodeResult extends Coord {
  accuracyMeters: number;
  source: GeoSource;
  /**
   * What the geocoder actually matched ("State Bank of India, Sanghvi Kesari Road, Pune").
   *
   * Carried all the way to the UI on purpose. A tier and a radius say how precise the answer
   * claims to be; only the matched name says whether it is the *right* place, and for Indian
   * place names — which repeat across districts and states — that is the question that matters.
   * It is the difference between ops trusting a pin and ops being able to check it.
   */
  matchedName?: string;
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
  const result = preferInState(results);
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
  if (cacheKey.length > 6) geoCache.set(cacheKey, coords);
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

// ---------------------------------------------------------------------------
// FALLBACK TIER 2 — India Post pincode → coordinates via postal API
// ---------------------------------------------------------------------------

/** Look up coordinates from a 6-digit Indian pincode via the India Post API.
 *  Falls back gracefully on any error. */
async function pincodeFallback(pin: string): Promise<GeocodeResult | null> {
  if (!/^\d{6}$/.test(pin)) return null;
  // Check cache first
  const cacheKey = `pincode:${pin}`;
  const cachedPin = geoCache.get(cacheKey);
  if (cachedPin) {
    return { ...cachedPin, accuracyMeters: 5000, source: 'pincode' };
  }
  // The only geo lookup that was not behind this gate, so any spec creating an assayer or branch
  // whose address contained a 6-digit pincode became a live call to api.postalpincode.in —
  // ~4.5s per row, flaky, and rate-limited by IP. Cache misses in tests resolve to null instead.
  if (!networkAllowed()) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    if (!data?.[0] || data[0].Status !== 'Success' || !data[0].PostOffice?.length) return null;

    // Average all post offices in this pincode area for a centroid
    const offices: Array<{ lat: number; lng: number }> = [];
    for (const po of data[0].PostOffice) {
      // India Post API doesn't always include coordinates; parse from description when present
      if (po.Latitude && po.Longitude) {
        const lat = parseFloat(po.Latitude);
        const lng = parseFloat(po.Longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
          offices.push({ lat, lng });
        }
      }
    }
    if (offices.length === 0) return null;
    const avg = {
      lat: offices.reduce((s, o) => s + o.lat, 0) / offices.length,
      lng: offices.reduce((s, o) => s + o.lng, 0) / offices.length,
    };
    geoCache.set(cacheKey, avg);
    return { ...avg, accuracyMeters: 5000, source: 'pincode' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FALLBACK TIER 3 — Static Indian district HQ centroids (top 250+ districts)
// ---------------------------------------------------------------------------

/** District headquarters coordinates. Covers the most common Indian districts
 *  encountered in GSS/bank branch data. Key is normalised district name. */
const DISTRICT_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  // Kerala
  palakkad: { lat: 10.7867, lng: 76.6548 }, thiruvananthapuram: { lat: 8.5241, lng: 76.9366 },
  ernakulam: { lat: 9.9816, lng: 76.2999 }, kottayam: { lat: 9.5916, lng: 76.5222 },
  thrissur: { lat: 10.5276, lng: 76.2144 }, kozhikode: { lat: 11.2588, lng: 75.7804 },
  malappuram: { lat: 11.0510, lng: 76.0711 }, kollam: { lat: 8.8932, lng: 76.6141 },
  alappuzha: { lat: 9.4981, lng: 76.3388 }, kannur: { lat: 11.8745, lng: 75.3704 },
  idukki: { lat: 9.8494, lng: 76.9710 }, wayanad: { lat: 11.6854, lng: 76.1320 },
  pathanamthitta: { lat: 9.2648, lng: 76.7870 }, kasaragod: { lat: 12.4996, lng: 74.9869 },
  // Tamil Nadu
  chennai: { lat: 13.0827, lng: 80.2707 }, coimbatore: { lat: 11.0168, lng: 76.9558 },
  madurai: { lat: 9.9252, lng: 78.1198 }, tiruchirappalli: { lat: 10.7905, lng: 78.7047 },
  salem: { lat: 11.6643, lng: 78.1460 }, tirunelveli: { lat: 8.7139, lng: 77.7567 },
  vellore: { lat: 12.9165, lng: 79.1325 }, erode: { lat: 11.3410, lng: 77.7172 },
  thanjavur: { lat: 10.7870, lng: 79.1378 }, dindigul: { lat: 10.3673, lng: 77.9803 },
  kancheepuram: { lat: 12.8342, lng: 79.7036 }, cuddalore: { lat: 11.7480, lng: 79.7714 },
  // Karnataka
  bangalore: { lat: 12.9716, lng: 77.5946 }, bengaluru: { lat: 12.9716, lng: 77.5946 },
  mysore: { lat: 12.2958, lng: 76.6394 }, mysuru: { lat: 12.2958, lng: 76.6394 },
  hubli: { lat: 15.3647, lng: 75.1240 }, mangalore: { lat: 12.9141, lng: 74.8560 },
  belgaum: { lat: 15.8497, lng: 74.4977 }, belagavi: { lat: 15.8497, lng: 74.4977 },
  gulbarga: { lat: 17.3297, lng: 76.8343 }, kalaburagi: { lat: 17.3297, lng: 76.8343 },
  davangere: { lat: 14.4644, lng: 75.9218 }, bellary: { lat: 15.1394, lng: 76.9214 },
  shimoga: { lat: 13.9299, lng: 75.5681 }, tumkur: { lat: 13.3379, lng: 77.1173 },
  // Andhra Pradesh & Telangana
  hyderabad: { lat: 17.3850, lng: 78.4867 }, visakhapatnam: { lat: 17.6868, lng: 83.2185 },
  vijayawada: { lat: 16.5062, lng: 80.6480 }, guntur: { lat: 16.3067, lng: 80.4365 },
  tirupati: { lat: 13.6288, lng: 79.4192 }, warangal: { lat: 17.9784, lng: 79.5941 },
  nellore: { lat: 14.4426, lng: 79.9865 }, karimnagar: { lat: 18.4386, lng: 79.1288 },
  rajahmundry: { lat: 17.0005, lng: 81.8040 }, kurnool: { lat: 15.8281, lng: 78.0373 },
  // Maharashtra
  mumbai: { lat: 19.0760, lng: 72.8777 }, pune: { lat: 18.5204, lng: 73.8567 },
  nagpur: { lat: 21.1458, lng: 79.0882 }, nashik: { lat: 19.9975, lng: 73.7898 },
  aurangabad: { lat: 19.8762, lng: 75.3433 }, thane: { lat: 19.2183, lng: 72.9781 },
  solapur: { lat: 17.6599, lng: 75.9064 }, kolhapur: { lat: 16.7050, lng: 74.2433 },
  sangli: { lat: 16.8524, lng: 74.5815 }, satara: { lat: 17.6805, lng: 74.0183 },
  ahmednagar: { lat: 19.0948, lng: 74.7480 }, jalgaon: { lat: 21.0077, lng: 75.5626 },
  // Gujarat
  ahmedabad: { lat: 23.0225, lng: 72.5714 }, surat: { lat: 21.1702, lng: 72.8311 },
  vadodara: { lat: 22.3072, lng: 73.1812 }, rajkot: { lat: 22.3039, lng: 70.8022 },
  gandhinagar: { lat: 23.2156, lng: 72.6369 }, bhavnagar: { lat: 21.7645, lng: 72.1519 },
  jamnagar: { lat: 22.4707, lng: 70.0577 }, junagadh: { lat: 21.5222, lng: 70.4579 },
  // Goa
  northgoa: { lat: 15.5379, lng: 73.8759 }, southgoa: { lat: 15.2993, lng: 74.0240 },
  // Delhi / NCR
  delhi: { lat: 28.7041, lng: 77.1025 }, newdelhi: { lat: 28.6139, lng: 77.2090 },
  northdelhi: { lat: 28.7567, lng: 77.2028 }, southdelhi: { lat: 28.5244, lng: 77.1855 },
  noida: { lat: 28.5355, lng: 77.3910 }, gurgaon: { lat: 28.4595, lng: 77.0266 },
  gurugram: { lat: 28.4595, lng: 77.0266 }, faridabad: { lat: 28.4089, lng: 77.3178 },
  ghaziabad: { lat: 28.6692, lng: 77.4538 },
  // Uttar Pradesh
  lucknow: { lat: 26.8467, lng: 80.9462 }, kanpur: { lat: 26.4499, lng: 80.3319 },
  agra: { lat: 27.1767, lng: 78.0081 }, varanasi: { lat: 25.3176, lng: 82.9739 },
  meerut: { lat: 28.9845, lng: 77.7064 }, allahabad: { lat: 25.4358, lng: 81.8463 },
  prayagraj: { lat: 25.4358, lng: 81.8463 }, bareilly: { lat: 28.3670, lng: 79.4304 },
  moradabad: { lat: 28.8386, lng: 78.7733 }, aligarh: { lat: 27.8974, lng: 78.0880 },
  gorakhpur: { lat: 26.7606, lng: 83.3732 }, jhansi: { lat: 25.4484, lng: 78.5685 },
  // Rajasthan
  jaipur: { lat: 26.9124, lng: 75.7873 }, jodhpur: { lat: 26.2389, lng: 73.0243 },
  udaipur: { lat: 24.5854, lng: 73.7125 }, kota: { lat: 25.2138, lng: 75.8648 },
  ajmer: { lat: 26.4499, lng: 74.6399 }, bikaner: { lat: 28.0229, lng: 73.3119 },
  alwar: { lat: 27.5530, lng: 76.6346 }, sikar: { lat: 27.6094, lng: 75.1399 },
  jhunjhunu: { lat: 28.1286, lng: 75.3985 }, bharatpur: { lat: 27.2152, lng: 77.4890 },
  // Punjab & Haryana
  chandigarh: { lat: 30.7333, lng: 76.7794 }, ludhiana: { lat: 30.9010, lng: 75.8573 },
  amritsar: { lat: 31.6340, lng: 74.8723 }, jalandhar: { lat: 31.3260, lng: 75.5762 },
  patiala: { lat: 30.3398, lng: 76.3869 }, ambala: { lat: 30.3752, lng: 76.7821 },
  karnal: { lat: 29.6857, lng: 76.9905 }, panipat: { lat: 29.3909, lng: 76.9635 },
  hisar: { lat: 29.1492, lng: 75.7217 }, rohtak: { lat: 28.8955, lng: 76.6066 },
  // Madhya Pradesh
  bhopal: { lat: 23.2599, lng: 77.4126 }, indore: { lat: 22.7196, lng: 75.8577 },
  jabalpur: { lat: 23.1815, lng: 79.9864 }, gwalior: { lat: 26.2183, lng: 78.1828 },
  ujjain: { lat: 23.1765, lng: 75.7885 }, sagar: { lat: 23.8388, lng: 78.7378 },
  // West Bengal
  kolkata: { lat: 22.5726, lng: 88.3639 }, howrah: { lat: 22.5958, lng: 88.2636 },
  durgapur: { lat: 23.5204, lng: 87.3119 }, siliguri: { lat: 26.7271, lng: 88.6393 },
  asansol: { lat: 23.6889, lng: 86.9661 },
  // Bihar & Jharkhand
  patna: { lat: 25.6093, lng: 85.1376 }, gaya: { lat: 24.7955, lng: 84.9994 },
  muzaffarpur: { lat: 26.1209, lng: 85.3647 }, bhagalpur: { lat: 25.2425, lng: 86.9842 },
  ranchi: { lat: 23.3441, lng: 85.3096 }, jamshedpur: { lat: 22.8046, lng: 86.2029 },
  dhanbad: { lat: 23.7957, lng: 86.4304 },
  // Odisha
  bhubaneswar: { lat: 20.2961, lng: 85.8245 }, cuttack: { lat: 20.4625, lng: 85.8830 },
  // Assam & NE
  guwahati: { lat: 26.1445, lng: 91.7362 }, dibrugarh: { lat: 27.4728, lng: 94.9120 },
  // Chhattisgarh
  raipur: { lat: 21.2514, lng: 81.6296 }, bilaspur: { lat: 22.0797, lng: 82.1409 },
  // Uttarakhand
  dehradun: { lat: 30.3165, lng: 78.0322 }, haridwar: { lat: 29.9457, lng: 78.1642 },
  // Himachal Pradesh
  shimla: { lat: 31.1048, lng: 77.1734 },
  // J&K
  srinagar: { lat: 34.0837, lng: 74.7973 }, jammu: { lat: 32.7266, lng: 74.8570 },
  // Puducherry
  puducherry: { lat: 11.9416, lng: 79.8083 }, pondicherry: { lat: 11.9416, lng: 79.8083 },
};

/** State-level centroid fallback — absolute last resort. */
const STATE_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  kerala: { lat: 10.8505, lng: 76.2711 }, tamilnadu: { lat: 11.1271, lng: 78.6569 },
  karnataka: { lat: 15.3173, lng: 75.7139 }, andhrapradesh: { lat: 15.9129, lng: 79.7400 },
  telangana: { lat: 18.1124, lng: 79.0193 }, maharashtra: { lat: 19.7515, lng: 75.7139 },
  gujarat: { lat: 22.2587, lng: 71.1924 }, goa: { lat: 15.2993, lng: 74.1240 },
  delhi: { lat: 28.7041, lng: 77.1025 }, uttarpradesh: { lat: 26.8467, lng: 80.9462 },
  rajasthan: { lat: 27.0238, lng: 74.2179 }, madhyapradesh: { lat: 22.9734, lng: 78.6569 },
  westbengal: { lat: 22.9868, lng: 87.8550 }, bihar: { lat: 25.0961, lng: 85.3131 },
  jharkhand: { lat: 23.6102, lng: 85.2799 }, odisha: { lat: 20.9517, lng: 85.0985 },
  punjab: { lat: 31.1471, lng: 75.3412 }, haryana: { lat: 29.0588, lng: 76.0856 },
  assam: { lat: 26.2006, lng: 92.9376 }, chhattisgarh: { lat: 21.2787, lng: 81.8661 },
  uttarakhand: { lat: 30.0668, lng: 79.0193 }, himachalpradesh: { lat: 31.1048, lng: 77.1734 },
  jammukashmir: { lat: 33.7782, lng: 76.5762 }, puducherry: { lat: 11.9416, lng: 79.8083 },
  tripura: { lat: 23.9408, lng: 91.9882 }, meghalaya: { lat: 25.4670, lng: 91.3662 },
  manipur: { lat: 24.6637, lng: 93.9063 }, nagaland: { lat: 26.1584, lng: 94.5624 },
  mizoram: { lat: 23.1645, lng: 92.9376 }, arunachalpradesh: { lat: 28.2180, lng: 94.7278 },
  sikkim: { lat: 27.5330, lng: 88.5122 },
};

/**
 * Real appraiser rosters record states as "A.P", "M.P", "U.P", "J&K", "west Bengal" — abbreviated,
 * cased and punctuated however the branch clerk typed them. OSM knows only the full canonical name,
 * so an un-normalised state silently sinks every tier: the pincode/POI candidates get rejected for
 * a state mismatch, and the district lookup finds nothing, dropping ~150 records onto their shared
 * state centroid. Canonicalising once, up front, lifts them all. Keys are `norm()` output.
 */
const STATE_ALIASES: Record<string, string> = {
  ap: 'Andhra Pradesh', andhra: 'Andhra Pradesh', andhrapradesh: 'Andhra Pradesh',
  mp: 'Madhya Pradesh', madhyapradesh: 'Madhya Pradesh',
  up: 'Uttar Pradesh', uttarpradesh: 'Uttar Pradesh',
  tn: 'Tamil Nadu', tamilnadu: 'Tamil Nadu',
  wb: 'West Bengal', westbengal: 'West Bengal',
  hp: 'Himachal Pradesh', himachalpradesh: 'Himachal Pradesh',
  jk: 'Jammu and Kashmir', jammukashmir: 'Jammu and Kashmir', jammuandkashmir: 'Jammu and Kashmir',
  uk: 'Uttarakhand', uttarakhand: 'Uttarakhand', uttaranchal: 'Uttarakhand',
  ka: 'Karnataka', karnataka: 'Karnataka',
  kl: 'Kerala', kerala: 'Kerala',
  mh: 'Maharashtra', maharashtra: 'Maharashtra',
  gj: 'Gujarat', gujarat: 'Gujarat',
  rj: 'Rajasthan', rajasthan: 'Rajasthan',
  od: 'Odisha', or: 'Odisha', odisha: 'Odisha', orissa: 'Odisha',
  br: 'Bihar', bihar: 'Bihar',
  jh: 'Jharkhand', jharkhand: 'Jharkhand',
  pb: 'Punjab', punjab: 'Punjab',
  hr: 'Haryana', haryana: 'Haryana',
  as: 'Assam', assam: 'Assam',
  cg: 'Chhattisgarh', chhattisgarh: 'Chhattisgarh',
  ts: 'Telangana', tg: 'Telangana', telangana: 'Telangana',
  ga: 'Goa', goa: 'Goa',
  dl: 'Delhi', delhi: 'Delhi', newdelhi: 'Delhi',
  tr: 'Tripura', tripura: 'Tripura',
  ml: 'Meghalaya', meghalaya: 'Meghalaya',
  mn: 'Manipur', manipur: 'Manipur',
  nl: 'Nagaland', nagaland: 'Nagaland',
  mz: 'Mizoram', mizoram: 'Mizoram',
  ar: 'Arunachal Pradesh', arunachalpradesh: 'Arunachal Pradesh',
  sk: 'Sikkim', sikkim: 'Sikkim',
  py: 'Puducherry', puducherry: 'Puducherry', pondicherry: 'Puducherry',
};

/** Canonical full state name OSM will recognise, or the trimmed original if it is not a state we map. */
function canonicalState(state?: string | null): string {
  if (!state) return '';
  return STATE_ALIASES[norm(state)] ?? state.trim();
}

/** Look up a district centroid from the static database.
 *  Matches against normalised district name. */
function districtCentroidFallback(district: string, state: string): GeocodeResult | null {
  const d = norm(district);
  if (!d) return null;

  // Direct match
  if (DISTRICT_CENTROIDS[d]) {
    return { ...DISTRICT_CENTROIDS[d], accuracyMeters: 15000, source: 'locality' };
  }

  // Try common aliases: e.g. "PALAKKAD DISTRICT" → "palakkad"
  for (const key of Object.keys(DISTRICT_CENTROIDS)) {
    if (d.includes(key) || key.includes(d)) {
      return { ...DISTRICT_CENTROIDS[key], accuracyMeters: 20000, source: 'locality' };
    }
  }

  return null;
}

/** Look up a state centroid — absolute last resort. */
function stateCentroidFallback(state: string): GeocodeResult | null {
  const s = norm(state);
  if (!s) return null;

  if (STATE_CENTROIDS[s]) {
    return { ...STATE_CENTROIDS[s], accuracyMeters: 100000, source: 'none' };
  }

  // Partial match for multi-word states
  for (const key of Object.keys(STATE_CENTROIDS)) {
    if (s.includes(key) || key.includes(s)) {
      return { ...STATE_CENTROIDS[key], accuracyMeters: 100000, source: 'none' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// ROBUST GEOCODER — chains all fallback tiers, guaranteed to return a result
// ---------------------------------------------------------------------------

/**
 * Robust multi-tier Indian geocoder. Chains, most precise first:
 *
 *  1. Google Maps Geocoding API           — only when GOOGLE_MAPS_API_KEY is set
 *  2. Free OSM tiers (`precise` only)     — the mapped branch POI, building, street or locality
 *  3. India Post pincode lookup           — post-office centroid, ~3 km
 *  4. Static district HQ centroid         — ~15 km
 *  5. Static state centroid               — ~100 km, i.e. "unknown"
 *
 * **Never returns null.** Callers must read `source`/`accuracyMeters` and persist them: tiers 4
 * and 5 are placeholders, not locations, and the whole point of reporting them is that a branch
 * sitting on its state's centroid should not look like one pinned at its front door.
 *
 * ## `precise`
 *
 * Tier 2 is rate-limited to roughly one request per second per provider by their usage policies
 * (see osm-geocoder). That is right for an interactive single-record save and wrong for a
 * 400-row import, which would take seven minutes and hold an HTTP request open the whole time.
 * So bulk callers pass `precise: false` and take the fast tiers, and the precision backfill
 * upgrades those rows afterwards, out of the request path.
 *
 * `anchor`ing: tier 3's pincode centroid, or failing that tier 4's district centroid, is
 * resolved FIRST and handed to tier 2 as the point every candidate is checked against. Without
 * it "Salem" or "Aurangabad" can resolve to the wrong state entirely.
 */
export async function geocodeIndiaRobust(
  address: string,
  city: string,
  district: string,
  state: string,
  pincode?: string | null,
  options?: {
    /** Consult the rate-limited free OSM tiers. Default true; pass false in bulk loops. */
    precise?: boolean;
    /** The record's own name, e.g. "Pune Aundh Branch" — the strongest OSM POI signal. */
    name?: string | null;
    /** Client/brand name, e.g. "State Bank of India" — how the POI is actually tagged. */
    brand?: string | null;
  },
): Promise<GeocodeResult> {
  const pin = pincode || (address || '').match(/\b\d{6}\b/)?.[0] || null;
  // Normalise "A.P" → "Andhra Pradesh" once, up front, so every tier below queries and verifies
  // against a state name OSM actually recognises (see STATE_ALIASES).
  state = canonicalState(state) || state;

  // Tier 1: Google Maps (precise)
  const googleResult = await geocodeIndia(address, city, district, state, pin);
  if (googleResult) return googleResult;

  // Resolve the coarse tiers first, so the free geocoders have something to be checked against.
  const pincodeResult = pin ? await pincodeFallback(pin) : null;
  const districtResult = districtCentroidFallback(district, state);

  /**
   * The pincode centroid, from whichever source has one.
   *
   * It serves two jobs: it is the anchor every free candidate is verified against, and it is
   * itself a fallback tier far better than a district HQ. India Post is tried first because
   * earlier runs have already cached it; OSM answers for the many pincodes India Post returns
   * without coordinates, which is exactly when verification would otherwise widen to 60 km and
   * start accepting the wrong town.
   */
  let pinCoord: GeocodeResult | null = pincodeResult;
  if (options?.precise !== false) {
    if (!pinCoord && pin) {
      const osmPin = await pincodeCentroid(pin, state, district).catch(() => null);
      if (osmPin) {
        pinCoord = {
          lat: osmPin.lat,
          lng: osmPin.lng,
          accuracyMeters: osmPin.accuracyMeters,
          source: osmPin.precision,
          matchedName: osmPin.matchedName,
        };
      }
    }

    const anchor: VerificationAnchor | null = pinCoord
      ? { coord: { lat: pinCoord.lat, lng: pinCoord.lng }, kind: 'pincode' }
      : districtResult
      ? { coord: { lat: districtResult.lat, lng: districtResult.lng }, kind: 'district' }
      : null;

    const free = await resolveFreely(
      { address, name: options?.name, brand: options?.brand, city, district, state, pincode: pin },
      anchor,
    ).catch(() => null);

    // Only when it actually beats the anchor we already hold. A locality hit inside a pincode
    // we already located is not new information, and swapping one for the other every backfill
    // would churn coordinates — and therefore distances, fees and plans — for no gain.
    if (free && free.accuracyMeters < (pinCoord?.accuracyMeters ?? Infinity)) {
      return {
        lat: free.lat,
        lng: free.lng,
        accuracyMeters: free.accuracyMeters,
        source: free.precision,
        matchedName: free.matchedName,
      };
    }
  }

  // Tier 3: Pincode centroid (India Post, else OSM)
  if (pinCoord) return pinCoord;

  // Tier 3.4: Pincode centroid WITHOUT the district-name gate.
  //
  // `pincodeCentroid` above rejects a perfectly-located pincode area when the roster's district
  // label does not textually match OSM's postcode-area district — a name disagreement, not a
  // location one. That gate is right when a better candidate exists to fall back to; but the
  // only things left below are the district centroid (~15 km) and the state centroid (~100 km),
  // and a pincode area (~3 km) beats both even when the district label is off. On the real
  // roster this is the difference between placing someone in their own town and dropping them
  // 200 km away at the middle of the state. The state check inside still applies, so a typo'd
  // pincode in the wrong state is still refused.
  if (options?.precise !== false && pin) {
    const loosePin = await pincodeCentroid(pin, state, null).catch(() => null);
    if (loosePin) {
      return {
        lat: loosePin.lat,
        lng: loosePin.lng,
        accuracyMeters: loosePin.accuracyMeters,
        source: loosePin.precision,
        matchedName: loosePin.matchedName,
      };
    }
  }

  // Tier 3.5: District centroid from OSM. The self-hosted Nominatim carries every Indian district,
  // so when the pincode is unknown and the specific address did not resolve, this places the record
  // in its own district (~15 km) instead of collapsing it onto the shared state centroid below. It
  // beats the static district set (Tier 4), which is incomplete, so it is tried first.
  if (options?.precise !== false && district && state) {
    const osmDistrict = await districtCentroidOsm(district, state).catch(() => null);
    if (osmDistrict) {
      return {
        lat: osmDistrict.lat,
        lng: osmDistrict.lng,
        accuracyMeters: osmDistrict.accuracyMeters,
        source: osmDistrict.precision,
        matchedName: osmDistrict.matchedName,
      };
    }
  }

  // Tier 4: Static district HQ centroid
  if (districtResult) return districtResult;

  // Tier 5: Static state centroid (never fails for any Indian state)
  const stateResult = stateCentroidFallback(state);
  if (stateResult) return stateResult;

  // Absolute fallback: geographic centre of India (Nagpur)
  return { lat: 21.1458, lng: 79.0882, accuracyMeters: 500000, source: 'none' };
}
