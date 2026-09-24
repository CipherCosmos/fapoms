/**
 * The new app's keychain rule, applied on import — `entry.ts` imports this FIRST, before the
 * background tasks, so even a headless start (a geofence on a locked phone) reads the login with it.
 *
 * Owner decision (2026-09-24): the login is readable AFTER FIRST UNLOCK — i.e. after the phone
 * has been unlocked once since it was switched on — so an arrival check-in works while the phone
 * is locked. Only the new app does this; the current app keeps the default ("while unlocked").
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { ALL_TOKEN_KEYS, readPreference, setSecureStoreOptions, writePreference } from '../services/token-store';
import { KEYCHAIN_MOVED_KEY, moveToNewKeychainClass } from './keychain-migration';

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

setSecureStoreOptions(OPTIONS);

/**
 * Once per install, on screen: move a login an earlier build saved into the new class (see
 * keychain-migration.ts). iPhone only; Android's keystore has no such classes.
 */
export async function moveLoginToAfterFirstUnlock(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    if ((await readPreference(KEYCHAIN_MOVED_KEY)) === '1') return;
    await moveToNewKeychainClass(ALL_TOKEN_KEYS, {
      read: (key) => SecureStore.getItemAsync(key, OPTIONS),
      remove: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
      write: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
    });
    await writePreference(KEYCHAIN_MOVED_KEY, '1');
  } catch {
    /* tried again next launch */
  }
}
