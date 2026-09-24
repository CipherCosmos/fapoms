/**
 * The automatic check-in permission, asked once and never nagged.
 *
 * Owner decision: check-in is automatic, with a one-tap fallback. Automatic needs location "all
 * the time" (Android 10+: a separate "Allow all the time" choice, reached through settings on
 * Android 11+; iOS: "Always"). The flow:
 *   1. explain in plain words, with Yes / Not now;
 *   2. Yes → ask for foreground location, then background;
 *   3. anything refused, or Not now → the "I have reached" button is the way, and the question is
 *      not asked again by itself (the person can turn it on later from Me).
 *
 * Pure, for node tests.
 */

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface PermissionFacts {
  foreground: PermissionStatus;
  background: PermissionStatus;
  /** The OS will still show its prompt (false after "Don't ask again"). */
  foregroundCanAskAgain: boolean;
  /** We have already shown our explanation once (stored). */
  explained: boolean;
  /** There is at least one job the phone could watch for. */
  hasWatchableJob: boolean;
}

export type PermissionStep =
  /** Automatic check-in is on. */
  | 'ready'
  /** Show the explanation card (only once, only when it would be useful). */
  | 'explain'
  /** Nothing to watch yet: say nothing. */
  | 'quiet'
  /** Refused or postponed: use the one-tap fallback; do not ask again unprompted. */
  | 'fallback';

export function permissionStep(f: PermissionFacts): PermissionStep {
  if (f.foreground === 'granted' && f.background === 'granted') return 'ready';
  if (f.explained) return 'fallback';
  if (!f.hasWatchableJob) return 'quiet';
  if (f.foreground === 'denied' && !f.foregroundCanAskAgain) return 'fallback';
  return 'explain';
}

/** After the person tapped "Yes": which OS prompt comes next. */
export function nextRequest(f: Pick<PermissionFacts, 'foreground' | 'background' | 'foregroundCanAskAgain'>):
  | 'foreground'
  | 'background'
  | 'done'
  | 'blocked' {
  if (f.foreground !== 'granted') return f.foreground === 'denied' && !f.foregroundCanAskAgain ? 'blocked' : 'foreground';
  if (f.background !== 'granted') return 'background';
  return 'done';
}

/** Where the explanation state is stored. */
export const ARRIVAL_EXPLAINED_KEY = 'next.arrivalPermissionExplained';
