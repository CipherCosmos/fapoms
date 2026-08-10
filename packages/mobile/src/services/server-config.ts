import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Constants from 'expo-constants';

/**
 * Where this install talks to the backend.
 *
 * The server address used to be decided entirely at build time: an `EXPO_PUBLIC_API_URL` baked
 * into the bundle, or a fallback of `10.0.2.2:3000`. That fallback is the Android emulator's
 * alias for the host machine — it does not resolve on a real handset — so a release APK
 * installed on a phone had no reachable server and no way to be told about one short of
 * rebuilding. The port was hardcoded three separate times too, so moving the backend off 3000
 * (as this deployment has, to 3001) broke the app with no setting to correct it.
 *
 * The resolved address is therefore: on-device override, else build-time env, else a derived
 * development guess. Persisted with expo-file-system rather than pulling in AsyncStorage as a
 * new dependency, the same call ThemeProvider makes.
 */

const CONFIG_FILE = `${FileSystem.documentDirectory}server-config.json`;

/** Standard backend port. Overridable at build time and on the device. */
const DEFAULT_PORT = process.env.EXPO_PUBLIC_API_PORT || '3000';

/** Normalise whatever the operator typed into a usable API root. */
export function normaliseServerUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  return url.endsWith('/api/v1') ? url : `${url}/api/v1`;
}

/** The address to use when nothing has been configured on the device. */
export function getDefaultServerUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL || Constants.expoConfig?.extra?.apiUrl;
  if (envUrl) return normaliseServerUrl(envUrl);

  if (__DEV__) {
    const hostUri = Constants.expoConfig?.hostUri;
    if (hostUri) {
      let ip = hostUri.split(':')[0];
      // adb reverse makes hostUri 127.0.0.1, which is the emulator's own loopback.
      // Rewrite to 10.0.2.2 so the request reaches the host machine.
      if (Platform.OS === 'android' && (ip === '127.0.0.1' || ip === 'localhost')) {
        ip = '10.0.2.2';
      }
      return `http://${ip}:${DEFAULT_PORT}/api/v1`;
    }
  }

  return Platform.OS === 'android'
    ? `http://10.0.2.2:${DEFAULT_PORT}/api/v1`
    : `http://localhost:${DEFAULT_PORT}/api/v1`;
}

export async function loadStoredServerUrl(): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(CONFIG_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(CONFIG_FILE);
    const parsed = JSON.parse(raw);
    return typeof parsed?.serverUrl === 'string' && parsed.serverUrl ? parsed.serverUrl : null;
  } catch {
    // A corrupt or unreadable config must not stop the app booting — it just falls back
    // to the default address.
    return null;
  }
}

export async function saveServerUrl(url: string): Promise<void> {
  await FileSystem.writeAsStringAsync(CONFIG_FILE, JSON.stringify({ serverUrl: url }));
}

export async function clearServerUrl(): Promise<void> {
  try {
    await FileSystem.deleteAsync(CONFIG_FILE, { idempotent: true });
  } catch {
    // Already gone.
  }
}

/**
 * Check an address before committing to it, so a typo is caught at the settings screen
 * instead of surfacing later as an unexplained login failure.
 */
export async function probeServerUrl(apiRoot: string, timeoutMs = 6000): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // /health sits outside the auth guard, so an unauthenticated probe is a fair test of
    // "is the backend reachable at this address".
    const base = apiRoot.replace(/\/api\/v1$/, '');
    const response = await fetch(`${base}/api/v1/health`, { signal: controller.signal });
    if (response.ok) return { ok: true };
    return { ok: false, error: `Server answered with ${response.status}.` };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === 'AbortError'
        ? 'No response within 6 seconds. Check the address and that you are on the same network.'
        : 'Could not reach that address.',
    };
  } finally {
    clearTimeout(timer);
  }
}
