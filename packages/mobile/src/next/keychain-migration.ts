/**
 * Moving an existing login to the "readable after first unlock" keychain class.
 *
 * `expo-secure-store` on iOS finds an item without looking at its class, and when it overwrites
 * one it changes only the value, never the class. So a login saved by the current app (default
 * class: only while unlocked) would stay unreadable on a locked phone forever, however often the
 * new app rewrote it. The only way to change the class is to delete the item and add it again.
 *
 * Done once, while the app is on screen (the phone is unlocked, so the old items are readable).
 * Pure over an injected store, for node tests.
 */
export interface KeychainStore {
  read: (key: string) => Promise<string | null>;
  remove: (key: string) => Promise<void>;
  /** Writes with the NEW class. */
  write: (key: string, value: string) => Promise<void>;
}

/** Returns how many items were moved. A failed item is left as it was and does not stop the rest. */
export async function moveToNewKeychainClass(keys: readonly string[], store: KeychainStore): Promise<number> {
  let moved = 0;
  for (const key of keys) {
    let value: string | null = null;
    try {
      value = await store.read(key);
    } catch {
      continue;
    }
    if (value == null) continue;
    try {
      await store.remove(key);
      await store.write(key, value);
      moved++;
    } catch {
      // Put it back as it was if the add failed after the delete: never lose the login.
      try {
        await store.write(key, value);
      } catch {
        /* nothing more to do; the person signs in again */
      }
    }
  }
  return moved;
}

/** Where "already moved" is remembered (plain preferences file). */
export const KEYCHAIN_MOVED_KEY = 'next.keychainAfterFirstUnlock';
