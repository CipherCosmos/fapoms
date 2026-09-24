/**
 * Bring a signed-in session up with no screen: the OS has woken the app for a geofence, a
 * background run or a push, and nothing has run `AuthProvider`.
 *
 * Same steps the provider takes on a cold start (`AuthContext.initSession` + `claimQueues`),
 * against the same services: the server address, the keystore session, and the queue ownership
 * rule — so work is only ever sent under its owner's session, exactly as in the foreground.
 * Nothing is duplicated except the three-line glue the provider keeps private.
 */
import { MobileApiService, initApiBaseUrl } from '../../services/api.service';
import { adoptUnownedActions, clearActionQueue, getActionQueueOwner, setActionQueueOwner } from '../../services/action-queue';
import { clearQueue } from '../../services/location-queue';
import { loadPreferences } from '../../services/preferences';
import { advanceSession } from '../../services/session-epoch';
import { QUEUE_OWNER_CACHE_KEY, claimQueuedWorkFor } from '../../services/session-owner';
import { readCache, writeCache } from '../../services/token-store';
import { clearOutbox } from '../../services/upload-outbox';

/**
 * The signed-in user id, or null when there is no session on this phone.
 *
 * If the app is already running (the task landed in the live JS runtime), the live session is
 * used untouched — restoring again would reset what `AuthProvider` set up.
 */
export async function ensureSession(): Promise<string | null> {
  const live = getActionQueueOwner();
  if (live && MobileApiService.authToken) return live;

  await Promise.all([initApiBaseUrl().catch(() => undefined), loadPreferences().catch(() => undefined)]);
  const session = await MobileApiService.restoreSession();
  if (!session?.token) return null;
  const userId = session.userId || MobileApiService.getCurrentUserId();
  if (!userId) return null;

  const setOwner = (id: string | null) => {
    setActionQueueOwner(id);
    advanceSession(id);
  };
  try {
    await claimQueuedWorkFor(userId, 'restored', {
      readOwner: () => readCache<string>(QUEUE_OWNER_CACHE_KEY),
      writeOwner: (id) => writeCache(QUEUE_OWNER_CACHE_KEY, id),
      clearQueues: async () => {
        await Promise.all([clearQueue(), clearOutbox(), clearActionQueue()]);
      },
      adoptUnowned: adoptUnownedActions,
      setOwner,
    });
  } catch {
    setOwner(userId);
  }
  return userId;
}
