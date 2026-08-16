import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import { queueFix, flushQueue, queuedCount, persistQueue } from '../services/location-queue';
import {
  decideFix,
  shouldUpload,
  shouldPushLive,
  heartbeatOverdue,
  HEARTBEAT_CHECK_MS,
  WATCH_OPTIONS,
  type PolicyFix,
  type RecordReason,
} from '../services/location-policy';
import { MobileApiService } from '../services/api.service';
import { calculateHaversineDistance } from '@fapoms/shared';

/**
 * How long to wait for a position before treating it as unobtainable. Long enough for a cold
 * start under open sky, short enough that someone indoors is told what to do rather than left
 * looking at a button that does nothing.
 */
const FIX_TIMEOUT_MS = 15000;

export interface LocationCoords {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
}

interface LocationContextType {
  location: LocationCoords | null;
  hasPermission: boolean | null;
  loadingLocation: boolean;
  errorMsg: string | null;
  requestLocationPermission: () => Promise<boolean>;
  refreshLocation: () => Promise<LocationCoords | null>;
  calculateDistanceKm: (targetLat: number, targetLng: number) => number | null;
  // Live-location sharing (default OFF, turned on for the duration of a job). While enabled the
  // device records a movement trail and keeps the backend's "where are they now" position current,
  // so the recommendation engine can rank by where the assayer actually is rather than their home
  // address, and a later travel claim has something to be checked against.
  liveTrackingEnabled: boolean;
  liveTrackingReady: boolean;
  setLiveTrackingEnabled: (enabled: boolean) => Promise<boolean>;
  /**
   * Declare that something else is already watching the device's position at a higher rate, and
   * will feed it here via `reportPosition`. Returns a function to stand down again.
   *
   * Turn-by-turn navigation is the case this exists for, and it is the worst case: an assayer
   * driving to a branch has the navigation view holding a `BestForNavigation` subscription — GPS
   * pinned, a fix every couple of seconds — at the exact moment the trail also wants to watch. Two
   * subscriptions do not halve anything; the OS services the union at the strictest setting, so
   * the second one costs a whole extra stream of callbacks and buys nothing the first is not
   * already producing. Borrowing that stream is free.
   */
  attachPositionSource: () => () => void;
  /** Hand a position from an attached source to the trail. Subject to the same recording policy. */
  reportPosition: (coords: LocationCoords) => void;
  /**
   * Consecutive failed position pushes, reset on the next success.
   *
   * Every one of these calls used to end in `.catch(() => {})`. Live position is what the
   * desk uses to see an assayer is actually at the branch, so a silently dead feed looks
   * identical to an assayer who never arrived — with nothing on the device hinting at it.
   * Exposing the count lets the UI say so instead of guessing.
   */
  liveTrackingFailures: number;
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

/**
 * There is deliberately no fallback coordinate.
 *
 * This used to return central New Delhi (28.6315, 77.2167) whenever GPS was denied or errored,
 * and that value flowed straight into check-in — the record that is supposed to prove a field
 * worker physically stood inside a bank branch. An assayer in rural Maharashtra with a bad fix
 * would be recorded as having checked in ~1,200 km away, indistinguishable from a genuine
 * reading, and an actually-fraudulent check-in would look identical to an honest one.
 *
 * `null` is the honest answer to "where are you?" when we do not know. Callers must handle it
 * and tell the user, rather than being handed a confident lie.
 */

/**
 * Drain the queued fixes to the server. Safe to call often — it no-ops when the queue is empty and
 * guards against overlapping drains internally, so a foreground return and a new fix cannot race.
 */
const flushLocationQueue = () =>
  flushQueue((batch) => MobileApiService.uploadLocationPings(batch)).catch(() => undefined);

/**
 * How often the device may re-ask the server whether sharing should be on.
 *
 * The flag is not the assayer's alone to set: accepting a job turns it on server-side, and the
 * handset has to find out. Re-checking when the app comes to the foreground is enough — nobody
 * accepts work without looking at their phone — and the throttle stops a user flicking between
 * apps from turning that into a stream of requests.
 */
const TRACKING_SYNC_MIN_INTERVAL_MS = 60_000;

export const LocationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [location, setLocation] = useState<LocationCoords | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [loadingLocation, setLoadingLocation] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live-location sharing. Default OFF; the initial value is loaded from the
  // server so it survives app restarts and reflects what HR/planning sees.
  const [liveTrackingFailures, setLiveTrackingFailures] = useState(0);
  const [liveTrackingEnabled, setLiveTrackingEnabledState] = useState(false);
  const [liveTrackingReady, setLiveTrackingReady] = useState(false);
  const liveEnabledRef = useRef(false);
  const hasPermissionRef = useRef<boolean | null>(null);

