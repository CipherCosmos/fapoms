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
  return accuracyMeters > PRECISION_METERS.pincode;
}
