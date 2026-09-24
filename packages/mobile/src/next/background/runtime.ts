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
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { actionDispatchers, type CheckInOutPayload } from '../../services/action-dispatchers';
import { NOT_SIGNED_IN_ERROR, enqueueAndRun, getQueuedActions, processActionQueue, type QueuedAction } from '../../services/action-queue';
import { MobileApiService } from '../../services/api.service';
import { flushQueue, queuedCount } from '../../services/location-queue';
import { ANDROID_CHANNELS, registerAndroidNotificationChannels, scheduleLocalNotification } from '../../services/notification.service';
import { isStampCurrent, stampSession } from '../../services/session-epoch';
import { readCache, readPreference, writeCache } from '../../services/token-store';
import { getUploads, processOutbox } from '../../services/upload-outbox';
import { sendOne } from '../../hooks/useUploadOutbox';
import type { AssayerAssignment } from '../../types/mobile-app';
import { translatorFor } from '../i18n/catalogues';
import { formatDayTime, localDayKey } from '../i18n/format';
import { readStoredLanguage } from '../i18n/stored-language';
import { decideArrival, pruneHandled, usableFix, type Fix } from './arrival';
import {
  backgroundIntervalMinutes,
  decidePending,
  istDayKey,
  reminderTime,
  type PendingArrival,
} from './pending-arrival';
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
const PENDING_CACHE = 'next_pending_arrivals';
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
        notifyOnExit: z.notifyOnExit,
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
  // Any waiting early arrival belongs to the session that is ending: drop it and its reminder.
  const pending = await readCache<PendingRecord>(PENDING_CACHE);
  for (const p of pending?.items ?? []) await cancelReminder(p);
  await writeCache(PENDING_CACHE, null);
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

// ── Early arrivals ───────────────────────────────────────────────────────────────────────────

interface PendingRecord {
  ownerId: string;
  items: PendingArrival[];
}
interface HandledRecord {
  ownerId: string;
  handled: Record<string, string>;
}

async function readPending(userId: string): Promise<PendingArrival[]> {
  const rec = await readCache<PendingRecord>(PENDING_CACHE);
  return rec && rec.ownerId === userId ? rec.items : [];
}

async function writePending(userId: string, items: PendingArrival[]): Promise<void> {
  await writeCache(PENDING_CACHE, { ownerId: userId, items } satisfies PendingRecord);
  await ensureSyncInterval(backgroundIntervalMinutes(items.length, BACKGROUND_INTERVAL_MINUTES));
}

async function readHandled(userId: string, today: string): Promise<Record<string, string>> {
  const rec = await readCache<HandledRecord>(ARRIVALS_CACHE);
  return rec?.ownerId === userId ? pruneHandled(rec.handled, today) : {};
}

async function writeHandled(userId: string, handled: Record<string, string>): Promise<void> {
  await writeCache(ARRIVALS_CACHE, { ownerId: userId, handled } satisfies HandledRecord);
}

async function cancelReminder(p: PendingArrival): Promise<void> {
  if (p.reminderId) await Notifications.cancelScheduledNotificationAsync(p.reminderId).catch(() => undefined);
}

/**
 * The fallback: a notice a little after check-in opens, telling them to tap. Cancelled as soon as
 * the automatic attempt resolves, so it only ever shows when the phone did not wake in time.
 */
async function scheduleReminder(p: PendingArrival, now: Date): Promise<string | undefined> {
  const when = reminderTime(p, now);
  if (!when || Platform.OS === 'web') return undefined;
  const t = translatorFor(await readStoredLanguage());
  try {
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: t('arrival.reminderTitle', { place: p.label }),
        body: t('arrival.reminderBody'),
        data: { type: 'ARRIVAL', assignmentId: p.assignmentId },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: ANDROID_CHANNELS.HIGH },
    });
  } catch {
    return undefined;
  }
}

/**
 * Ask the OS for background runs every 15 minutes while an early arrival is waiting, and every 30
 * otherwise. Re-registers only when the wanted interval changes.
 */
