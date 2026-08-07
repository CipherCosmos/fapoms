import { Platform } from 'react-native';
import { MobileApiService } from './api.service';

let Notifications: any = null;
let Device: any = null;

try {
  Notifications = require('expo-notifications');
  Device = require('expo-device');
} catch (err) {
  console.log('Optional Expo notifications modules not loaded in bundle');
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

if (Platform.OS === 'android' && Notifications && Notifications.setNotificationChannelAsync) {
  Notifications.setNotificationChannelAsync('fapoms_audit_alerts', {
    name: 'FAPOMS Audit Assignment Alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 500, 250, 500],
    lightColor: '#FF6B00',
    enableVibrate: true,
    showBadge: true,
    sound: 'default',
  }).catch(() => {});
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
    console.log('Audio chime play error:', e);
  }
}

/**
 * Triggers audio chime, system tray notification, and browser OS desktop alert.
 */
export function triggerAlertNotification(title: string, body: string, data?: any) {
  playNotificationSound();

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
      console.log('Web notification trigger error:', e);
    }
  }

  scheduleLocalNotification(title, body, data);
}

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
  if (Platform.OS === 'web' && g.window && 'Notification' in g.window) {
    try {
      if (g.Notification.permission !== 'granted') {
        const perm = await g.Notification.requestPermission();
        if (perm === 'granted') {
          console.log('Web Notification permission granted');
        }
      }
      return 'web-simulated-push-token';
    } catch (e) {
      console.log('Web notification setup failed:', e);
    }
  }

  if (!Notifications || !Device || !Device.isDevice) {
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
        await fetch(`${MobileApiService.getBaseUrl()}/notifications/device-token`, {
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
        });
      } catch (e) {
        console.error('Failed to register push token', e);
      }
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF6B00',
      });
    }

    return token;
  } catch (err) {
    console.log('Push notification registration error:', err);
    return null;
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

export async function scheduleLocalNotification(title: string, body: string, data?: any) {
  if (Platform.OS === 'web' || !Notifications || !Notifications.scheduleNotificationAsync) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: data || {},
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      trigger: null, // trigger immediately in system tray
    });
  } catch (e) {
    console.error('Failed to schedule local notification', e);
  }
}
