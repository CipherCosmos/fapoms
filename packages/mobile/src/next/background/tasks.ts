/**
 * The three OS tasks, DEFINED at module top level.
 *
 * `expo-task-manager` starts the JS bundle with no screen when the OS wakes the app (a geofence
 * crossing, a scheduled background run, a data push) and looks the task up by name — so the
 * definitions must run on every bundle start, before anything else. `src/next/entry.ts` imports
 * this file first. It is never imported by the current app: its native modules may not be in an
 * installed APK that receives an OTA update.
 *
 * Registration (asking the OS to start calling them) is separate — `registerBackgroundWork` —
 * and happens after sign-in.
 */
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { setIosBackgroundHandler } from './push-ios';
import {
  GEOFENCE_TASK,
  PUSH_TASK,
  SYNC_TASK,
  handleGeofenceEvent,
  handlePushInBackground,
  refreshSyncInterval,
  runBackgroundSync,
  stopBackgroundWatching,
} from './runtime';

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) return;
  const { eventType, region } = (data ?? {}) as { eventType?: number; region?: { identifier?: string } };
  if (eventType == null) return;
  try {
    await handleGeofenceEvent(eventType, region?.identifier);
  } catch {
    /* never crash a headless task; the one-tap check-in is the fallback */
  }
});

TaskManager.defineTask(SYNC_TASK, async () => {
  try {
    return (await runBackgroundSync()) ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

TaskManager.defineTask(PUSH_TASK, async ({ data, error }) => {
  if (error) return;
  try {
    await handlePushInBackground(data);
  } catch {
    /* the next foreground refresh covers it */
  }
});

// iPhone: Firebase delivers data pushes to its own handler, which must also be set at top level.
// A no-op on Android and on an iPhone build without Firebase (see push-ios.ts).
setIosBackgroundHandler(async (data) => {
  try {
    await handlePushInBackground(data);
  } catch {
    /* the next foreground refresh covers it */
  }
});

/**
 * Ask the OS to start calling the tasks. Idempotent; called after sign-in and on every start while
 * signed in. The geofence task is registered separately by `syncGeofences` (it carries regions).
 */
export async function registerBackgroundWork(): Promise<void> {
  if (Platform.OS === 'web') return;
  // Every 30 minutes, or 15 while an early arrival is waiting to be checked in.
  await refreshSyncInterval();
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(PUSH_TASK))) await Notifications.registerTaskAsync(PUSH_TASK);
  } catch {
    /* push still shows in the tray; only the silent refresh is lost */
  }
}

/** Sign-out: stop every background task for this person. */
export async function unregisterBackgroundWork(): Promise<void> {
  if (Platform.OS === 'web') return;
  await stopBackgroundWatching();
  await BackgroundTask.unregisterTaskAsync(SYNC_TASK).catch(() => undefined);
  await Notifications.unregisterTaskAsync(PUSH_TASK).catch(() => undefined);
}
