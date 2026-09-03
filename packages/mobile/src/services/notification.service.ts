import { Platform } from 'react-native';
import { MobileApiService } from './api.service';
import { getPreference } from './preferences';
import { t } from '../i18n';

let Notifications: any = null;
let Device: any = null;

try {
  Notifications = require('expo-notifications');
  Device = require('expo-device');
} catch (err) {
  if (__DEV__) console.log('Optional Expo notifications modules not loaded in bundle');
}

if (Notifications && Notifications.setNotificationHandler) {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  } catch (err) {
    // Ignore handler setup failure
  }
}

/**
 * Android channel ids, keyed by the backend's `NotificationPriority`.
 *
 * Exported because `scheduleLocalNotification` and the server's FCM payload MUST agree: a
 * push and a locally-raised notification about the same event should land in the same
 * channel, or the user's own per-channel settings apply to only half of what they see.
 * The backend mirrors these exact ids in `fcm-provider.ts`.
 *
 * The `_v1` suffix is load-bearing, not decoration. An Android channel's importance,
 * sound and vibration are locked the moment it is first created: `setNotificationChannelAsync`
 * on an existing id silently no-ops on those fields, and only the user can change them from
 * system settings. So the previous single `fapoms_audit_alerts` channel could not simply be
 * re-declared with saner settings — every already-installed app would have kept screaming at
 * MAX importance forever. New settings therefore require NEW ids; if these ever need
 * different importance again, bump to `_v2` and add the old id to OBSOLETE_CHANNEL_IDS.
 */
export const ANDROID_CHANNELS = {
  CRITICAL: 'orbit_critical_v1',
  HIGH: 'orbit_high_v1',
  NORMAL: 'orbit_normal_v1',
  LOW: 'orbit_low_v1',
} as const;

export type NotificationPriorityLike = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

/**
 * Channels replaced by the priority-based set above. Merely creating the new channels is not
 * enough on an upgraded install — the old one would linger in the app's notification settings
 * and keep receiving anything still addressed to it. Deleting is the only way to retire it.
 */
const OBSOLETE_CHANNEL_IDS = ['fapoms_audit_alerts', 'default'];

/** Falls back to NORMAL so an unrecognised or missing priority is never treated as an emergency. */
export function channelIdForPriority(priority?: string | null): string {
  switch (String(priority ?? '').toUpperCase()) {
    case 'CRITICAL':
    case 'URGENT':
      return ANDROID_CHANNELS.CRITICAL;
    case 'HIGH':
      return ANDROID_CHANNELS.HIGH;
    case 'LOW':
      return ANDROID_CHANNELS.LOW;
    default:
      return ANDROID_CHANNELS.NORMAL;
  }
}

/** Pre-Oreo handsets have no channels at all; this is the only lever they respond to. */
function androidPriorityFor(channelId: string): any {
  const P = Notifications?.AndroidNotificationPriority;
  if (!P) return undefined;
  switch (channelId) {
    case ANDROID_CHANNELS.CRITICAL:
      return P.MAX;
    case ANDROID_CHANNELS.HIGH:
      return P.HIGH;
    case ANDROID_CHANNELS.LOW:
      return P.LOW;
    default:
      return P.DEFAULT;
  }
}

/**
 * The `name`/`description` strings below are shown verbatim to the user in Android's per-app
 * notification settings, so they are written as product copy rather than as internal labels.
 *
 * A function called from startup rather than a module-import side effect, which is what this
 * used to be. That ordering mattered once the copy became translatable: the import runs before
 * `loadPreferences()` has read the saved language, so the channels would have been created in
 * English on every install regardless of what the assayer had chosen. `App` calls this
 * immediately after applying the language preference; Android permits later updates to a
 * channel's name and description (though not to its importance or sound), so a language change
 * re-labels them on the following launch.
 */
