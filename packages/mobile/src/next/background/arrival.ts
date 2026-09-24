/**
 * What an OS "entered a region" event turns into.
 *
 * Re-registering circles makes the OS report "already inside" again, a phone can bounce at the
 * edge of a circle, and a job can be checked in by hand before the event lands — so the decision
 * is careful to act once per job per day and never on a stale job. The server stays the authority:
 * this only decides whether to ASK it.
 *
 * Pure, for node tests.
 */
import type { WatchedZone } from './geofence-plan';

export type ArrivalDecision =
  | { kind: 'ignore'; why: 'exit' | 'unknown-region' | 'not-today' | 'already-handled' | 'already-checked-in' }
  /** Arrived before check-in opens: tell them when, do not send. */
  | { kind: 'too-early'; zone: WatchedZone; opensAt: string }
  | { kind: 'check-in'; zone: WatchedZone };

export interface ArrivalInputs {
  eventType: 'enter' | 'exit';
  regionId: string | undefined;
  zones: readonly WatchedZone[];
  /** Local `YYYY-MM-DD` now. */
  today: string;
  now: Date;
  /** assignmentId → local day an arrival was already acted on. */
  handled: Readonly<Record<string, string>>;
  /** What the cached job list says right now (it may be newer than the zone record). */
  current?: { status?: string; checkedInAt?: string | null } | null;
}

export function decideArrival(input: ArrivalInputs): ArrivalDecision {
  if (input.eventType !== 'enter') return { kind: 'ignore', why: 'exit' };
  const zone = input.zones.find((z) => z.assignmentId === input.regionId);
  if (!zone) return { kind: 'ignore', why: 'unknown-region' };
  if (zone.day !== input.today) return { kind: 'ignore', why: 'not-today' };
  if (input.handled[zone.assignmentId] === input.today) return { kind: 'ignore', why: 'already-handled' };
  if (input.current && (input.current.checkedInAt || (input.current.status && input.current.status !== 'ACCEPTED'))) {
    return { kind: 'ignore', why: 'already-checked-in' };
  }
  if (zone.opensAt) {
    const opens = new Date(zone.opensAt).getTime();
    if (Number.isFinite(opens) && opens > input.now.getTime()) return { kind: 'too-early', zone, opensAt: zone.opensAt };
  }
  return { kind: 'check-in', zone };
}

/** Keep only today's entries, so the record cannot grow forever. */
export function pruneHandled(handled: Readonly<Record<string, string>>, today: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, day] of Object.entries(handled)) if (day === today) out[id] = day;
  return out;
}

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** ms since epoch. */
  timestamp: number;
}

/** A last-known fix younger than this and at least this accurate is good enough to check in with. */
export const FRESH_FIX_MAX_AGE_MS = 2 * 60 * 1000;
export const FIX_MAX_ACCURACY_M = 200;

/**
 * Whether the OS's last-known position can be used as-is (cheap: no GPS wake-up). The geofence
 * event itself was triggered by a fresh position, so this usually succeeds; otherwise the caller
 * asks for one current fix. The zone's centre is NEVER used as a stand-in: that would record the
 * person at the branch whether or not they were there.
 */
export function usableFix(fix: Fix | null | undefined, now: number): Fix | null {
  if (!fix) return null;
  if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return null;
  if (now - fix.timestamp > FRESH_FIX_MAX_AGE_MS) return null;
  if (fix.accuracy != null && fix.accuracy > FIX_MAX_ACCURACY_M) return null;
  return fix;
}
