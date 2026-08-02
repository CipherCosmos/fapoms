import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as Location from 'expo-location';

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
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

// Default fallback coordinates (New Delhi central) if GPS fails or permission denied
const DEFAULT_FALLBACK_LOCATION: LocationCoords = {
  latitude: 28.6315,
  longitude: 77.2167,
};

export const LocationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [location, setLocation] = useState<LocationCoords | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [loadingLocation, setLoadingLocation] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
        return coords;
      } else {
        setLocation(DEFAULT_FALLBACK_LOCATION);
        setLoadingLocation(false);
        return DEFAULT_FALLBACK_LOCATION;
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to fetch current location');
      setLocation(DEFAULT_FALLBACK_LOCATION);
      setLoadingLocation(false);
      return DEFAULT_FALLBACK_LOCATION;
    }
  }, [hasPermission, requestLocationPermission]);

  useEffect(() => {
    refreshLocation();
  }, []);

  // Haversine formula to compute distance in km
  const calculateDistanceKm = useCallback(
    (targetLat: number, targetLng: number): number | null => {
      const current = location || DEFAULT_FALLBACK_LOCATION;
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
        location: location || DEFAULT_FALLBACK_LOCATION,
        hasPermission,
        loadingLocation,
        errorMsg,
        requestLocationPermission,
        refreshLocation,
        calculateDistanceKm,
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
