import React, { useEffect, useRef } from 'react';
import { View, Text, Platform } from 'react-native';
import Constants from 'expo-constants';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Icon } from './ui/primitives';
import { useTheme } from '../theme/ThemeProvider';
import { MapRenderProps } from './MapWeb';

// Native (Android/iOS) implementation of the in-app map.
// Android: Google Maps provider with live traffic layer + follow-camera nav.
// iOS: Apple Maps provider (free) with live traffic layer.
const IS_ANDROID = Platform.OS === 'android';

/**
 * Whether this build actually carries a Google Maps key.
 *
 * `app.config.js` fills both of these from `GOOGLE_MAPS_API_KEY`, and when that variable is
 * empty — which it is in this deployment — the key becomes `''` and prebuild writes no usable
 * `com.google.android.geo.API_KEY` into the manifest at all. Confirmed by dumping the manifest
 * out of the built APK: the meta-data entry is simply absent.
 *
 * Mounting `PROVIDER_GOOGLE` in that state does not degrade. `react-native-maps` fails to create
 * the native map view, and it takes the Activity with it — so the map screen becomes a crash
 * rather than a missing feature, and the assayer loses the app mid-journey.
 *
 * An empty string is not a key: `.trim()` before deciding, because `''` and `'   '` both arrive
 * from an unset variable and both look truthy to a careless check.
 */
const GOOGLE_MAPS_KEY: string = (
  (Constants.expoConfig as any)?.android?.config?.googleMaps?.apiKey
  || (Constants.expoConfig as any)?.extra?.googleMapsApiKey
  || ''
).trim();

/** Google Maps is only required on Android; iOS renders through Apple Maps, which needs no key. */
const CAN_RENDER_MAP = !IS_ANDROID || GOOGLE_MAPS_KEY.length > 0;
const MapViewComponent = MapView as unknown as React.ComponentType<any>;
const MarkerComponent = Marker as unknown as React.ComponentType<any>;
const PolylineComponent = Polyline as unknown as React.ComponentType<any>;

export const InteractiveMapNative: React.FC<MapRenderProps> = ({
  origin,
  destination,
  routeCoords,
  showTraffic = true,
  fitKey,
  heading,
  follow,
  passedIndex,
}) => {
  const t = useTheme();
  const mapRef = useRef<any>(null);

  // Fit the full route when not following.
  useEffect(() => {
    if (follow) return;
    if (!mapRef.current) return;
    const pts: Array<{ latitude: number; longitude: number }> = [];
    if (origin) pts.push(origin);
    if (routeCoords.length >= 2) pts.push(...routeCoords);
    pts.push(destination);
    if (pts.length >= 2) {
      setTimeout(() => {
        mapRef.current?.fitToCoordinates?.(pts, { edgePadding: { top: 90, right: 50, bottom: 190, left: 50 }, animated: true });
      }, 300);
    }
  }, [origin, routeCoords, destination, fitKey, follow]);

  // Follow-camera: keep the user centered and rotated to travel heading during
  // live turn-by-turn navigation (native only).
  useEffect(() => {
    if (!follow || !origin || !mapRef.current) return;
    mapRef.current.animateCamera?.(
      {
        center: { latitude: origin.latitude, longitude: origin.longitude },
        heading: heading ?? 0,
        pitch: 45,
        zoom: 17,
      },
      { duration: 1500 },
    );
  }, [follow, origin, heading]);

  const passed = passedIndex != null && passedIndex >= 1 ? Math.min(passedIndex, routeCoords.length - 1) : -1;
  const travelled = passed >= 1 ? routeCoords.slice(0, passed + 1) : [];
  const upcoming = passed >= 0 ? routeCoords.slice(passed + 1) : routeCoords;

  /**
   * No key — say so, and keep the screen useful.
   *
   * The destination coordinates are the part an assayer can still act on: they can be read out,
   * or pasted into whatever maps app is already on the handset. Losing the embedded map is an
   * inconvenience; losing the Activity is the end of the journey.
   */
  if (!CAN_RENDER_MAP) {
    // Theme tokens, not the hand-picked slate hexes this panel used before — a fallback screen
    // still needs to obey light/dark like the rest of the app, and its own literal colors meant
    // it stayed dark-only regardless of the user's theme.
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: 24,
          backgroundColor: t.colors.bg,
        }}
      >
        <Icon name="map-outline" size={28} color={t.colors.textFaint} />
        <Text style={{ color: t.colors.text, fontSize: 15, fontWeight: '700', textAlign: 'center' }}>
          Map unavailable in this build
        </Text>
        <Text style={{ color: t.colors.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'center' }}>
          This app was built without a Google Maps key, so the map cannot be shown. Everything else
          works — including check-in.
        </Text>
        <Text style={{ color: t.colors.textFaint, fontSize: 12, marginTop: 6 }} selectable>
          Destination: {destination.latitude.toFixed(5)}, {destination.longitude.toFixed(5)}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <MapViewComponent
        ref={mapRef}
        style={{ flex: 1 }}
        provider={IS_ANDROID ? PROVIDER_GOOGLE : undefined}
        showsTraffic={showTraffic}
        showsUserLocation
        showsMyLocationButton
        showsCompass
        loadingEnabled
        loadingBackgroundColor="#090d16"
        loadingIndicatorColor="#2563eb"
        initialRegion={{
          latitude: destination.latitude,
          longitude: destination.longitude,
          latitudeDelta: 0.08,
          longitudeDelta: 0.08,
        }}
      >
        {origin && <MarkerComponent coordinate={origin} title="You" pinColor="#3b82f6" />}
        <MarkerComponent coordinate={destination} title="Destination" pinColor="#ef4444" />
        {routeCoords.length >= 2 && !follow && (
          <PolylineComponent coordinates={routeCoords} strokeColor="#2563eb" strokeWidth={5} />
        )}
        {travelled.length >= 2 && (
          <PolylineComponent coordinates={travelled} strokeColor="#64748b" strokeWidth={5} />
        )}
        {upcoming.length >= 2 && (
          <PolylineComponent coordinates={upcoming} strokeColor="#2563eb" strokeWidth={5} />
        )}
      </MapViewComponent>
      {/* Fixed dark chip, not theme tokens — it sits over live map/satellite imagery whose
          brightness doesn't follow the app's light/dark setting, so a token-driven light-mode
          background would go unreadable against a bright map tile underneath it. */}
      <View
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          backgroundColor: 'rgba(15,23,42,0.85)',
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Icon name="navigate" size={12} color="#38bdf8" />
        <Text style={{ fontSize: 10, color: '#94a3b8' }}>Live traffic</Text>
      </View>
    </View>
  );
};