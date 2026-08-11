import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Thin, crash-proof haptics wrapper.
 *
 * Apple's UI ticks on every deliberate action — a button press, a toggle, a success. It is a big
 * part of why native apps feel "alive". This centralises that so screens just say `tap()` /
 * `success()` without importing the module or guarding platform + failure every time.
 *
 * Web has no haptics engine and some Android devices disable the vibrator; both must be a silent
 * no-op, never an unhandled rejection, so every call is fire-and-forget and swallows errors.
 */

const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

/** A light tick for an ordinary button press. */
export function tap(): void {
  if (!enabled) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** A firmer tap for a primary / committing action (accept, check-in, submit). */
export function commit(): void {
  if (!enabled) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Confirmation buzz for a completed action. */
export function success(): void {
  if (!enabled) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Warning buzz for a failed or rejected action. */
export function error(): void {
  if (!enabled) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}

/** Light selection change (segmented control, tab switch). */
export function select(): void {
  if (!enabled) return;
  Haptics.selectionAsync().catch(() => {});
}
