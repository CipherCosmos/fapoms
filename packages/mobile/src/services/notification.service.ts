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
  Notifications.setNotificationChannelAsync('default', {
    name: 'FAPOMS Field Notifications',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#38BDF8',
    enableVibrate: true,
    showBadge: true,
    sound: 'default',
  }).catch(() => {});
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

    const tokenData = await Notifications.getExpoPushTokenAsync();
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
            platform: Platform.OS === 'ios' ? 'ios' : 'android',
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
        lightColor: '#6366f1',
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

export async function scheduleLocalNotification(title: string, body: string, data?: any) {
  if (!Notifications || !Notifications.scheduleNotificationAsync) return;
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
