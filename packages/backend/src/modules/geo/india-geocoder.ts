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

// ---------------------------------------------------------------------------
// FALLBACK TIER 2 — India Post pincode → coordinates via postal API
// ---------------------------------------------------------------------------

/** Look up coordinates from a 6-digit Indian pincode via the India Post API.
 *  Falls back gracefully on any error. */
async function pincodeFallback(pin: string): Promise<GeocodeResult | null> {
  if (!/^\d{6}$/.test(pin)) return null;
  // Check cache first
  const cacheKey = `pincode:${pin}`;
  if (geoCache[cacheKey]) {
    return { ...geoCache[cacheKey], accuracyMeters: 5000, source: 'pincode' };
  }
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
    geoCache[cacheKey] = avg;
    saveGeoCache();
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

/** Robust multi-tier Indian geocoder. Chains:
 *  1. Google Maps Geocoding API (most accurate)
 *  2. India Post pincode lookup (locality-level accuracy)
 *  3. Static district HQ centroid database (district-level accuracy)
 *  4. Static state centroid (state-level, last resort)
 *
 *  **Never returns null** — worst case returns state centroid with source='none'
 *  and accuracyMeters=100000. Callers should check `source` and `accuracyMeters`
 *  to decide whether to flag the branch for manual review. */
export async function geocodeIndiaRobust(
  address: string,
  city: string,
  district: string,
  state: string,
  pincode?: string | null,
): Promise<GeocodeResult> {
  const pin = pincode || (address || '').match(/\b\d{6}\b/)?.[0] || null;

  // Tier 1: Google Maps (precise)
  const googleResult = await geocodeIndia(address, city, district, state, pin);
  if (googleResult) return googleResult;

  // Tier 2: Pincode lookup via India Post API
  if (pin) {
    const pincodeResult = await pincodeFallback(pin);
    if (pincodeResult) return pincodeResult;
  }

  // Tier 3: Static district HQ centroid
  const districtResult = districtCentroidFallback(district, state);
  if (districtResult) return districtResult;

  // Tier 4: Static state centroid (never fails for any Indian state)
  const stateResult = stateCentroidFallback(state);
  if (stateResult) return stateResult;

  // Absolute fallback: geographic centre of India (Nagpur)
  return { lat: 21.1458, lng: 79.0882, accuracyMeters: 500000, source: 'none' };
}
