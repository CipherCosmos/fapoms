/**
 * The `POST /pricing/quote` body the assign form asks for, and what the answer means for the day.
 *
 * ## Why the date matters
 *
 * The server charges an assayer's travel once per day, on whichever of that day's jobs it records
 * first. A quote without a date could not know that, so the assign form showed (and pre-filled) a
 * travel-inclusive figure for an assayer's SECOND job that day — and posting that figure back as
 * the desk's fee charged travel twice. The quote is now asked FOR the form's date (`onDate`), and
 * when the assayer's travel that day is already paid the server answers `travelAlreadyCharged`
 * with `total` already reduced to the base fee.
 *
 * `excludeAssignmentId` is the job being moved on a reassign: it is about to stop being the other
 * assayer's, so it must not count as "travel already paid" for the day it is on.
 */
export interface FeeQuoteInputs {
  assayerId: string;
  projectId?: string | null;
  distanceKm?: number | null;
  durationMinutes?: number | null;
  distanceSource?: 'OSRM' | 'ESTIMATE' | string | null;
  branchId?: string | null;
  /** The date on the form, YYYY-MM-DD. */
  onDate?: string | null;
  excludeAssignmentId?: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function feeQuoteRequestBody(i: FeeQuoteInputs): Record<string, unknown> {
  const hasRoute = i.durationMinutes != null && i.durationMinutes > 0;
  const body: Record<string, unknown> = {
    assayerId: i.assayerId,
    projectId: i.projectId || undefined,
    distanceKm: Number(i.distanceKm) || 0,
    durationMinutes: hasRoute ? i.durationMinutes : undefined,
    roadSource: hasRoute ? (i.distanceSource ?? 'ESTIMATE') : undefined,
    branchId: i.branchId || undefined,
  };
  const day = i.onDate ? String(i.onDate).slice(0, 10) : '';
  if (DATE_ONLY.test(day)) body.onDate = day;
  if (i.excludeAssignmentId) body.excludeAssignmentId = i.excludeAssignmentId;
  return body;
}

/** The line under the fee box when the quote is base-only because travel is already paid that day. */
export const TRAVEL_ALREADY_PAID_NOTE = 'Travel already paid on another job this day — base fee only.';

export function dayTravelNote(quote: { travelAlreadyCharged?: boolean } | null | undefined): string | null {
  return quote?.travelAlreadyCharged ? TRAVEL_ALREADY_PAID_NOTE : null;
}

/** The route fields a candidate row carries, ranked and home. */
export interface CandidateRoutes {
  distanceKm?: number | null;
  durationMinutes?: number | null;
  distanceSource?: 'OSRM' | 'ESTIMATE' | string | null;
  homeDistanceKm?: number | null;
  homeDurationMinutes?: number | null;
  homeDistanceSource?: 'OSRM' | 'ESTIMATE' | string | null;
  rankedFromLive?: boolean;
}

/**
 * The route the job is PRICED from: the assayer's home (F2, 2026-09-25).
 *
 * Live location is a ranking signal only. The assign form's quote, the service-limit warning and the
 * independence chip used the ranked distance — for an assayer sharing a live fix that is where
 * their phone is now, so the form quoted travel from "6 km away" and the server then booked it from
 * a home 140 km off. A payload from before the home figures existed falls back to the ranked one
 * unless it says the ranking was live, in which case the home distance is honestly unknown.
 */
export function homeRouteOf(c: CandidateRoutes): { distanceKm: number | null; durationMinutes: number | null; distanceSource: string | null } {
  if (c.homeDistanceKm !== undefined) {
    return { distanceKm: c.homeDistanceKm ?? null, durationMinutes: c.homeDurationMinutes ?? null, distanceSource: c.homeDistanceSource ?? null };
  }
  if (c.rankedFromLive) return { distanceKm: null, durationMinutes: null, distanceSource: null };
  return { distanceKm: c.distanceKm ?? null, durationMinutes: c.durationMinutes ?? null, distanceSource: c.distanceSource ?? null };
}

/** "currently 6 km away" — only when the ranking used a live fix, so it is never read as the priced distance. */
export function liveDistanceNote(c: CandidateRoutes, format: (km: number, source: string | null) => string): string | null {
  if (!c.rankedFromLive || c.distanceKm == null) return null;
  return `currently ${format(c.distanceKm, c.distanceSource ?? null)} away`;
}

/** "Showing the top 100 of 412 ranked candidates" — the list is capped, and says so (F9). */
export function cappedCandidatesNote(shown: number, total: number): string | null {
  if (!(total > shown)) return null;
  return `Showing the top ${shown} of ${total} ranked candidates — narrow the radius or filters to see others.`;
}
