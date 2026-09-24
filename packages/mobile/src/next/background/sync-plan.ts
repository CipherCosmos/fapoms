/**
 * What a background run (the OS waking the app with the app closed) should do.
 *
 * Battery first: a run with nothing queued and fresh data does nothing but read a small file and
 * exit. The OS decides WHEN we run (Android WorkManager, only with a network connection; iOS
 * BGTaskScheduler, usually while charging) — this decides WHAT.
 *
 * Pure, for node tests.
 */

/** Refresh the job list in the background at most this often. */
export const BACKGROUND_REFRESH_EVERY_MS = 3 * 60 * 60 * 1000;
/** How often to ask the OS for a run (minutes; Android's floor is 15). */
export const BACKGROUND_INTERVAL_MINUTES = 30;

export interface SyncInputs {
  /** A session could be restored from the keystore. */
  signedIn: boolean;
  pending: { actions: number; uploads: number; fixes: number };
  /** ISO time of the last successful job-list refresh, or null. */
  lastRefreshAt: string | null;
  /** Local day the geofences were last planned for, or null. */
  geofencesPlannedFor: string | null;
  /** Local `YYYY-MM-DD` now. */
  today: string;
  now: number;
  /** Background location is granted, so geofences can be (re)registered. */
  canWatchArrivals: boolean;
}

export interface SyncPlan {
  flushActions: boolean;
  flushUploads: boolean;
  flushFixes: boolean;
  refreshJobs: boolean;
  replanGeofences: boolean;
  /** Signed out: tear down the background work instead. */
  stopEverything: boolean;
}

export function planBackgroundRun(input: SyncInputs): SyncPlan {
  if (!input.signedIn) {
    return { flushActions: false, flushUploads: false, flushFixes: false, refreshJobs: false, replanGeofences: false, stopEverything: true };
  }
  const last = input.lastRefreshAt ? new Date(input.lastRefreshAt).getTime() : Number.NaN;
  const stale = !Number.isFinite(last) || input.now - last >= BACKGROUND_REFRESH_EVERY_MS;
  const newDay = input.geofencesPlannedFor !== input.today;
  // A new day always refreshes: today's circles depend on today's list.
  const refreshJobs = stale || (newDay && input.canWatchArrivals);
  return {
    flushActions: input.pending.actions > 0,
    flushUploads: input.pending.uploads > 0,
    flushFixes: input.pending.fixes > 0,
    refreshJobs,
    replanGeofences: input.canWatchArrivals && (refreshJobs || newDay),
    stopEverything: false,
  };
}
