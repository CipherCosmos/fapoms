import type { Assignment } from './types';

/**
 * What this assignment's attendance record actually says — one answer, computed once.
 *
 * The visit is a span with two ends: the geofenced check-in and the geofenced check-out. Neither
 * is optional evidence for a bank collateral audit, because the thing a client, a travel claim or
 * a bank asks afterwards is "who was on site, and for how long", and half a span answers none of
 * it. Until this existed the web app showed the arrival and nothing else — `checkedOutAt` appeared
 * nowhere in the frontend at all — so a visit with no departure was indistinguishable on screen
 * from one that ended properly.
 *
 * Deliberately reports `minutesOnSite: null`, never 0, when either end is missing. Zero is a
 * claim — "the visit took no time" — and an absent measurement is not a measurement of nothing.
 */
export type AttendanceGap = 'NONE' | 'NO_ARRIVAL' | 'NO_DEPARTURE';

export interface AttendanceRead {
  arrival: Date | null;
  departure: Date | null;
  /** Null unless both ends are present. Never 0 as a stand-in for "unknown". */
  minutesOnSite: number | null;
  /** `2h 15m`, `45m`, or null when there is nothing to measure. */
  durationLabel: string | null;
  gap: AttendanceGap;
  /** The stated reason for whichever end is missing, if one was recorded. */
  gapReason: string | null;
}

const parse = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const formatMinutesOnSite = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

export const readAttendance = (
  assignment: Pick<
    Assignment,
    'checkedInAt' | 'checkedOutAt' | 'completedWithoutCheckInReason' | 'completedWithoutCheckOutReason'
  >,
): AttendanceRead => {
  const arrival = parse(assignment.checkedInAt);
  const departure = parse(assignment.checkedOutAt);

  // A departure earlier than the arrival would produce a negative span. It cannot happen through
  // the check-out route, which refuses a check-out with no check-in, but a clock correction on the
  // device or a repaired row could still present one — and a negative duration on screen would be
  // read as a bug in the page rather than as a bad record. Treated as unmeasurable.
  const minutesOnSite =
    arrival && departure && departure.getTime() >= arrival.getTime()
      ? Math.max(0, Math.round((departure.getTime() - arrival.getTime()) / 60000))
      : null;

  const gap: AttendanceGap = !arrival ? 'NO_ARRIVAL' : !departure ? 'NO_DEPARTURE' : 'NONE';

  const gapReason =
    gap === 'NO_ARRIVAL'
      ? (assignment.completedWithoutCheckInReason ?? null)
      : gap === 'NO_DEPARTURE'
        ? (assignment.completedWithoutCheckOutReason ?? null)
        : null;

  return {
    arrival,
    departure,
    minutesOnSite,
    durationLabel: minutesOnSite == null ? null : formatMinutesOnSite(minutesOnSite),
    gap,
    gapReason: gapReason && gapReason.trim() ? gapReason.trim() : null,
  };
};

const TIME_FMT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
};

export const formatAttendanceMoment = (d: Date): string => d.toLocaleString('en-IN', TIME_FMT);

/**
 * The one-line version, for a table cell's tooltip where a panel will not fit. Says what is known
 * and what is missing — never just the half that exists, which is how the arrival-only marker read
 * before and why a missing departure was invisible on the queue.
 */
export const attendanceSummary = (read: AttendanceRead): string => {
  if (read.gap === 'NO_ARRIVAL') return 'No check-in on record for this assignment.';
  const arrived = `Checked in ${formatAttendanceMoment(read.arrival as Date)}`;
  if (read.gap === 'NO_DEPARTURE') {
    return `${arrived} — never checked out, so there is no time on site on record.`;
  }
  return `${arrived}, checked out ${formatAttendanceMoment(read.departure as Date)} — ${read.durationLabel} on site.`;
};