export function registerAndroidNotificationChannels(): void {
  if (Platform.OS !== 'android' || !Notifications?.setNotificationChannelAsync) return;
  const A = Notifications.AndroidImportance;

  Notifications.setNotificationChannelAsync(ANDROID_CHANNELS.CRITICAL, {
    name: t('notifications.channels.criticalName'),
    description: t('notifications.channels.criticalDescription'),
    importance: A.MAX,
    // Deliberately unlike every other channel: a long-short-long pulse is recognisable through
    // a pocket, which is the entire point of reserving MAX for genuine escalations.
    vibrationPattern: [0, 600, 200, 200, 200, 600],
    lightColor: '#8B7CFF',
    enableVibrate: true,
    showBadge: true,
    sound: 'default',
  }).catch(() => {});

  Notifications.setNotificationChannelAsync(ANDROID_CHANNELS.HIGH, {
    name: t('notifications.channels.highName'),
    description: t('notifications.channels.highDescription'),
    importance: A.HIGH,
    vibrationPattern: [0, 250, 150, 250],
    lightColor: '#8B7CFF',
    enableVibrate: true,
    showBadge: true,
    sound: 'default',
  }).catch(() => {});

  Notifications.setNotificationChannelAsync(ANDROID_CHANNELS.NORMAL, {
    name: t('notifications.channels.normalName'),
    // DEFAULT importance still makes a sound but does not pop a heads-up banner over whatever
    // the user is doing — the distinction that stops routine activity feeling like an alarm.
    description: t('notifications.channels.normalDescription'),
    importance: A.DEFAULT,
    vibrationPattern: [0, 200],
    lightColor: '#8B7CFF',
    enableVibrate: true,
    showBadge: true,
    sound: 'default',
  }).catch(() => {});

  Notifications.setNotificationChannelAsync(ANDROID_CHANNELS.LOW, {
    name: t('notifications.channels.lowName'),
    description: t('notifications.channels.lowDescription'),
    importance: A.LOW,
    lightColor: '#8B7CFF',
    enableVibrate: false,
    showBadge: false,
    sound: null,
  }).catch(() => {});

  for (const id of OBSOLETE_CHANNEL_IDS) {
    Notifications.deleteNotificationChannelAsync?.(id).catch(() => {});
  }
}

/**
  * Synthesizes an audible dual-tone alert chime (880Hz -> 1320Hz)
  * via Web Audio API when running in browser or preview context.
  */
export function playNotificationSound() {
  try {
    const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
    const AudioCtx = g.AudioContext || g.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'triangle';

      osc1.frequency.setValueAtTime(880, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);

      osc2.frequency.setValueAtTime(440, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(ctx.currentTime);
      osc2.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.5);
      osc2.stop(ctx.currentTime + 0.5);
    }
  } catch (e) {
    if (__DEV__) console.log('Audio chime play error:', e);
  }
}

/**
 * Triggers audio chime, system tray notification, and browser OS desktop alert.
 */
/**
 * @param trayNotification Whether to also post to the system tray. Callers that only run while
 *   the app is FOREGROUNDED should pass `false`: the tray exists for when the user is not
 *   looking, and the server has already pushed the same notification there. Polling raised its
 *   own copy of everything, so an event that arrived while the app was open appeared twice —
 *   once from FCM, once from here — in two different voices.
 */
export function triggerAlertNotification(
  title: string,
  body: string,
  data?: any,
  priority?: NotificationPriorityLike | string | null,
  trayNotification = true,
) {
  // The assayer's "Sound alerts" switch is consulted here — the one place the chime is
  // actually produced. Previously the switch set a React state field that nothing read, so
  // turning sound off still played the chime on every notification.
  if (getPreference('soundAlerts')) {
    playNotificationSound();
  }

  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
  if (Platform.OS === 'web' && g.window && 'Notification' in g.window && g.Notification.permission === 'granted') {
    try {
      new g.Notification(title, {
        body,
        icon: '/sumeru-logo.png',
        tag: data?.assignmentId || 'fapoms-alert',
        renotify: true,
      });
    } catch (e) {
      if (__DEV__) console.log('Web notification trigger error:', e);
    }
  }

  // `data.priority` is the fallback for callers that pass the whole notification row through
  // rather than lifting the priority out of it.
  if (trayNotification) {
    scheduleLocalNotification(title, body, data, priority ?? data?.priority);
  }
}

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
  if (Platform.OS === 'web' && g.window && 'Notification' in g.window) {
    try {
      if (g.Notification.permission !== 'granted') {
        const perm = await g.Notification.requestPermission();
        if (perm === 'granted') {
          if (__DEV__) console.log('Web Notification permission granted');
        }
      }
      return 'web-simulated-push-token';
    } catch (e) {
      if (__DEV__) console.log('Web notification setup failed:', e);
    }
  }

  /**
   * `Device.isDevice` is deliberately NOT required. It is false on every emulator, and gating
   * on it meant push could never be exercised outside a physical handset — the reason a broken
   * FCM setup went unnoticed for so long. Android emulators running a Google Play system image
   * register and receive FCM normally; one without Play Services simply fails the token call
   * below and is handled by the same catch as any other failure.
   */
  if (!Notifications) {
    return null;
  }

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      return null;
    }

    /**
     * The raw native token, not `getExpoPushTokenAsync()`.
     *
     * The backend's `FcmProvider` calls Firebase Admin SDK directly with whatever token is
     * registered — it expects a real FCM registration token. `getExpoPushTokenAsync()` returns
     * an Expo-wrapped token (`ExponentPushToken[...]`) meant for Expo's *own* push relay
     * instead; handing that to Firebase Admin SDK would be rejected outright. Registering
     * nothing (rather than a token guaranteed to fail) had been silently masking this.
     *
     * On Android this correctly yields the FCM registration token, backed by the
     * `google-services.json` now wired into `app.config.js`. On iOS it yields the raw APNs
     * token instead, which Firebase Admin SDK's `send()` does not accept as-is — true FCM
     * delivery there needs `@react-native-firebase/messaging` to bridge APNs↔FCM, which isn't
     * in this project yet and would need a new native build. Registering it anyway would just
     * manufacture a token guaranteed to fail on first send, so iOS is skipped here rather than
     * pretending to support it.
     */
    if (Platform.OS === 'ios') {
      return null;
    }

    const tokenData = await Notifications.getDevicePushTokenAsync();
    const token = tokenData?.data;

    const userId = MobileApiService.getCurrentUserId();
    if (userId && token) {
      try {
        await MobileApiService.fetchWithTimeout(`${MobileApiService.getBaseUrl()}/notifications/device-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${MobileApiService.getAuthToken()}`,
          },
          body: JSON.stringify({
            token,
            // iOS has already returned above — everything reaching here is Android.
            platform: 'android',
          }),
        }, 20_000);
      } catch (e) {
        console.error('Failed to register push token', e);
      }
    }

    // The catch-all `default` channel that used to be created here is gone: it duplicated the
    // priority channels declared at module load, and a channel literally named "default" in
    // the user's notification settings is exactly the kind of detail that reads as unfinished.

    return token;
  } catch (err) {
    if (__DEV__) console.log('Push notification registration error:', err);
    return null;
  }
}


