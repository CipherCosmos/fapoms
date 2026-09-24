/**
 * The background work itself: what runs when the OS wakes the app (geofence, background run,
 * push) and the one-tap check-in the Today screen uses. The decisions live in the pure files next
 * to this one; this file only gathers facts, calls them, and carries out the answer through the
 * EXISTING services — the same action queue, outbox, location queue and API client the current
 * app uses. Nothing here opens its own transport.
 *
 * Native modules are required here, so this file must only ever be loaded by the new app
 * (`src/next`), never by the current `App.tsx`.
 */
import * as BackgroundTask from 'expo-background-task';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { actionDispatchers, type AssignmentStatusPayload, type CheckInOutPayload, type RejectPayload } from '../../services/action-dispatchers';
import { NOT_SIGNED_IN_ERROR, enqueueAndRun, getQueuedActions, processActionQueue, type DrainReport, type QueuedAction } from '../../services/action-queue';
import { refusalWords } from '../data/reasons';
import { MobileApiService } from '../../services/api.service';
import { flushQueue, queuedCount } from '../../services/location-queue';
import { registerAndroidNotificationChannels, scheduleLocalNotification } from '../../services/notification.service';
import { isStampCurrent, stampSession } from '../../services/session-epoch';
import { readCache, readPreference, writeCache } from '../../services/token-store';
import { getUploads, processOutbox } from '../../services/upload-outbox';
import { sendOne } from '../../hooks/useUploadOutbox';
import type { AssayerAssignment } from '../../types/mobile-app';
import { translatorFor } from '../i18n/catalogues';
import { formatDate, localDayKey } from '../i18n/format';
import { readStoredLanguage } from '../i18n/stored-language';
import { afterAutoCheckIn, decideArrival, pruneHandled, usableFix, type Fix } from './arrival';
import { planGeofences, type WatchedZone } from './geofence-plan';
import { ensureSession } from './headless-session';
import { ARRIVAL_EXPLAINED_KEY, type PermissionFacts } from './permission-flow';
import { extractPushData, planForPush } from './push-plan';
import { BACKGROUND_INTERVAL_MINUTES, planBackgroundRun } from './sync-plan';

export const GEOFENCE_TASK = 'orbit-next-geofence';
export const SYNC_TASK = 'orbit-next-sync';
export const PUSH_TASK = 'orbit-next-push';

/** The job list cache — the SAME key and shape `AssignmentContext` writes. */
const JOBS_CACHE = 'assignments';
const GEOFENCE_CACHE = 'next_geofences';
const ARRIVALS_CACHE = 'next_arrivals';
const SYNC_CACHE = 'next_sync';
const INTERVAL_CACHE = 'next_sync_interval';

interface JobsCache {
  items: AssayerAssignment[];
  at: string;
  ownerId: string | null;
}
interface GeofenceRecord {
  ownerId: string;
  day: string;
  signature: string;
  zones: WatchedZone[];
}

const log = (...args: unknown[]) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.log('[next/background]', ...args);
};

// ── Jobs ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Told whenever the background refreshed the job list (a silent push while the app is open, a
 * background run), so a mounted Today screen can re-read the cache instead of showing old jobs.
 */
const jobsListeners = new Set<() => void>();
export function subscribeJobsChanged(fn: () => void): () => void {
  jobsListeners.add(fn);
  return () => {
    jobsListeners.delete(fn);
  };
}
function emitJobsChanged(): void {
  jobsListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a bad listener must not stop the rest */
    }
  });
}

export async function readCachedJobs(userId: string): Promise<JobsCache | null> {
  const cached = await readCache<JobsCache>(JOBS_CACHE);
  return cached && cached.ownerId === userId ? cached : null;
}

/** Fetch the job list, cache it for this session only, and remember when. Throws if unreachable. */
export async function refreshJobs(userId: string): Promise<AssayerAssignment[]> {
  const stamp = stampSession();
  const items = (await MobileApiService.getAssayerAssignments(userId)).filter((a) => a.isActive !== false);
  if (!isStampCurrent(stamp)) return items;
  const at = new Date().toISOString();
  await writeCache(JOBS_CACHE, { items, at, ownerId: stamp.owner }, () => isStampCurrent(stamp));
  await writeCache(SYNC_CACHE, { lastRefreshAt: at, ownerId: stamp.owner }, () => isStampCurrent(stamp));
  emitJobsChanged();
  return items;
}

// ── Permissions ──────────────────────────────────────────────────────────────────────────────

export async function readPermissionFacts(hasWatchableJob: boolean): Promise<PermissionFacts> {
  const [fg, bg, explained] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    readPreference(ARRIVAL_EXPLAINED_KEY).catch(() => null),
  ]);
  return {
    foreground: (fg?.status as PermissionFacts['foreground']) ?? 'undetermined',
    background: (bg?.status as PermissionFacts['background']) ?? 'undetermined',
    foregroundCanAskAgain: fg?.canAskAgain ?? true,
    explained: explained === '1',
    hasWatchableJob,
  };
}

