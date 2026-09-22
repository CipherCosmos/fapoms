/**
 * FAPOMS — one place that decides what a record's coordinate is.
 *
 * Branches and assayers both geocode on create, on update, on import and on backfill. That is
 * six call sites for the same three rules, and the rules are the kind that fail silently when
 * one copy drifts:
 *
 *   1. A coordinate someone typed or dropped on a map wins over anything a geocoder says.
 *   2. A `manual` pin is never overwritten by a re-geocode, at any precision.
 *   3. Whatever is stored, its tier and radius are stored with it — a coordinate whose
 *      provenance is unknown is indistinguishable from a state centroid, and every distance
 *      decision downstream reads it as if it were exact.
 *
 * Rule 2 is the one that would hurt most if it drifted: a backfill that overwrites hand-placed
 * pins destroys the only genuinely precise data in the table, and does it quietly, to the
 * records someone cared enough to fix.
 */

import { geocodeIndiaRobust } from './india-geocoder';
import { GeoPrecision, PRECISION_METERS } from './osm-geocoder';
export { PRECISION_METERS };

/** The geo columns branches and assayers share. */
export interface GeoFields {
  latitude: number | null;
  longitude: number | null;
  location: { type: 'Point'; coordinates: [number, number] } | null;
  geoSource: string | null;
  geoAccuracyMeters: number | null;
  geoMatchedName: string | null;
  geoResolvedAt: Date | null;
}

export interface ResolveRequest {
  address?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pincode?: string | null;
  /** The record's own name — the strongest signal for finding it mapped in OSM. */
  name?: string | null;
  /** Client/brand name, e.g. "State Bank of India". */
  brand?: string | null;
  /** Coordinates supplied by the caller (an import sheet column, or a map pin). */
  suppliedLat?: number | null;
  suppliedLng?: number | null;
  /**
   * True when the supplied pair came from a person rather than a spreadsheet. Marks the result
   * `manual`, which pins it against every future re-geocode.
   */
  suppliedIsManual?: boolean;
  /**
   * Consult the rate-limited free OSM tiers. Default true. Bulk loops pass false and let the
   * backfill upgrade precision afterwards — see geocodeIndiaRobust.
   */
  precise?: boolean;
}

const POINT = (lat: number, lng: number) =>
  ({ type: 'Point', coordinates: [lng, lat] }) as { type: 'Point'; coordinates: [number, number] };

/** A coordinate pair that could actually be in India, as opposed to 0/0 or a transposed pair. */
export function isPlausibleIndianCoord(lat: unknown, lng: unknown): boolean {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === 0 && ln === 0) return false;
  return la >= 6.4 && la <= 37.7 && ln >= 68.0 && ln <= 97.5;
}

/**
 * Parses user input into a validated Indian coordinate pair.
 * Supports:
 * - Google Maps URLs (e.g. maps.google.com/?q=19.07,72.87 or /@19.07,72.87)
 * - Decimal strings ("19.0760, 72.8777" or "19.0760 72.8777")
 * - Transposed coordinates (in India, lat is 6-38° and lng is 68-98°; automatically fixed)
 * - DMS notation ("19°04'33.6\"N 72°52'39.7\"E")
 */
export function parseLocationInput(input?: string | null): { lat: number; lng: number } | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // 1. Google Maps URL pattern: /@([0-9.-]+),([0-9.-]+) or ?q=([0-9.-]+),([0-9.-]+) or query=([0-9.-]+),([0-9.-]+)
  const urlMatch = raw.match(/[@?&](?:q|query)?=?([0-9.-]+),([0-9.-]+)/);
  if (urlMatch) {
    const p1 = parseFloat(urlMatch[1]);
    const p2 = parseFloat(urlMatch[2]);
    if (isPlausibleIndianCoord(p1, p2)) return { lat: p1, lng: p2 };
    if (isPlausibleIndianCoord(p2, p1)) return { lat: p2, lng: p1 };
  }

  // 2. DMS pattern: e.g. 19°4'33"N 72°52'39"E
  const dmsRegex = /(\d+)[°\s]+(\d+)['\s]+([\d.]+)?["\s]*([NSEW])/gi;
  const dmsMatches = [...raw.matchAll(dmsRegex)];
  if (dmsMatches.length >= 2) {
    let lat: number | null = null;
    let lng: number | null = null;
    for (const m of dmsMatches) {
      const deg = parseFloat(m[1]);
      const min = parseFloat(m[2]) || 0;
      const sec = parseFloat(m[3]) || 0;
      const dir = m[4].toUpperCase();
      const dec = deg + min / 60 + sec / 3600;
      if (dir === 'N') lat = dec;
      else if (dir === 'S') lat = -dec;
      else if (dir === 'E') lng = dec;
      else if (dir === 'W') lng = -dec;
    }
    if (lat !== null && lng !== null) {
      if (isPlausibleIndianCoord(lat, lng)) return { lat, lng };
    }
  }

  // 3. Plain decimal pair: e.g. "19.0760, 72.8777" or "19.0760 72.8777"
  const decMatch = raw.match(/([+-]?\d+(?:\.\d+)?)[,\s/]+([+-]?\d+(?:\.\d+)?)/);
  if (decMatch) {
    const p1 = parseFloat(decMatch[1]);
    const p2 = parseFloat(decMatch[2]);
    if (isPlausibleIndianCoord(p1, p2)) return { lat: p1, lng: p2 };
    // Transposition check: if someone entered lng, lat (e.g. 72.87, 19.07)
    if (isPlausibleIndianCoord(p2, p1)) return { lat: p2, lng: p1 };
  }

  return null;
}

