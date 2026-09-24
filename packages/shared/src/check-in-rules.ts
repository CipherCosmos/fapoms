import { calculateHaversineDistance } from './utils';

/**
 * CHECK-IN: THE ZONE, AND WHICH CLOCK THE ARRIVAL IS WRITTEN IN.
 *
 * Two rules the server enforces and the field app has to be able to explain, kept together:
 *
 *  1. **The zone.** A fix counts as "at the branch" when it is within the configured geofence
 *     (`field.checkInGeofenceMeters`) plus the device's own stated accuracy (capped) plus the
 *     branch's recorded pin accuracy. That allowance was written inline in the check-in route; it
 *     lives here now because the arrival rule below asks the same question of a trail fix, and two
 *     answers to "was this person inside the zone" would be one too many.
 *
 *  2. **The arrival time (owner decision 2026-09-24).** The phone may say when it actually arrived
 *     (`arrivedAt`) — a check-in sent from a basement with no signal lands minutes or hours after
 *     the person walked in. The phone's time is recorded as the check-in time ONLY when all of
 *     these hold; otherwise the server's own receive time is used, exactly as before:
 *       - it is on the same business (IST) day as the server's now;
 *       - it is not in the future beyond a small clock skew (`CHECK_IN_ARRIVAL_CLOCK_SKEW_MS`);
 *       - it is not older than `field.checkInArrivalMaxAgeHours`;
 *       - the assayer's own location trail holds a real (not mocked) fix inside the zone within
 *         ±`field.checkInArrivalTrailWindowMinutes` of it — so the claim is corroborated by
 *         evidence the phone recorded at the time, not merely asserted.
 *     Both times, the claim, which one was used and why are all stored on the assignment.
 */

/** Which clock the recorded check-in time came from. */
export enum CheckInTimeSource {
  /** The moment the server received the check-in. The only source before 2026-09-24. */
  SERVER = 'SERVER',
  /** The phone's stated arrival time, accepted because every rule above held. */
  DEVICE = 'DEVICE',
}

/** Why the recorded check-in time is what it is. Stored on the assignment beside the source. */
export enum CheckInArrivalOutcome {
  /** The phone's arrival time was accepted. */
  ACCEPTED = 'ACCEPTED',
  /** No arrival time was sent — every app that predates this rule. */
  NOT_SENT = 'NOT_SENT',
  /** Something was sent, but it is not a readable timestamp. */
  UNREADABLE = 'UNREADABLE',
  /** Later than the server's now, beyond the allowed clock skew. */
  IN_FUTURE = 'IN_FUTURE',
  /** A different business day from the day the check-in reached the server. */
  DIFFERENT_DAY = 'DIFFERENT_DAY',
  /** Older than the configured maximum. */
  TOO_OLD = 'TOO_OLD',
  /** The branch has no usable coordinates, so no trail fix can be tested against it. */
  NO_BRANCH_LOCATION = 'NO_BRANCH_LOCATION',
  /** The location trail has no real fix inside the zone near that time. */
  NO_TRAIL_EVIDENCE = 'NO_TRAIL_EVIDENCE',
  /** Sent by staff checking in on the assayer's behalf; only the assayer's own phone may claim it. */
  NOT_FROM_ASSAYER = 'NOT_FROM_ASSAYER',
}

