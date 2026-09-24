import * as Location from 'expo-location';
import { writePreference } from '../../services/token-store';
import { ARRIVAL_EXPLAINED_KEY, nextRequest } from './permission-flow';
import { readPermissionFacts } from './runtime';

/**
 * The person tapped "Yes, check me in by itself": ask the OS, foreground first, then background.
 * Records that the question was answered either way, so it is never shown again by itself.
 * Resolves true when automatic check-in is now on.
 */
export async function requestArrivalPermission(): Promise<boolean> {
  await writePreference(ARRIVAL_EXPLAINED_KEY, '1');
  for (let i = 0; i < 2; i++) {
    const facts = await readPermissionFacts(true);
    const step = nextRequest(facts);
    if (step === 'done') return true;
    if (step === 'blocked') return false;
    try {
      const res =
        step === 'foreground'
          ? await Location.requestForegroundPermissionsAsync()
          : await Location.requestBackgroundPermissionsAsync();
      if (res.status !== 'granted') return false;
    } catch {
      return false;
    }
  }
  const final = await readPermissionFacts(true);
  return final.foreground === 'granted' && final.background === 'granted';
}

/** "Not now": answered, do not ask again by itself. */
export async function declineArrivalPermission(): Promise<void> {
  await writePreference(ARRIVAL_EXPLAINED_KEY, '1');
}

/** For the one-tap check-in: make sure foreground location is on (asks if it may). */
export async function ensureForegroundLocation(): Promise<boolean> {
  const current = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (current?.status === 'granted') return true;
  if (current && !current.canAskAgain) return false;
  const res = await Location.requestForegroundPermissionsAsync().catch(() => null);
  return res?.status === 'granted';
}
