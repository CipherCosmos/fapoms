import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as Location from 'expo-location';
import { MobileApiService } from '../services/api.service';

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
  // Live-location sharing (opt-in, default OFF). When enabled, the device keeps
  // pushing its current position to the backend so the recommendation engine can
  // rank by where the assayer actually is, not just their home address.
  liveTrackingEnabled: boolean;
  liveTrackingReady: boolean;
  setLiveTrackingEnabled: (enabled: boolean) => Promise<boolean>;
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

export const LocationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [location, setLocation] = useState<LocationCoords | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [loadingLocation, setLoadingLocation] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live-location sharing. Default OFF; the initial value is loaded from the
  // server so it survives app restarts and reflects what HR/planning sees.
  const [liveTrackingEnabled, setLiveTrackingEnabledState] = useState(false);
  const [liveTrackingReady, setLiveTrackingReady] = useState(false);
  const liveEnabledRef = useRef(false);
  const reportTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load the current live-sharing flag from the backend once (self profile).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await MobileApiService.getSelfProfile();
        if (!cancelled && res?.data) {
          const enabled = !!res.data.isLiveEnabled;
          liveEnabledRef.current = enabled;
          setLiveTrackingEnabledState(enabled);
        }
      } catch {
        // keep default OFF
      } finally {
        if (!cancelled) setLiveTrackingReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const requestLocationPermission = useCallback(async (): Promise<boolean> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setHasPermission(granted);
      if (!granted) {
        setErrorMsg('Permission to access location was denied');
      }
      return granted;
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error requesting location permission');
      setHasPermission(false);
      return false;
    }
  }, []);

  const refreshLocation = useCallback(async (): Promise<LocationCoords | null> => {
    setLoadingLocation(true);
    setErrorMsg(null);
    try {
      let perm = hasPermission;
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
        MobileApiService.updateLiveLocation(coords.latitude, coords.longitude).catch(() => {});
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
  }, [hasPermission, requestLocationPermission]);

  useEffect(() => {
    refreshLocation();
  }, []);

  // Report the live position on an interval while sharing is enabled. Only runs
  // when the assayer has opted in — live coordinates never reach the backend
  // (and are never used for recommendations) while sharing is off.
  useEffect(() => {
    if (reportTimerRef.current) {
      clearInterval(reportTimerRef.current);
      reportTimerRef.current = null;
    }
    if (!liveTrackingEnabled) return;
    const report = async () => {
      const cur = location;
      if (!cur) {
        const loc = await refreshLocation();
        if (loc) MobileApiService.updateLiveLocation(loc.latitude, loc.longitude).catch(() => {});
        return;
      }
      MobileApiService.updateLiveLocation(cur.latitude, cur.longitude).catch(() => {});
    };
    report();
    reportTimerRef.current = setInterval(report, 30000);
    return () => {
      if (reportTimerRef.current) { clearInterval(reportTimerRef.current); reportTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTrackingEnabled]);

  const setLiveTrackingEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    const ok = await MobileApiService.setLiveTracking(enabled);
    if (ok) {
      liveEnabledRef.current = enabled;
      setLiveTrackingEnabledState(enabled);
      // Immediately report a fresh position so the switch takes effect right away.
      if (enabled) {
        const loc = await refreshLocation();
        if (loc) MobileApiService.updateLiveLocation(loc.latitude, loc.longitude).catch(() => {});
      }
    }
    return ok;
  }, [refreshLocation]);

  // Haversine formula to compute distance in km
  const calculateDistanceKm = useCallback(
    (targetLat: number, targetLng: number): number | null => {
      // Returns null rather than a distance measured from an invented origin — a
      // "1,240 km away" badge computed from a fallback coordinate is worse than no badge.
      const current = location;
      if (!current) return null;

      const R = 6371; // Earth's radius in km
      const dLat = (targetLat - current.latitude) * (Math.PI / 180);
      const dLon = (targetLng - current.longitude) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(current.latitude * (Math.PI / 180)) *
          Math.cos(targetLat * (Math.PI / 180)) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return Math.round(R * c * 10) / 10;
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