/** Plain-English reading of each outcome, for the web record and any audit screen. */
export const CHECK_IN_ARRIVAL_OUTCOME_LABELS: Record<CheckInArrivalOutcome, string> = {
  [CheckInArrivalOutcome.ACCEPTED]: 'Arrival time taken from the phone, confirmed by its location trail',
  [CheckInArrivalOutcome.NOT_SENT]: 'The phone did not say when it arrived',
  [CheckInArrivalOutcome.UNREADABLE]: 'The arrival time the phone sent could not be read',
  [CheckInArrivalOutcome.IN_FUTURE]: 'The phone\'s arrival time was in the future, so its clock is wrong',
  [CheckInArrivalOutcome.DIFFERENT_DAY]: 'The phone\'s arrival time was on a different day',
  [CheckInArrivalOutcome.TOO_OLD]: 'The phone\'s arrival time was too long ago to accept',
  [CheckInArrivalOutcome.NO_BRANCH_LOCATION]: 'The branch has no map location to confirm the arrival against',
  [CheckInArrivalOutcome.NO_TRAIL_EVIDENCE]: 'The location trail does not show the phone at the branch at that time',
  [CheckInArrivalOutcome.NOT_FROM_ASSAYER]: 'Checked in by the office, so the time it reached the server is used',
};

export const CHECK_IN_ARRIVAL_MAX_AGE_SETTING = 'field.checkInArrivalMaxAgeHours';
/** The smaller "you have arrived" circle the phone uses (see `CheckInZone.arrivalRadiusMeters`). */
export const ARRIVAL_RADIUS_SETTING = 'field.arrivalRadiusMeters';
export const DEFAULT_ARRIVAL_RADIUS_METERS = 200;
export const CHECK_IN_ARRIVAL_TRAIL_WINDOW_SETTING = 'field.checkInArrivalTrailWindowMinutes';
export const DEFAULT_CHECK_IN_ARRIVAL_MAX_AGE_HOURS = 4;
export const DEFAULT_CHECK_IN_ARRIVAL_TRAIL_WINDOW_MINUTES = 15;

/** How far ahead of the server a phone's arrival time may be and still be read as a clock drift. */
export const CHECK_IN_ARRIVAL_CLOCK_SKEW_MS = 2 * 60_000;

/** A device's stated accuracy is added to the zone, but never more than this. */
export const MAX_DEVICE_ACCURACY_ALLOWANCE_M = 1000;

/**
 * How far from the branch pin a fix may be and still count as at the branch.
 *
 * Geofence + the device's stated accuracy (a poor fix is not treated as being in the wrong place,
 * capped at `MAX_DEVICE_ACCURACY_ALLOWANCE_M`) + the branch pin's own recorded accuracy (a branch
 * geocoded only to its town cannot demand a 2 km precision of the person standing in it).
 */
export function checkInAllowanceMeters(input: {
  geofenceMeters: number;
  deviceAccuracyMeters?: number | null;
  branchAccuracyMeters?: number | null;
}): number {
  const branchAccuracy = Math.max(0, Number(input.branchAccuracyMeters ?? 0) || 0);
  const device = Math.min(Math.max(0, Number(input.deviceAccuracyMeters ?? 0) || 0), MAX_DEVICE_ACCURACY_ALLOWANCE_M);
  return input.geofenceMeters + device + branchAccuracy;
}

/** Branch coordinates usable as a zone centre, or null — (0,0) and non-numbers are "unknown". */
export function usableBranchPoint(
  latitude: unknown,
  longitude: unknown,
): { latitude: number; longitude: number } | null {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { latitude: lat, longitude: lng };
}

/** Whole metres between a fix and the branch. */
export function metersFromBranch(
  fix: { latitude: number; longitude: number },
  branch: { latitude: number; longitude: number },
): number {
  return Math.round(calculateHaversineDistance(fix.latitude, fix.longitude, branch.latitude, branch.longitude) * 1000);
}

export interface TrailFix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  recordedAt: Date | string;
  isMocked?: boolean | null;
}

export interface CheckInTimeDecision {
  /** The time to record as `checked_in_at`. */
  checkedInAt: Date;
  source: CheckInTimeSource;
  outcome: CheckInArrivalOutcome;
  /** The phone's claim as parsed, when one was sent and readable. */
  claimedArrivalAt: Date | null;
}

