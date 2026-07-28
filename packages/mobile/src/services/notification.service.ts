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

export async function registerForPushNotificationsAsync(): Promise<string | null> {
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