/**
 * Stop this handset receiving pushes.
 *
 * The "Push notifications" switch in the profile previously set a React state field that
 * nothing read and nothing persisted — turning it off changed no behaviour at all, and the
 * server kept sending to this device indefinitely. Unregistering the token is the only thing
 * that genuinely stops delivery, since the decision is made server-side.
 */
export async function unregisterPushNotificationsAsync(): Promise<boolean> {
  if (!Notifications?.getDevicePushTokenAsync || Platform.OS !== 'android') return false;
  try {
    const tokenData = await Notifications.getDevicePushTokenAsync();
    const token = tokenData?.data;
    if (!token) return false;

    const response = await MobileApiService.fetchWithTimeout(`${MobileApiService.getBaseUrl()}/notifications/device-token/unregister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MobileApiService.getAuthToken()}`,
      },
      body: JSON.stringify({ token }),
    }, 20_000);
    return response.ok;
  } catch (err) {
    if (__DEV__) console.log('Push unregister failed:', err);
    return false;
  }
}

export function setupNotificationListeners(
  onNotificationReceived?: (notification: any) => void,
  onNotificationResponse?: (response: any) => void,
) {
  if (!Notifications) return () => {};

  try {
    const receivedSub = Notifications.addNotificationReceivedListener((notification: any) => {
      onNotificationReceived?.(notification);
    });

    const responseSub = Notifications.addNotificationResponseReceivedListener((response: any) => {
      onNotificationResponse?.(response);
    });

    return () => {
      try {
        receivedSub?.remove();
        responseSub?.remove();
      } catch (e) {}
    };
  } catch (err) {
    return () => {};
  }
}

/**
 * Covers the one case `addNotificationResponseReceivedListener` cannot: the app was fully
 * terminated, and the tap is what launched it. That listener only fires for a response
 * received while JS is already running, so a cold start from a notification tap would
 * otherwise open the app with no memory of why — landing on the default tab instead of the
 * record the notification was about. Call this once, right after mount.
 */
export async function getLastNotificationResponseAsync(): Promise<any | null> {
  if (!Notifications?.getLastNotificationResponseAsync) return null;
  try {
    return await Notifications.getLastNotificationResponseAsync();
  } catch (err) {
    return null;
  }
}

export async function scheduleLocalNotification(
  title: string,
  body: string,
  data?: any,
  priority?: NotificationPriorityLike | string | null,
) {
  if (Platform.OS === 'web' || !Notifications || !Notifications.scheduleNotificationAsync) return;
  try {
    const channelId = channelIdForPriority(priority ?? data?.priority);
    const isLow = channelId === ANDROID_CHANNELS.LOW;

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: data || {},
        // Respects the same "Sound alerts" switch as the in-app chime, so turning sound off
        // silences the tray notification too rather than only half of the experience.
        // Low-priority notices are silent by definition and never opt back in.
        sound: !isLow && getPreference('soundAlerts') ? 'default' : undefined,
        // Was MAX unconditionally, which made every self-raised notification as loud as an
        // escalation. Android caps this at the channel's importance anyway, so mirroring the
        // channel here just keeps the pre-Oreo path and the channel telling the same story.
        priority: androidPriorityFor(channelId),
      },
      // A bare `null` trigger fires immediately but on expo's own fallback channel, which is
      // why locally-raised notifications used to ignore everything the user configured for
      // server pushes. `{ channelId }` is expo's channel-aware trigger: still immediate, but
      // routed to the same channel FCM would have used for this priority.
      trigger: Platform.OS === 'android' ? { channelId } : null,
    });
  } catch (e) {
    console.error('Failed to schedule local notification', e);
  }
}