/**
 * Resolve the geo columns for a record, or null when there is nothing to change.
 *
 * `existing` is the row as it stands. Passing it is what enforces rule 2: a manual pin short-
 * circuits everything below and the function returns null, meaning "leave this row alone".
 */
export async function resolveCoordinates(
  request: ResolveRequest,
  existing?: Pick<GeoFields, 'geoSource' | 'latitude' | 'longitude'> | null,
): Promise<GeoFields | null> {
  // Rule 2. Deliberately before the supplied-coordinate branch as well: an import sheet must
  // not silently undo a hand-placed pin either, and a re-import of the client's original file
  // is exactly when that would happen.
  if (existing?.geoSource === 'manual' && !request.suppliedIsManual) return null;

  // Rule 1.
  if (isPlausibleIndianCoord(request.suppliedLat, request.suppliedLng)) {
    const lat = Number(request.suppliedLat);
    const lng = Number(request.suppliedLng);
    const precision: GeoPrecision = request.suppliedIsManual ? 'manual' : 'geocoder';
    return {
      latitude: lat,
      longitude: lng,
      location: POINT(lat, lng),
      geoSource: precision,
      geoAccuracyMeters: PRECISION_METERS[precision],
      geoMatchedName: request.suppliedIsManual ? 'Placed by hand' : 'Supplied with the record',
      geoResolvedAt: new Date(),
    };
  }

  const result = await geocodeIndiaRobust(
    request.address || '',
    request.city || '',
    request.district || '',
    request.state || '',
    request.pincode,
    { precise: request.precise !== false, name: request.name, brand: request.brand },
  );

  return {
    latitude: result.lat,
    longitude: result.lng,
    location: POINT(result.lat, result.lng),
    geoSource: result.source,
    geoAccuracyMeters: Math.round(result.accuracyMeters),
    geoMatchedName: result.matchedName ?? null,
    geoResolvedAt: new Date(),
  };
}

/**
 * Is this coordinate too coarse to plan against?
 *
 * The serviceability radius the planner works in is ~50 km, so anything whose own error bar
 * approaches that is not a location, it is a placeholder — a district or state centroid. These
 * are the rows the backfill targets and the UI flags for a manual pin.
 */
export function needsBetterFix(geoSource: string | null, accuracyMeters: number | null): boolean {
  if (geoSource === 'manual') return false;
  if (geoSource === null || accuracyMeters === null) return true;
  return accuracyMeters > IMPROVABLE_ABOVE_METERS;
}

/**
 * Coarser than this and the row is worth another look.
 *
 * The bar used to sit at the pincode tier, which meant a 3 km centroid counted as finished: the
 * selection query skipped it and the "only write if better" rule refused to replace it. That was
 * the right call while the address lookup asked one question it could not answer — the whole
 * postal address went in as Nominatim's `street`, which ANDs its components, so a detailed
 * address and a bare one produced the same 3 km answer and retrying only burned lookups.
 *
 * `nominatimSearch` now works down a ladder of candidates parsed out of the address, and reaches
 * street and building level where OSM holds the data. So a pincode centroid is no longer the best
 * available answer, it is the answer of last resort — and the bar belongs one tier finer, where a
 * row that could be placed on its own street is not left sitting in the middle of its postcode.
 *
 * Rows whose address contains nothing a map could match are excluded before this by the caller
 * (`isAddressUsable`); there is no ladder to climb for those and they are a record to fix, which
 * is what the workforce flag is for.
 */
const IMPROVABLE_ABOVE_METERS = PRECISION_METERS.osm_locality;
