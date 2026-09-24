/**
 * Which branches the phone should watch for arrival.
 *
 * The OS watches circles for us (Android GeofencingClient, iOS region monitoring), so there is no
 * continuous GPS. Both OSes cap how many circles an app may hold — iOS 20 for the whole app,
 * Android 100 — and every circle costs a little, so only jobs that can actually be checked in to
 * soon are registered:
 *   - accepted, not yet checked in, not removed;
 *   - scheduled today or tomorrow (tomorrow so an early start works even if the OS did not run the
 *     overnight refresh; the arrival handler still refuses a job that is not for today);
 *   - the server sent a check-in zone; and
 *   - the server's CHECK_IN gate is allowed, or it is not allowed only until a time (`opensAt`)
 *     within those two days. A gate refused for any other reason (or no gate: older server) is
 *     not watched — "not allowed" means not allowed.
 * Kept: the soonest first, then the nearest (when a last position is known), up to the cap.
 *
 * The circle watched is the server's `arrivalRadiusMeters` ("you have arrived", default 200) when
 * it sends one, else the check-in zone's `radiusMeters`. The check-in zone itself stays the
 * server's rule for accepting the check-in; the arrival circle only decides when to ask.
 *
 * Pure, for node tests.
 */
import { AssignmentAction, gateFor } from '@fapoms/shared';
import type { AssayerAssignment } from '../../types/mobile-app';
import { calendarDaysFrom, localDayKey, toLocalDate } from '../i18n/format';

export const REGION_LIMIT = { ios: 20, android: 100 } as const;

/**
 * Circles smaller than this are unreliable (Android recommends 100–150 m; iOS rarely fires under
 * ~100 m). A zone below it is widened for WATCHING only — the server still checks the real zone
 * against the reported position.
 */
export const MIN_WATCH_RADIUS_M = 150;
/** Guard against a nonsense setting turning into a city-sized circle. */
export const MAX_WATCH_RADIUS_M = 5000;

export interface WatchedZone {
  /** The region identifier = assignment id. */
  assignmentId: string;
  latitude: number;
  longitude: number;
  /** Radius registered with the OS. */
  watchRadius: number;
  /** Radius the server enforces for check-in. */
  serverRadius: number;
  /**
   * Also report LEAVING this circle. Only for a job whose check-in opens later: an early arrival
   * is remembered and checked in once it opens, unless the person left in between.
   */
  notifyOnExit: boolean;
  /** Shown in the "You have reached X" notification. */
  label: string;
  /** Local `YYYY-MM-DD` the job is scheduled for. */
  day: string;
  /** When check-in opens, if not yet. */
  opensAt?: string;
}

export interface GeofencePlan {
  zones: WatchedZone[];
  /** Stable text that changes only when the set of circles changes — skip re-registering otherwise. */
  signature: string;
}

type PlannableAssignment = Pick<
  AssayerAssignment,
  'id' | 'status' | 'isActive' | 'checkedInAt' | 'scheduledDate' | 'capabilities' | 'branchName' | 'bankName'
>;

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    // 0,0 is Null Island, which is what a missing coordinate used to become.
    && !(lat === 0 && lng === 0)
  );
}

export function planGeofences(
  assignments: readonly PlannableAssignment[],
  opts: { now: Date; platform: 'ios' | 'android'; lastPosition?: { latitude: number; longitude: number } | null },
): GeofencePlan {
  const { now, platform, lastPosition } = opts;
  const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime();

  const candidates: (WatchedZone & { daysAway: number; distance: number })[] = [];
  for (const a of assignments) {
    if (a.isActive === false || a.status !== 'ACCEPTED' || a.checkedInAt) continue;
    const daysAway = a.scheduledDate ? calendarDaysFrom(a.scheduledDate, now) : null;
    if (daysAway !== 0 && daysAway !== 1) continue;
    const zone = a.capabilities?.checkInZone;
    if (!zone || !validCoordinate(zone.latitude, zone.longitude)) continue;
    const serverRadius = Number(zone.radiusMeters);
    if (!Number.isFinite(serverRadius) || serverRadius <= 0) continue;
    // `arrivalRadiusMeters` is newer than this build's copy of the shared type on some checkouts;
    // read it loosely and fall back to the check-in radius when absent or nonsense.
    const arrival = Number((zone as { arrivalRadiusMeters?: number | null }).arrivalRadiusMeters);
    const circle = Number.isFinite(arrival) && arrival > 0 ? arrival : serverRadius;

    const gate = gateFor(a.capabilities?.actions, AssignmentAction.CHECK_IN);
    let opensAt: string | undefined;
    if (!gate.allowed) {
      const opens = toLocalDate(gate.opensAt ?? null);
      if (!opens || opens.getTime() >= endOfTomorrow) continue;
      opensAt = gate.opensAt;
    }

    candidates.push({
      assignmentId: a.id,
      latitude: zone.latitude,
      longitude: zone.longitude,
      watchRadius: Math.round(Math.min(MAX_WATCH_RADIUS_M, Math.max(MIN_WATCH_RADIUS_M, circle))),
      serverRadius,
      notifyOnExit: !!opensAt,
      label: [a.branchName, a.bankName].filter(Boolean).join(', ') || a.id,
      day: localDayKey(a.scheduledDate) ?? '',
      ...(opensAt ? { opensAt } : {}),
      daysAway,
      distance: lastPosition ? haversineMeters(lastPosition.latitude, lastPosition.longitude, zone.latitude, zone.longitude) : 0,
    });
  }

  candidates.sort((x, y) => x.daysAway - y.daysAway || x.distance - y.distance || x.assignmentId.localeCompare(y.assignmentId));
  const zones = candidates.slice(0, REGION_LIMIT[platform]).map(({ daysAway: _d, distance: _x, ...z }) => z);

  // Order-independent, and blind to the label (renaming a branch does not re-register circles).
  const signature = zones
    .map((z) => `${z.assignmentId}@${z.latitude.toFixed(6)},${z.longitude.toFixed(6)}r${z.watchRadius}${z.notifyOnExit ? 'x' : ''}`)
    .sort()
    .join('|');
  return { zones, signature };
}