async function canWatchArrivals(): Promise<boolean> {
  const f = await readPermissionFacts(true);
  return f.foreground === 'granted' && f.background === 'granted';
}

// ── Geofences ────────────────────────────────────────────────────────────────────────────────

/**
 * Register the circles for these jobs, or clear them when there are none. Re-registers only when
 * the set actually changed (the OS re-reports "already inside" on every registration).
 */
export async function syncGeofences(userId: string, jobs: readonly AssayerAssignment[]): Promise<void> {
  if (Platform.OS === 'web') return;
  if (!(await canWatchArrivals())) return;
  const last = await Location.getLastKnownPositionAsync().catch(() => null);
  const plan = planGeofences(jobs, {
    now: new Date(),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    lastPosition: last ? { latitude: last.coords.latitude, longitude: last.coords.longitude } : null,
  });
  const today = localDayKey(new Date()) ?? '';
  const previous = await readCache<GeofenceRecord>(GEOFENCE_CACHE);
  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);

  if (plan.zones.length === 0) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(() => undefined);
  } else if (!started || previous?.signature !== plan.signature || previous?.ownerId !== userId) {
    await Location.startGeofencingAsync(
      GEOFENCE_TASK,
      plan.zones.map((z) => ({
        identifier: z.assignmentId,
        latitude: z.latitude,
        longitude: z.longitude,
        radius: z.watchRadius,
        notifyOnEnter: true,
        notifyOnExit: false,
      })),
    );
  }
  // Always rewritten: the labels, days and opening times may change without the circles changing.
  await writeCache(GEOFENCE_CACHE, { ownerId: userId, day: today, signature: plan.signature, zones: plan.zones } satisfies GeofenceRecord);
  log('geofences', plan.zones.length, plan.signature === previous?.signature ? '(unchanged)' : '(updated)');
}

export async function stopBackgroundWatching(): Promise<void> {
  if (Platform.OS === 'web') return;
  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(() => undefined);
}

// ── Check-in ─────────────────────────────────────────────────────────────────────────────────

/** One position, cheaply: the OS's last fix if fresh, else one Balanced (Wi-Fi/cell) reading. */
async function onePosition(): Promise<Fix | null> {
  const last = await Location.getLastKnownPositionAsync().catch(() => null);
  const lastFix = last
    ? { latitude: last.coords.latitude, longitude: last.coords.longitude, accuracy: last.coords.accuracy, timestamp: last.timestamp }
    : null;
  const fresh = usableFix(lastFix, Date.now());
  if (fresh) return fresh;
  try {
    const current = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (!current) return null;
    return { latitude: current.coords.latitude, longitude: current.coords.longitude, accuracy: current.coords.accuracy, timestamp: current.timestamp };
  } catch {
    return null;
  }
}

export type CheckInOutcome =
  | { kind: 'done' }
  /** Saved on the phone; will send by itself when there is signal. */
  | { kind: 'queued' }
  | { kind: 'refused'; message?: string; code?: string }
  | { kind: 'no-position' }
  | { kind: 'not-signed-in' };

/**
 * Check in to one job with the phone's position, through the existing action queue — so a check-in
 * made with no signal is written down and sent later, and a second attempt for the same job while
 * one is waiting reuses it instead of filing another. `arrivedAt` is when the arrival happened.
 */
export async function checkIn(assignmentId: string, arrivedAt: string): Promise<CheckInOutcome> {
  const fix = await onePosition();
  if (!fix) return { kind: 'no-position' };
  const payload: CheckInOutPayload = {
    assignmentId,
    lat: fix.latitude,
    lng: fix.longitude,
    accuracy: fix.accuracy ?? undefined,
    arrivedAt,
  };
  const result = await enqueueAndRun('CHECK_IN', payload, actionDispatchers.CHECK_IN, {
    sameAs: (existing: QueuedAction<CheckInOutPayload>) => existing.payload.assignmentId === assignmentId,
  });
  if (result.success) return { kind: 'done' };
  if (result.queued) return { kind: 'queued' };
  if (result.error === NOT_SIGNED_IN_ERROR) return { kind: 'not-signed-in' };
  return { kind: 'refused', message: result.error, code: result.code };
}