export async function ensureSyncInterval(minutes: number): Promise<void> {
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

/** The soonest opening time among waiting early arrivals, so an open app can try right then. */
export async function nextPendingOpening(userId: string): Promise<Date | null> {
  const times = (await readPending(userId))
    .map((p) => new Date(p.opensAt).getTime())
    .filter((ms) => Number.isFinite(ms) && ms > Date.now());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** The interval the background run should have right now (faster while an arrival is waiting). */
export async function refreshSyncInterval(): Promise<void> {
  const rec = await readCache<PendingRecord>(PENDING_CACHE);
  await ensureSyncInterval(backgroundIntervalMinutes(rec?.items?.length ?? 0, BACKGROUND_INTERVAL_MINUTES));
}

async function notify(title: string, body: string, assignmentId: string): Promise<void> {
  registerAndroidNotificationChannels();
  await scheduleLocalNotification(title, body, { type: 'ARRIVAL', assignmentId }, 'HIGH');
}

/**
 * Try every waiting early arrival once. Called from every background wake-up and every time the
 * app comes forward; a no-op (one small file read) when nothing is waiting.
 */
export async function processPendingArrivals(userId: string): Promise<void> {
  const items = await readPending(userId);
  if (items.length === 0) return;
  const now = new Date();
  const t = translatorFor(await readStoredLanguage());
  const jobs = await readCachedJobs(userId);
  const keep: PendingArrival[] = [];
  let handled: Record<string, string> | null = null;

  for (const p of items) {
    const current = jobs?.items.find((j) => j.id === p.assignmentId) ?? null;
    let decision = decidePending(p, { now, current, fix: null });
    let fix: Fix | null = null;
    if (decision.kind === 'need-position') {
      fix = await onePosition();
      if (!fix) {
        keep.push(p); // no position this time; the next wake-up tries again (and the reminder is set)
        continue;
      }
      decision = decidePending(p, { now, current, fix });
    }
    log('pending arrival', p.assignmentId, decision);

    if (decision.kind === 'wait' || decision.kind === 'need-position') {
      keep.push(p);
      continue;
    }
    await cancelReminder(p);
    const place = p.label;

    if (decision.kind === 'check-in') {
      // The moment presence was confirmed with a position, not the earlier arrival: that is the
      // time the phone can truthfully vouch for, and it is after check-in opened.
      const outcome = await checkIn(p.assignmentId, now.toISOString());
      if (outcome.kind === 'done') await notify(t('arrival.notifyTitle', { place }), t('arrival.notifyRetryCheckedIn', { place }), p.assignmentId);
      else if (outcome.kind === 'queued') await notify(t('arrival.notifyTitle', { place }), t('arrival.notifyRetryQueued', { place }), p.assignmentId);
      else if (outcome.kind === 'no-position') {
        keep.push({ ...p, reminderId: await scheduleReminder(p, now) });
        continue;
      } else {
        const reason = outcome.kind === 'refused' && outcome.message ? `${outcome.message} ` : '';
        await notify(t('arrival.reminderTitle', { place }), `${reason}${t('arrival.notifyRetryFailed', { place })}`, p.assignmentId);
      }
      continue;
    }

    // Given up.
    if (decision.why === 'left' || decision.why === 'outside') {
      await notify(t('arrival.reminderTitle', { place }), t('arrival.notifyLeftBefore', { place }), p.assignmentId);
      // Coming back later must count as a new arrival.
      handled = handled ?? (await readHandled(userId, localDayKey(now) ?? ''));
      delete handled[p.assignmentId];
    }
    // 'day-over' and 'already-checked-in' end quietly: there is nothing for them to do.
  }

  if (handled) await writeHandled(userId, handled);
  await writePending(userId, keep);
}

/** The OS says the phone entered (or left) a watched branch. Runs with or without a screen. */
export async function handleGeofenceEvent(eventType: number, regionId: string | undefined): Promise<void> {
  const userId = await ensureSession();
  if (!userId) {
    await stopBackgroundWatching();
    return;
  }

  if (eventType === Location.GeofencingEventType.Exit) {
    // Only circles with a waiting early arrival report exits. Record it and resolve now, so they
    // are told straight away rather than when check-in opens.
    const items = await readPending(userId);
    if (!items.some((p) => p.assignmentId === regionId && !p.leftAt)) return;
    const leftAt = new Date().toISOString();
    await writeCache(PENDING_CACHE, {
      ownerId: userId,
      items: items.map((p) => (p.assignmentId === regionId ? { ...p, leftAt } : p)),
    } satisfies PendingRecord);
    await processPendingArrivals(userId);
    return;
  }

  const record = await readCache<GeofenceRecord>(GEOFENCE_CACHE);
  if (!record || record.ownerId !== userId) return;
  const now = new Date();
  const today = localDayKey(now) ?? '';
  const handled = await readHandled(userId, today);
  const jobs = await readCachedJobs(userId);
  const current = jobs?.items.find((j) => j.id === regionId) ?? null;

  const decision = decideArrival({ eventType: 'enter', regionId, zones: record.zones, today, now, handled, current });
  log('arrival', regionId, decision.kind, decision.kind === 'ignore' ? decision.why : '');
  if (decision.kind === 'ignore') {
    await processPendingArrivals(userId);
    return;
  }

  // Marked BEFORE acting: a second event while this one is still working must not file twice.
  await writeHandled(userId, { ...handled, [decision.zone.assignmentId]: today });

  const t = translatorFor(await readStoredLanguage());
  const place = decision.zone.label;
  const title = t('arrival.notifyTitle', { place });

  if (decision.kind === 'too-early') {
    const z = decision.zone;
    const pending: PendingArrival = {
      assignmentId: z.assignmentId,
      label: place,
      noticedAt: now.toISOString(),
      opensAt: decision.opensAt,
      istDay: istDayKey(now),
      latitude: z.latitude,
      longitude: z.longitude,
      radius: z.watchRadius,
    };
    pending.reminderId = await scheduleReminder(pending, now);
    const others = (await readPending(userId)).filter((p) => p.assignmentId !== z.assignmentId);
    await writePending(userId, [...others, pending]);
    await notify(title, t('arrival.notifyWillRetry', { when: formatDayTime(decision.opensAt, now, t) }), z.assignmentId);
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
  if (outcome.kind === 'refused' || outcome.kind === 'no-position') {
    // Let the person try again by hand (and a later event try again automatically).
    await writeHandled(userId, handled);
  }
  await processPendingArrivals(userId);
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
  if (plan.flushActions) await attempt(() => processActionQueue(actionDispatchers));
  if (plan.flushUploads) await attempt(() => processOutbox(sendOne));
  if (plan.flushFixes) await attempt(() => flushQueue((batch) => MobileApiService.uploadLocationPings(batch)));
  if (plan.refreshJobs || plan.replanGeofences) {
    await attempt(async () => {
      const jobs = plan.refreshJobs ? await refreshJobs(userId) : (await readCachedJobs(userId))?.items ?? [];
      if (plan.replanGeofences) await syncGeofences(userId, jobs);
    });
  }
  await attempt(() => processPendingArrivals(userId));
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
  await processActionQueue(actionDispatchers);
  await processPendingArrivals(userId);
}
