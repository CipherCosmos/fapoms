import { readPreference, writePreference } from './token-store';

/**
 * Device-level settings an assayer controls from the Profile screen.
 *
 * These existed only as fields on the in-memory profile object. Flipping one changed a React
 * state value, nothing read it back, and nothing persisted it — so every switch reset on the
 * next launch and none of them ever altered the app's behaviour. They were decoration.
 *
 * They now live on the device (the same store the theme preference uses) and each one is
 * consulted at the point it actually matters:
 *
 *   soundAlerts   — notification.service, before playing the alert chime
 *   biometrics    — LoginScreen, before offering biometric sign-in
 *   haptics       — reserved for tactile feedback on field actions
 *
 * Push notifications are deliberately NOT here: that switch has a server-side effect
 * (registering or removing this handset's FCM token), so it is handled in the API layer
 * rather than as a local flag.
 */

export interface DevicePreferences {
  /** Play a chime when a notification arrives. */
  soundAlerts: boolean;
  /** Offer fingerprint/Face ID sign-in on the login screen. */
  biometrics: boolean;
  /** Vibrate on significant field actions (check-in, upload complete). */
  haptics: boolean;
  /**
   * Last known push registration state for this handset.
   *
   * The authoritative state is server-side (whether this device's token is registered), but
   * mirroring it locally lets the switch render correctly on launch without a network call,
   * and keeps it correct offline. Written only after the server accepts the change.
   */
  pushEnabled: boolean;
}

export const DEFAULT_PREFERENCES: DevicePreferences = {
  // On by default: a field worker who misses an assignment offer loses the job, so the
  // audible cue is opt-out rather than opt-in.
  soundAlerts: true,
  /**
   * OFF by default, deliberately — the one preference here that is opt-in.
   *
   * Biometric sign-in binds this account to whatever fingerprints are enrolled on the handset,
   * and an assayer's phone is not always exclusively theirs. Defaulting it on enrols people in
   * that trade-off silently, at first launch, before they have been told it exists. It also
   * changes what a locked app means: with biometrics on, `AuthContext` re-locks on resume and
   * the sensor becomes the only way back in.
   *
   * Turning it on is one switch in Profile. Turning it off after it has already bound to
   * someone else's finger is not a recovery any field user should need.
   */
  biometrics: false,
  haptics: true,
  pushEnabled: true,
};

const KEY_PREFIX = 'fapoms_pref_';

const KEYS: Record<keyof DevicePreferences, string> = {
  soundAlerts: `${KEY_PREFIX}sound_alerts`,
  biometrics: `${KEY_PREFIX}biometrics`,
  haptics: `${KEY_PREFIX}haptics`,
  pushEnabled: `${KEY_PREFIX}push_enabled`,
};

/**
 * A synchronous mirror of what is on disk.
 *
 * The consumers that matter — the notification chime, the login screen — run in contexts
 * where awaiting a file read is impractical or would visibly delay the UI. `loadPreferences()`
 * fills this once at startup; everything after that reads it synchronously.
 */
let cache: DevicePreferences = { ...DEFAULT_PREFERENCES };

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/** Call once during startup, before the first screen renders. */
export async function loadPreferences(): Promise<DevicePreferences> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as (keyof DevicePreferences)[]).map(async (k) => {
      const raw = await readPreference(KEYS[k]).catch(() => null);
      return [k, parseBool(raw, DEFAULT_PREFERENCES[k])] as const;
    }),
  );
  cache = entries.reduce((acc, [k, v]) => ({ ...acc, [k]: v }), { ...DEFAULT_PREFERENCES });
  return cache;
}

/** The current value, without touching disk. Safe to call from render paths. */
export function getPreferences(): DevicePreferences {
  return cache;
}

export function getPreference<K extends keyof DevicePreferences>(key: K): DevicePreferences[K] {
  return cache[key];
}

/** Update one setting and persist it. The cache is updated first so the UI responds at once. */
export async function setPreference<K extends keyof DevicePreferences>(
  key: K,
  value: DevicePreferences[K],
): Promise<void> {
  cache = { ...cache, [key]: value };
  await writePreference(KEYS[key], String(value)).catch(() => {
    // A failed write leaves the in-memory value applied for this session rather than
    // silently reverting the switch the user just flipped.
  });
}