/** Leave the branch — same queue, same position rules as `checkIn`. Does not finish the job. */
export async function checkOut(assignmentId: string): Promise<CheckInOutcome> {
  const fix = await onePosition();
  if (!fix) return { kind: 'no-position' };
  const payload: CheckInOutPayload = { assignmentId, lat: fix.latitude, lng: fix.longitude, accuracy: fix.accuracy ?? undefined };
  const result = await enqueueAndRun('CHECK_OUT', payload, actionDispatchers.CHECK_OUT, {
    sameAs: (existing: QueuedAction<CheckInOutPayload>) => existing.payload.assignmentId === assignmentId,
  });
  if (result.success) return { kind: 'done' };
  if (result.queued) return { kind: 'queued' };
  if (result.error === NOT_SIGNED_IN_ERROR) return { kind: 'not-signed-in' };
  return { kind: 'refused', message: result.error, code: result.code };
}

/**
 * Yes or no to an offer, through the same queue and dispatcher the current app uses (the server's
 * idempotency key rides as `clientRequestId`). A decline must carry the assayer's reason.
 */
export async function answerOffer(
  assignmentId: string,
  answer: { accept: true } | { accept: false; reason: string; requestKey?: string },
): Promise<CheckInOutcome> {
  type P = AssignmentStatusPayload | RejectPayload;
  const payload: P = answer.accept
    ? { op: 'transition', assignmentId, status: 'ACCEPTED' }
    : { op: 'reject', assignmentId, reason: answer.reason };
  const result = await enqueueAndRun<P>('ASSIGNMENT_STATUS', payload, actionDispatchers.ASSIGNMENT_STATUS, {
    clientRequestId: answer.accept ? undefined : answer.requestKey,
    sameAs: (a) => a.payload.assignmentId === assignmentId && a.payload.op === payload.op,
  });
  if (result.success) return { kind: 'done' };
  if (result.queued) return { kind: 'queued' };
  if (result.error === NOT_SIGNED_IN_ERROR) return { kind: 'not-signed-in' };
  return { kind: 'refused', message: result.error, code: result.code };
}

/**
 * Send what is queued, and deal with what the office refused: each refusal is said once in a
 * notification (the assayer was told it was saved and would send by itself), stays listed on
 * Today until dismissed, and the job list and arrival circles are refreshed — a refused check-in
 * or answer means the phone's picture of the jobs was wrong. Every drain in the new app goes here.
 */
export async function drainQueue(userId: string | null): Promise<DrainReport> {
  const report = await processActionQueue(actionDispatchers);
  if (report.refused.length === 0) return report;
  const language = await readStoredLanguage();
  const t = translatorFor(language);
  registerAndroidNotificationChannels();
  for (const entry of report.refused) {
    const words = refusalWords(t, language, entry);
    await scheduleLocalNotification(words.title, words.reason, { type: 'ACTION_REFUSED', kind: entry.kind }, 'HIGH').catch(() => undefined);
  }
  if (userId) {
    const jobs = await refreshJobs(userId).catch(() => null);
    if (jobs) await syncGeofences(userId, jobs).catch(() => undefined);
  }
  return report;
}

// ── Arrivals ─────────────────────────────────────────────────────────────────────────────────

interface HandledRecord {
  ownerId: string;
  handled: Record<string, string>;
}

async function readHandled(userId: string, today: string): Promise<Record<string, string>> {
  const rec = await readCache<HandledRecord>(ARRIVALS_CACHE);
  return rec?.ownerId === userId ? pruneHandled(rec.handled, today) : {};
}

async function writeHandled(userId: string, handled: Record<string, string>): Promise<void> {
  await writeCache(ARRIVALS_CACHE, { ownerId: userId, handled } satisfies HandledRecord);
}

/**
 * Ask the OS for background runs every `minutes`. Re-registers only when the registered interval
 * differs (an earlier build may have registered another one).
 */
export async function ensureSyncInterval(minutes: number = BACKGROUND_INTERVAL_MINUTES): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const current = await readCache<number>(INTERVAL_CACHE);
    const registered = await TaskManager.isTaskRegisteredAsync(SYNC_TASK);
    if (registered && current === minutes) return;
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (registered) await BackgroundTask.unregisterTaskAsync(SYNC_TASK);
    await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: minutes });
    await writeCache(INTERVAL_CACHE, minutes);
  } catch {
    /* background runs are an optimisation; the foreground still works */
  }
}

async function notify(title: string, body: string, assignmentId: string): Promise<void> {
  registerAndroidNotificationChannels();
  await scheduleLocalNotification(title, body, { type: 'ARRIVAL', assignmentId }, 'HIGH');
}