  // Cadence state. Refs, not state: none of it should cause a render, and the watcher callback
  // must see the current values rather than whatever was captured when it was registered — the
  // stale-closure trap that previously froze the whole trail on a single coordinate.
  const lastKeptFixRef = useRef<PolicyFix | null>(null);
  const lastUploadAtRef = useRef(0);
  const lastLivePushAtRef = useRef(0);
  const lastTrackingSyncAtRef = useRef(0);

  // How many higher-rate position sources are currently feeding us. A count rather than a flag so
  // two overlapping navigation views cannot have the first one to close stand the feed down.
  const positionSourcesRef = useRef(0);
  const [externalFeedActive, setExternalFeedActive] = useState(false);

  useEffect(() => {
    hasPermissionRef.current = hasPermission;
  }, [hasPermission]);

  /**
   * Ask the server whether sharing should be on, and adopt the answer.
   *
   * Deliberately one-directional: the server is the authority, because it is what turns tracking
   * on when a job is accepted and what refuses to let it off while that job is live.
   */
  const syncTrackingFlag = useCallback(async () => {
    const now = Date.now();
    if (now - lastTrackingSyncAtRef.current < TRACKING_SYNC_MIN_INTERVAL_MS) return;
    lastTrackingSyncAtRef.current = now;
    try {
      const res = await MobileApiService.getSelfProfile();
      if (res?.data) {
        const enabled = !!res.data.isLiveEnabled;
        liveEnabledRef.current = enabled;
        setLiveTrackingEnabledState(enabled);
      }
    } catch {
      // Keep whatever we had. A failed sync must never silently switch tracking off mid-job.
    } finally {
      setLiveTrackingReady(true);
    }
  }, []);

