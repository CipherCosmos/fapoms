import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { actionDispatchers } from '../../services/action-dispatchers';
import { processActionQueue } from '../../services/action-queue';
import { isStampCurrent, stampSession } from '../../services/session-epoch';
import type { AssayerAssignment } from '../../types/mobile-app';
import {
  nextPendingOpening,
  processPendingArrivals,
  readCachedJobs,
  refreshJobs,
  subscribeJobsChanged,
  syncGeofences,
} from '../background/runtime';

export interface JobsState {
  jobs: AssayerAssignment[];
  loading: boolean;
  /** The list on screen is the saved copy because the last refresh failed. */
  stale: boolean;
  /** When the list on screen was fetched. */
  savedAt: string | null;
  /** True once either the saved copy or the server has answered. */
  loaded: boolean;
  refresh: () => Promise<void>;
}

/**
 * The assayer's jobs for the new app: paint the saved copy at once (no signal in a strongroom is
 * normal), then ask the server; send anything queued first so the answer reflects it; then point
 * the arrival circles at the new list. Everything goes through the existing API client, queue and
 * cache (the same `assignments` cache the current app writes, owner-stamped).
 */
export function useJobs(): JobsState {
  const { isAuthenticated, user } = useAuth();
  const userId = user?.id ?? null;
  const [jobs, setJobs] = useState<AssayerAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAuthenticated || !userId) return;
    const stamp = stampSession();
    setLoading(true);
    try {
      await processActionQueue(actionDispatchers).catch(() => undefined);
      const items = await refreshJobs(userId);
      if (!isStampCurrent(stamp)) return;
      setJobs(items);
      setStale(false);
      setSavedAt(new Date().toISOString());
      setLoaded(true);
      void syncGeofences(userId, items).catch(() => undefined);
      // An early arrival waiting for check-in to open is tried whenever the app comes forward.
      void processPendingArrivals(userId).catch(() => undefined);
    } catch {
      if (!isStampCurrent(stamp)) return;
      setStale(true);
      setLoaded(true);
    } finally {
      if (isStampCurrent(stamp)) setLoading(false);
    }
  }, [isAuthenticated, userId]);

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      setJobs([]);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    const stamp = stampSession();
    void readCachedJobs(userId).then((cached) => {
      if (cancelled || !cached || !isStampCurrent(stamp)) return;
      setJobs((current) => (current.length ? current : cached.items));
      setSavedAt((current) => current ?? cached.at);
      setLoaded(true);
    });
    void refresh();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    // The background refreshed the list (a silent push, a background run): show it.
    const unsubscribe = subscribeJobsChanged(() => {
      void readCachedJobs(userId).then((cached) => {
        if (cancelled || !cached || !isStampCurrent(stamp)) return;
        setJobs(cached.items);
        setSavedAt(cached.at);
        setStale(false);
      });
    });
    return () => {
      cancelled = true;
      sub.remove();
      unsubscribe();
    };
  }, [isAuthenticated, userId, refresh]);

  // While the app is open, try a waiting early arrival the moment check-in opens.
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    void nextPendingOpening(userId).then((when) => {
      if (cancelled || !when) return;
      // setTimeout's ceiling is ~24.8 days; an opening is always within the same day.
      timer = setTimeout(() => void processPendingArrivals(userId).then(refresh).catch(() => undefined), Math.max(0, when.getTime() - Date.now()) + 5_000);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isAuthenticated, userId, jobs, refresh]);

  return { jobs, loading, stale, savedAt, loaded, refresh };
}