/** The OS says the phone entered (or left) a watched branch. Runs with or without a screen. */
export async function handleGeofenceEvent(eventType: number, regionId: string | undefined): Promise<void> {
  const userId = await ensureSession();
  if (!userId) {
    await stopBackgroundWatching();
    return;
  }

  // Circles are registered for entry only; an exit from an older registration means nothing.
  if (eventType === Location.GeofencingEventType.Exit) return;

  const record = await readCache<GeofenceRecord>(GEOFENCE_CACHE);
  if (!record || record.ownerId !== userId) return;
  const now = new Date();
  const today = localDayKey(now) ?? '';
  const handled = await readHandled(userId, today);
  const jobs = await readCachedJobs(userId);
  const current = jobs?.items.find((j) => j.id === regionId) ?? null;

  const decision = decideArrival({ eventType: 'enter', regionId, zones: record.zones, today, handled, current });
  log('arrival', regionId, decision.kind, decision.kind === 'ignore' ? decision.why : '');
  if (decision.kind === 'ignore') return;

  // Marked BEFORE acting: a second event while this one is still working must not file twice.
  await writeHandled(userId, { ...handled, [decision.zone.assignmentId]: today });

  const t = translatorFor(await readStoredLanguage());
  const place = decision.zone.label;
  const title = t('arrival.notifyTitle', { place });

  if (decision.kind === 'wrong-day') {
    // Check-in is open only on the job's own day. Say which day, plainly; nothing is sent. The
    // server's `opensAt` (the start of that day) is preferred, the planned day otherwise.
    const day = formatDate(decision.zone.opensAt ?? decision.zone.day, now, t);
    await notify(title, t('arrival.notifyWrongDay', { day }), decision.zone.assignmentId);
    return;
  }

  const outcome = await checkIn(decision.zone.assignmentId, now.toISOString());
  const body =
    outcome.kind === 'done'
      ? t('arrival.notifyCheckedIn')
      : outcome.kind === 'queued'
        ? t('arrival.notifyQueued')
        : outcome.kind === 'refused' && outcome.message
          ? `${outcome.message} ${t('arrival.notifyTapToCheckIn')}`
          : t('arrival.notifyTapToCheckIn');
  await notify(title, body, decision.zone.assignmentId);
  // No fix: try again later. Refused by the server: stays handled for today (a re-entry would
  // only be refused and notify again) and the jobs and circles are refreshed. See `afterAutoCheckIn`.
  const next = afterAutoCheckIn(outcome.kind);
  if (next.retryLater) await writeHandled(userId, handled);
  if (next.refreshJobs) {
    const fresh = await refreshJobs(userId).catch(() => null);
    if (fresh) await syncGeofences(userId, fresh).catch(() => undefined);
  }
}

// ── Background run ───────────────────────────────────────────────────────────────────────────

/** What the OS-scheduled background run does. Returns false only when something failed. */
export async function runBackgroundSync(): Promise<boolean> {
  const userId = await ensureSession();
  const [actions, uploads, fixes, sync, geo] = await Promise.all([
    getQueuedActions().catch(() => [] as QueuedAction[]),
    getUploads().catch(() => []),
    queuedCount().catch(() => 0),
    readCache<{ lastRefreshAt: string; ownerId: string }>(SYNC_CACHE),
    readCache<GeofenceRecord>(GEOFENCE_CACHE),
  ]);
  const now = new Date();
  const plan = planBackgroundRun({
    signedIn: !!userId,
    pending: {
      actions: actions.filter((a) => a.status === 'PENDING' || a.status === 'RETRYING').length,
      uploads: uploads.filter((u) => u.status === 'PENDING' || u.status === 'FAILED').length,
      fixes,
    },
    lastRefreshAt: sync && sync.ownerId === userId ? sync.lastRefreshAt : null,
    geofencesPlannedFor: geo && geo.ownerId === userId ? geo.day : null,
    today: localDayKey(now) ?? '',
    now: now.getTime(),
    canWatchArrivals: userId ? await canWatchArrivals() : false,
  });
  log('background run', plan);
  if (plan.stopEverything || !userId) {
    await stopBackgroundWatching();
    return true;
  }
  let ok = true;
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      ok = false;
      log('background step failed', e);
    }
  };
  if (plan.flushActions) await attempt(() => drainQueue(userId));
  if (plan.flushUploads) await attempt(() => processOutbox(sendOne));
  if (plan.flushFixes) await attempt(() => flushQueue((batch) => MobileApiService.uploadLocationPings(batch)));
  if (plan.refreshJobs || plan.replanGeofences) {
    await attempt(async () => {
      const jobs = plan.refreshJobs ? await refreshJobs(userId) : (await readCachedJobs(userId))?.items ?? [];
      if (plan.replanGeofences) await syncGeofences(userId, jobs);
    });
  }
  return ok;
}

// ── Push ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A push arrived (possibly with the app closed): refresh what it is about. Handles the server's
 * silent `{ type: 'refresh', scope: 'assignments' }` push and any visible job/query push; on
 * iPhone it is called from Firebase's background handler, on Android from the notifications task.
 */
export async function handlePushInBackground(raw: unknown): Promise<void> {
  const plan = planForPush(extractPushData(raw));
  if (!plan.refreshJobs) return;
  const userId = await ensureSession();
  if (!userId) return;
  const jobs = await refreshJobs(userId);
  await syncGeofences(userId, jobs);
  await drainQueue(userId);
}
