/**
 * Arrived before check-in opens: remember it, and check in by itself once it opens — if the person
 * is still there.
 *
 * Owner decision (2026-09-24): retry automatically; give up at the end of that IST day; no
 * continuous GPS. "Still there" is judged from what the phone already knows plus at most one
 * position reading per attempt:
 *   - the OS reports leaving the circle (exit events are registered for these circles) → gone;
 *   - otherwise one position (the OS's recent fix, or a single low-power reading) must fall inside
 *     the arrival circle, allowing for the reading's own stated accuracy (capped).
 * The server still checks the check-in against its own zone and the person's location trail.
 *
 * When attempts happen: every background run (the OS-scheduled task runs every ~15 minutes while
 * an arrival is waiting), every geofence or push wake-up, every time the app comes forward, and a
 * timer while it is open. A local notification is also scheduled for a little after opening, so if
 * the phone never woke in time the person is told plainly to tap — and it is cancelled as soon as
 * the arrival is resolved.
 *
 * Pure, for node tests.
 */
import type { Fix } from './arrival';

export interface PendingArrival {
  assignmentId: string;
  label: string;
  /** When the phone noticed the arrival. */
  noticedAt: string;
  /** When check-in opens. */
  opensAt: string;
  /** The IST day this belongs to; the attempt is dropped once the IST day changes. */
  istDay: string;
  latitude: number;
  longitude: number;
  /** The watched (arrival) circle. */
  radius: number;
  /** Set when the OS reported leaving the circle. */
  leftAt?: string;
  /** Id of the scheduled fallback notification, to cancel it. */
  reminderId?: string;
}

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** `YYYY-MM-DD` in IST, whatever the phone's own time zone. */
export function istDayKey(date: Date): string {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The first instant of the next IST day — when a waiting arrival is given up. */
export function endOfIstDay(date: Date): Date {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  const nextMidnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1);
  return new Date(nextMidnightShifted - IST_OFFSET_MS);
}

/** A reading's claimed accuracy is trusted up to this much when judging "inside". */
export const MAX_ACCURACY_ALLOWANCE_M = 100;
/** The fallback "tap to check in" notice goes out this long after check-in opens. */
export const REMINDER_AFTER_OPEN_MS = 30 * 60 * 1000;
/** Background run interval while an arrival is waiting (Android's floor), and otherwise. */
export const INTERVAL_WHILE_WAITING_MIN = 15;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(toRad(bLat - aLat) / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(toRad(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insideCircle(fix: Fix, p: Pick<PendingArrival, 'latitude' | 'longitude' | 'radius'>): boolean {
  const allowance = Math.min(Math.max(fix.accuracy ?? 0, 0), MAX_ACCURACY_ALLOWANCE_M);
  return metersBetween(fix.latitude, fix.longitude, p.latitude, p.longitude) <= p.radius + allowance;
}

export type PendingDecision =
  /** Not open yet: keep waiting. */
  | { kind: 'wait' }
  /** Open, and there is no position yet: take one reading, then decide again. */
  | { kind: 'need-position' }
  /** Open and still inside: check in now. */
  | { kind: 'check-in' }
  /** Resolved without a check-in; drop it and tell them why. */
  | { kind: 'give-up'; why: 'left' | 'outside' | 'day-over' | 'already-checked-in' };

export function decidePending(
  p: PendingArrival,
  input: {
    now: Date;
    /** What the cached job list says now, if anything. */
    current?: { status?: string; checkedInAt?: string | null; isActive?: boolean } | null;
    /** A usable position (already checked for freshness), or null when none has been taken. */
    fix: Fix | null;
  },
): PendingDecision {
  const { now, current, fix } = input;
  if (istDayKey(now) !== p.istDay) return { kind: 'give-up', why: 'day-over' };
  if (current && (current.checkedInAt || current.isActive === false || (current.status && current.status !== 'ACCEPTED'))) {
    return { kind: 'give-up', why: 'already-checked-in' };
  }
  if (p.leftAt) return { kind: 'give-up', why: 'left' };
  const opens = new Date(p.opensAt).getTime();
  if (Number.isFinite(opens) && now.getTime() < opens) return { kind: 'wait' };
  if (!fix) return { kind: 'need-position' };
  return insideCircle(fix, p) ? { kind: 'check-in' } : { kind: 'give-up', why: 'outside' };
}

/** When to show the fallback "tap to check in" notice: shortly after opening, never past the day. */
export function reminderTime(p: Pick<PendingArrival, 'opensAt'>, now: Date): Date | null {
  const opens = new Date(p.opensAt).getTime();
  if (!Number.isFinite(opens)) return null;
  const at = Math.max(opens + REMINDER_AFTER_OPEN_MS, now.getTime() + 60_000);
  return at < endOfIstDay(now).getTime() ? new Date(at) : null;
}

/** How often to ask the OS for background runs. */
export function backgroundIntervalMinutes(waitingCount: number, normal: number): number {
  return waitingCount > 0 ? Math.min(INTERVAL_WHILE_WAITING_MIN, normal) : normal;
}
