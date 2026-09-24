/**
 * iPhone push, through Firebase Cloud Messaging (the server sends every push through Firebase).
 *
 * Android does not use this file: it keeps the existing path (expo-notifications' device token →
 * `POST /notifications/device-token`). On iPhone that path cannot work — Firebase does not accept a
 * raw Apple token — so React Native Firebase bridges Apple's push service to Firebase here.
 *
 * Quietly off unless the build included it: the native module is linked only into a new-app iPhone
 * build made with a valid GoogleService-Info.plist (see IOS-SETUP.md). Without it every function
 * here does nothing, and the rest of the app — including local arrival notifications — works.
 */
import { NativeModules, Platform } from 'react-native';
import { MobileApiService } from '../../services/api.service';

type RemoteMessage = { data?: Record<string, unknown> | null; messageId?: string };
type Messaging = {
  requestPermission: () => Promise<number>;
  getToken: () => Promise<string>;
  onTokenRefresh: (fn: (token: string) => void) => () => void;
  onMessage: (fn: (m: RemoteMessage) => void) => () => void;
  onNotificationOpenedApp: (fn: (m: RemoteMessage) => void) => () => void;
  getInitialNotification: () => Promise<RemoteMessage | null>;
  setBackgroundMessageHandler: (fn: (m: RemoteMessage) => Promise<void>) => void;
};

let cached: Messaging | null | undefined;

/** Firebase messaging, or null when this build does not have it (Android, or iOS without setup). */
function messaging(): Messaging | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (Platform.OS !== 'ios' || !NativeModules.RNFBAppModule) return cached;
  try {
    cached = require('@react-native-firebase/messaging').default() as Messaging;
  } catch {
    cached = null;
  }
  return cached;
}

export function iosPushAvailable(): boolean {
  return messaging() !== null;
}

/**
 * Must be called at module top level (from `tasks.ts`), so a data push can wake a closed app.
 */
export function setIosBackgroundHandler(handler: (data: unknown) => Promise<void>): void {
  const m = messaging();
  if (!m) return;
  try {
    m.setBackgroundMessageHandler(async (message) => {
      await handler(message?.data ?? message);
    });
  } catch {
    /* push refresh is lost; the next foreground refresh covers it */
  }
}

async function sendToken(token: string): Promise<void> {
  if (!token || !MobileApiService.getCurrentUserId()) return;
  await MobileApiService.fetchWithAuth(
    `${MobileApiService.getBaseUrl()}/notifications/device-token`,
    { method: 'POST', body: JSON.stringify({ token, platform: 'ios' }) },
    20_000,
  ).catch(() => undefined);
}

let unsubscribeRefresh: (() => void) | null = null;

/** Ask for permission, register this iPhone's Firebase token, and keep it current. */
export async function registerIosPush(): Promise<void> {
  const m = messaging();
  if (!m) return;
  try {
    const status = await m.requestPermission();
    // AuthorizationStatus: -1 not determined, 0 denied, 1 authorized, 2 provisional, 3 ephemeral.
    if (status !== 1 && status !== 2 && status !== 3) return;
    await sendToken(await m.getToken());
    unsubscribeRefresh?.();
    unsubscribeRefresh = m.onTokenRefresh((token) => void sendToken(token));
  } catch {
    /* no push on this phone right now; the app still works */
  }
}

/**
 * Pushes while the app is open (refresh) and taps on a push (open the job). Returns an unsubscribe.
 */
export function listenIosPush(handlers: { onData: (data: unknown) => void; onTap: (data: unknown) => void }): () => void {
  const m = messaging();
  if (!m) return () => undefined;
  const subs: (() => void)[] = [];
  try {
    subs.push(m.onMessage((message) => handlers.onData(message?.data ?? message)));
    subs.push(m.onNotificationOpenedApp((message) => handlers.onTap(message?.data ?? message)));
  } catch {
    /* ignore */
  }
  return () => subs.forEach((u) => u());
}

/** The push whose tap started the app, if any. */
export async function initialIosTap(): Promise<unknown | null> {
  const m = messaging();
  if (!m) return null;
  try {
    const message = await m.getInitialNotification();
    return message ? message.data ?? message : null;
  } catch {
    return null;
  }
}
