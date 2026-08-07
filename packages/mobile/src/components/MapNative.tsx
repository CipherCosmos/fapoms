import React, { useEffect, useRef } from 'react';
import { View, Text, Platform } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Icon } from './ui/primitives';
import { MapRenderProps } from './MapWeb';

// Native (Android/iOS) implementation of the in-app map.
// Android: Google Maps provider with live traffic layer + follow-camera nav.
// iOS: Apple Maps provider (free) with live traffic layer.
const IS_ANDROID = Platform.OS === 'android';
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