/**
 * Decide the check-in time. Pure: the caller loads the trail fixes around the claim and the
 * settings; nothing here reads a clock except through `receivedAt`.
 *
 * `businessDayOf` is injected rather than imported so this file stays free of the labels module's
 * time-zone plumbing; pass `businessDateKey`.
 */
export function decideCheckInTime(input: {
  receivedAt: Date;
  arrivedAt: unknown;
  /** False when staff are checking in on the assayer's behalf. */
  fromAssignedAssayer: boolean;
  maxAgeHours: number;
  trailWindowMinutes: number;
  geofenceMeters: number;
  branch: { latitude: number; longitude: number } | null;
  branchAccuracyMeters?: number | null;
  /** Trail fixes the caller loaded for the window around the claim (any order). */
  fixes: TrailFix[];
  businessDayOf: (d: Date) => string;
}): CheckInTimeDecision {
  const server = (outcome: CheckInArrivalOutcome, claimed: Date | null = null): CheckInTimeDecision => ({
    checkedInAt: input.receivedAt,
    source: CheckInTimeSource.SERVER,
    outcome,
    claimedArrivalAt: claimed,
  });

  const claimed = input.arrivedAt === undefined || input.arrivedAt === null || input.arrivedAt === ''
    ? null
    : typeof input.arrivedAt === 'string' || input.arrivedAt instanceof Date
      ? new Date(input.arrivedAt as string | Date)
      : new Date(NaN);
  const readable = claimed && !Number.isNaN(claimed.getTime()) ? claimed : null;
  // An office check-in is recorded as one whatever was or was not sent with it (owner decision
  // 2026-09-24, E12): the outcome is what the web record reads to say "checked in by the office",
  // so it cannot depend on whether the desk's request happened to carry an arrival time.
  if (!input.fromAssignedAssayer) return server(CheckInArrivalOutcome.NOT_FROM_ASSAYER, readable);
  if (!claimed) return server(CheckInArrivalOutcome.NOT_SENT);
  if (!readable) return server(CheckInArrivalOutcome.UNREADABLE);

  const now = input.receivedAt.getTime();
  if (claimed.getTime() > now + CHECK_IN_ARRIVAL_CLOCK_SKEW_MS) return server(CheckInArrivalOutcome.IN_FUTURE, claimed);
  if (input.businessDayOf(claimed) !== input.businessDayOf(input.receivedAt)) {
    return server(CheckInArrivalOutcome.DIFFERENT_DAY, claimed);
  }
  if (now - claimed.getTime() > Math.max(0, input.maxAgeHours) * 3_600_000) {
    return server(CheckInArrivalOutcome.TOO_OLD, claimed);
  }
  if (!input.branch) return server(CheckInArrivalOutcome.NO_BRANCH_LOCATION, claimed);

  const windowMs = Math.max(0, input.trailWindowMinutes) * 60_000;
  const corroborated = input.fixes.some((fix) => {
    if (fix.isMocked) return false;
    const at = new Date(fix.recordedAt).getTime();
    if (!Number.isFinite(at) || Math.abs(at - claimed.getTime()) > windowMs) return false;
    const lat = Number(fix.latitude);
    const lng = Number(fix.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const allowance = checkInAllowanceMeters({
      geofenceMeters: input.geofenceMeters,
      deviceAccuracyMeters: fix.accuracyMeters,
      branchAccuracyMeters: input.branchAccuracyMeters,
    });
    return metersFromBranch({ latitude: lat, longitude: lng }, input.branch!) <= allowance;
  });
  if (!corroborated) return server(CheckInArrivalOutcome.NO_TRAIL_EVIDENCE, claimed);

  // Within the skew a claim may sit a moment after the server's now; a check-in is never recorded
  // as happening after the server received it.
  return {
    checkedInAt: new Date(Math.min(claimed.getTime(), now)),
    source: CheckInTimeSource.DEVICE,
    outcome: CheckInArrivalOutcome.ACCEPTED,
    claimedArrivalAt: claimed,
  };
}
