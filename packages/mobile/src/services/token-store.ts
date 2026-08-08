import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

/**
 * Where the signed-in session is kept.
 *
 * Every token read and write in the app used to go through `globalThis.localStorage`, guarded
 * by `if (g.localStorage)`. React Native has no `localStorage`, so on a real handset the guard
 * was always false and every write silently did nothing: the assayer re-entered their password
 * on every launch, and "Use biometric sign-in" could never work because it needs a stored
 * refresh token that was never stored.
 *
 * On native this is the OS keystore, which is the right home for a credential in an app that
 * carries bank audit evidence. On web — the Expo web preview — it falls back to
 * `localStorage`, which is what that platform actually provides.
 */

export type TokenKey =
  | 'fapoms_assayer_token'
  | 'fapoms_assayer_refresh_token'
  | 'fapoms_assayer_userId'
  | 'fapoms_assayer_userName';

const isWeb = Platform.OS === 'web';

const webStorage = (): Storage | null => {
  try {
    const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
    return g.localStorage ?? null;
  } catch {
    return null;
  }
};

export async function readToken(key: TokenKey): Promise<string | null> {
  try {
    if (isWeb) return webStorage()?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch (err) {
    // A keystore read can fail on a device whose credentials were invalidated (biometric
    // enrolment changed, for instance). Report it rather than silently signing the user out
    // with no explanation — the old code's blanket `catch {}` is what hid the whole problem.
    console.warn(`Could not read ${key} from secure storage:`, err);
    return null;
  }
}

export async function writeToken(key: TokenKey, value: string): Promise<void> {
  try {
    if (isWeb) {
      webStorage()?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  } catch (err) {
    console.warn(`Could not persist ${key} to secure storage:`, err);
  }
}

export async function deleteToken(key: TokenKey): Promise<void> {
  try {
    if (isWeb) {
      webStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  } catch (err) {
    console.warn(`Could not clear ${key} from secure storage:`, err);
  }
}

export const ALL_TOKEN_KEYS: TokenKey[] = [
  'fapoms_assayer_token',
  'fapoms_assayer_refresh_token',
  'fapoms_assayer_userId',
  'fapoms_assayer_userName',
];

/**
 * Non-secret device preferences (theme choice, and anything else that is a setting rather
 * than a credential).
 *
 * Kept in this module so the app has exactly one storage story, but deliberately on a
 * different tier: a preference does not belong in the OS keystore, and a credential does not
 * belong in a plain file. `ThemeProvider` used the same non-existent `globalThis.localStorage`
 * as the auth tokens did, so the assayer's light/dark choice was also silently discarded on
 * every launch.
 */
const PREF_FILE = `${FileSystem.documentDirectory}preferences.json`;

async function readPrefs(): Promise<Record<string, string>> {
  try {
    if (isWeb) return {};
    const info = await FileSystem.getInfoAsync(PREF_FILE);
    if (!info.exists) return {};
    return JSON.parse(await FileSystem.readAsStringAsync(PREF_FILE)) ?? {};
  } catch {
    return {};
  }
}

export async function readPreference(key: string): Promise<string | null> {
  if (isWeb) return webStorage()?.getItem(key) ?? null;
  return (await readPrefs())[key] ?? null;
}

export async function writePreference(key: string, value: string): Promise<void> {
  try {
    if (isWeb) {
      webStorage()?.setItem(key, value);
      return;
    }
    const all = await readPrefs();
    all[key] = value;
    await FileSystem.writeAsStringAsync(PREF_FILE, JSON.stringify(all));
  } catch (err) {
    console.warn(`Could not persist preference ${key}:`, err);
  }
}