  useEffect(() => {
    void syncTrackingFlag();
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void syncTrackingFlag();
    });
    return () => sub.remove();
  }, [syncTrackingFlag]);

  /** Drain the queue only when a batch has built up or the oldest fix has waited long enough. */
  const uploadIfDue = useCallback(async () => {
    const count = await queuedCount();
    if (!shouldUpload(count, Date.now() - lastUploadAtRef.current)) return;
    lastUploadAtRef.current = Date.now();
    await flushLocationQueue();
  }, []);

  /**
   * Put a fix into the trail, if it is worth the cost.
   *
   * Two different jobs, deliberately not merged. The queued fix is *evidence*: it becomes part of
   * the movement trail a travel claim is later checked against, and a fix taken where there was no
   * signal is exactly the one worth keeping, so it is written to the device first and uploaded
   * when the network allows. The PUT answers "where is this assayer now" and is disposable — if it
   * fails, the next one replaces it and nothing is lost, which is why it is rate-limited to actual
   * movement while the trail is not.
   *
   * Returns whether the fix was kept, so the caller can avoid re-rendering the tree for a fix that
   * changed nothing.
   */
  const recordFix = useCallback(
    (coords: LocationCoords, opts: { force?: boolean } = {}): boolean => {
      // Nothing leaves the device while sharing is off. This gate is the reason the check is here
      // and not in the watcher: `refreshLocation` reaches this path too, and it runs at app start
      // for every user, assayer or not.
      if (!liveEnabledRef.current) return false;

      const now = Date.now();
      const candidate: PolicyFix = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracyMeters: coords.accuracy ?? null,
        at: now,
      };

      const decision = opts.force
        ? ({ record: true, reason: 'first' as RecordReason, movedMeters: 0 } as const)
        : decideFix(lastKeptFixRef.current, candidate);
      if (!decision.record) return false;

      lastKeptFixRef.current = candidate;

      void queueFix({
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        accuracyMeters: candidate.accuracyMeters,
        recordedAt: new Date(now).toISOString(),
      }).then(() => uploadIfDue());

      if (shouldPushLive(decision.reason, now - lastLivePushAtRef.current)) {
        lastLivePushAtRef.current = now;
        MobileApiService.updateLiveLocation(candidate.latitude, candidate.longitude)
          .then(() => setLiveTrackingFailures(0))
          .catch((err: any) => {
            setLiveTrackingFailures((n) => {
              const next = n + 1;
              if (next === 1 || next % 5 === 0) {
                console.warn(`Live location push failed (${next} in a row):`, err?.message ?? err);
              }
              return next;
            });
          });
      }

      return true;
    },
    [uploadIfDue],
  );

  const attachPositionSource = useCallback((): (() => void) => {
    positionSourcesRef.current += 1;
    setExternalFeedActive(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      positionSourcesRef.current = Math.max(0, positionSourcesRef.current - 1);
      if (positionSourcesRef.current === 0) setExternalFeedActive(false);
    };
  }, []);

  const reportPosition = useCallback(
    (coords: LocationCoords) => {
      if (recordFix(coords)) setLocation(coords);
    },
    [recordFix],
  );

  const requestLocationPermission = useCallback(async (): Promise<boolean> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setHasPermission(granted);
      hasPermissionRef.current = granted;
      if (!granted) {
        setErrorMsg('Permission to access location was denied');
      }
      return granted;
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error requesting location permission');
      setHasPermission(false);
      hasPermissionRef.current = false;
      return false;
    }
  }, []);

  const runRefreshLocation = useCallback(async (): Promise<LocationCoords | null> => {
    setLoadingLocation(true);
    setErrorMsg(null);
    try {
      let perm = hasPermissionRef.current;
      if (perm !== true) {
        perm = await requestLocationPermission();
      }

      if (perm) {
        const currentLoc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const coords: LocationCoords = {
          latitude: currentLoc.coords.latitude,
          longitude: currentLoc.coords.longitude,
          accuracy: currentLoc.coords.accuracy,
          altitude: currentLoc.coords.altitude,
          speed: currentLoc.coords.speed,
          heading: currentLoc.coords.heading,
        };
        setLocation(coords);
        setLoadingLocation(false);
        recordFix(coords);
        return coords;
      } else {
        // Permission refused. Say so plainly and report no position at all.
        setErrorMsg('Location is turned off. Turn on location to check in at a branch.');
        setLocation(null);
        setLoadingLocation(false);
        return null;
      }
    } catch (err: any) {
      setErrorMsg(
        'Could not get your location. Move to open sky if you are indoors, then try again.',
      );
      setLocation(null);
      setLoadingLocation(false);
      return null;
    }
  }, [requestLocationPermission, recordFix]);

  /**
   * The same call, but it always answers.
   *
   * Every await inside can hang indefinitely, not just the position request: asking the OS for a
   * fix never settles where there is no usable signal, and the permission request can stall
   * behind a system dialog. Whichever one stops, the effect is identical and it lands on the
   * person using the app — `handleCheckIn` awaits a fix before doing anything, so an assayer
   * standing in a bank vault, which is exactly where this app is used and exactly where GPS is
   * worst, tapped "Check in at branch" and got nothing at all: no error, no spinner, no request.
   * The button looked broken, and the message telling them to step outside — which this file
   * already contains — could never be reached.
   *
   * Bounding the operation as a whole, rather than one await inside it, is what makes that
   * impossible: the caller is promised an answer within `FIX_TIMEOUT_MS` whatever stalls. A
   * timeout resolves to `null`, which is the same "no fix" the callers already handle.
   */
  const refreshLocation = useCallback(async (): Promise<LocationCoords | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runRefreshLocation(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            setErrorMsg('Could not get your location in time. Move to open sky if you are indoors, then try again.');
            setLoadingLocation(false);
            resolve(null);
          }, FIX_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, [runRefreshLocation]);

  useEffect(() => {
    refreshLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Watch the device's position while sharing is on.
   *
   * This replaced a thirty-second timer that called `getCurrentPositionAsync`, which was both
   * wasteful and wrong: wasteful because it demanded a fresh fix whether or not anyone had moved,
   * and wrong because the timer closed over a stale `location`, so after the first fix it pushed
   * the *same coordinate* every thirty seconds — a trail that recorded a stationary assayer no
   * matter how far they drove, and would have contradicted honest travel claims.
   *
   * A subscription hands the filtering to the platform's own fusion engine, which can answer from
   * cell and wifi and leave the GNSS chip asleep when nothing is happening. `decideFix` then
   * decides what is worth keeping, so a stationary handset settles at one recorded fix every four
   * minutes instead of a hundred and twenty an hour.
   *
   * The subscription is torn down when the app leaves the foreground. That is not a compromise:
   * this app holds foreground permission only (`NSLocationWhenInUseUsageDescription`,
   * `ACCESS_FINE_LOCATION`), so the OS stops delivering fixes anyway and a live subscription would
   * be nothing but wake-ups that return nothing.
   */
  useEffect(() => {
    if (!liveTrackingEnabled) {
      // Ending a job should not strand evidence on the handset.
      void flushLocationQueue();
      lastKeptFixRef.current = null;
      return;
    }

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    const start = async () => {
      // Something faster is already watching and feeding us; a second subscription would only
      // duplicate its callbacks. `reportPosition` carries the trail while it lasts.
      if (cancelled || subscription || externalFeedActive) return;
      const perm = hasPermissionRef.current === true ? true : await requestLocationPermission();
      if (!perm || cancelled) return;
      try {
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, ...WATCH_OPTIONS },
          (pos) => {
            const coords: LocationCoords = {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              altitude: pos.coords.altitude,
              speed: pos.coords.speed,
              heading: pos.coords.heading,
            };
            // Only re-render for a fix the trail actually kept. While driving the OS can deliver
            // one every couple of seconds, and re-rendering every consumer for a position nothing
            // reads at that resolution is its own kind of battery drain.
            if (recordFix(coords)) setLocation(coords);
          },
        );
        if (cancelled) sub.remove();
        else subscription = sub;
      } catch {
        // Location services off or revoked mid-session. `refreshLocation` reports it to the user;
        // there is nothing useful to do from a background subscription attempt.
      }
    };

    /**
     * The heartbeat, and the reason it is a timer rather than part of the stream above.
     *
     * `distanceInterval` is what makes the subscription cheap, and it means a handset that has not
     * moved is delivered nothing at all — so a stationary assayer would go completely silent, the
     * one reading indistinguishable from a switched-off phone. This checks whether the trail has
     * gone quiet and asks for a position only then: on a moving device the condition is false and
     * nothing is spent.
     */
    const beat = async () => {
      if (cancelled || !liveEnabledRef.current) return;
      if (!heartbeatOverdue(lastKeptFixRef.current, Date.now())) return;
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        recordFix({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          speed: pos.coords.speed,
          heading: pos.coords.heading,
        });
      } catch {
        // No fix available. The gap is then real, and the server is right to score it as
        // unobserved rather than have the device invent a position to fill it.
      }
    };

    const heartbeat = setInterval(() => void beat(), HEARTBEAT_CHECK_MS);

    const stop = () => {
      subscription?.remove();
      subscription = null;
    };

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        void start();
        void beat();
        void flushLocationQueue();
        lastUploadAtRef.current = Date.now();
      } else {
        stop();
        // The debounce in the queue is a small window, but the OS suspending the process is
        // exactly when it would be open.
        void persistQueue();
        void flushLocationQueue();
      }
    };

    void start();
    // Anchor the window immediately rather than waiting on the platform's first callback.
    void beat();
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      cancelled = true;
      stop();
      clearInterval(heartbeat);
      sub.remove();
      void persistQueue();
    };
    // `externalFeedActive` belongs here: when a navigation view takes over the effect re-runs, the
    // cleanup drops our subscription, and `start` declines to open another. When it closes, the
    // effect runs again and the watch resumes.
  }, [liveTrackingEnabled, externalFeedActive, requestLocationPermission, recordFix]);

  const setLiveTrackingEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      const ok = await MobileApiService.setLiveTracking(enabled);
      if (ok) {
        liveEnabledRef.current = enabled;
        setLiveTrackingEnabledState(enabled);
        if (enabled) {
          // Anchor the trail at the moment sharing started, so the window has a known first point
          // rather than waiting on the OS for its first callback.
          lastKeptFixRef.current = null;
          const loc = await refreshLocation();
          if (loc) recordFix(loc, { force: true });
        }
      }
      return ok;
    },
    [refreshLocation, recordFix],
  );

  // Haversine formula to compute distance in km
  const calculateDistanceKm = useCallback(
    (targetLat: number, targetLng: number): number | null => {
      // Returns null rather than a distance measured from an invented origin — a
      // "1,240 km away" badge computed from a fallback coordinate is worse than no badge.
      const current = location;
      if (!current) return null;

      const km = calculateHaversineDistance(current.latitude, current.longitude, targetLat, targetLng);
      return Math.round(km * 10) / 10;
    },
    [location]
  );

  return (
    <LocationContext.Provider
      value={{
        location,
        hasPermission,
        loadingLocation,
        errorMsg,
        requestLocationPermission,
        refreshLocation,
        calculateDistanceKm,
        liveTrackingEnabled,
        liveTrackingReady,
        setLiveTrackingEnabled,
        liveTrackingFailures,
        attachPositionSource,
        reportPosition,
      }}
    >
      {children}
    </LocationContext.Provider>
  );
};

export const useLocation = (): LocationContextType => {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error('useLocation must be used within a LocationProvider');
  }
  return context;
};
