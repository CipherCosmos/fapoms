import React, { useEffect, useRef } from 'react';
import { View, Text } from 'react-native';
import { Icon } from './ui/primitives';

// Web implementation of the in-app map. Uses Leaflet + OpenStreetMap tiles with an
// optional OSRM route polyline. Kept free with no API key. Native uses react-native-maps.
export interface MapRenderProps {
  origin?: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  routeCoords: Array<{ latitude: number; longitude: number }>;
  showTraffic?: boolean;
  fitKey: number;
  // Live navigation extras (native follow-camera uses these; web ignores them).
  heading?: number;
  follow?: boolean;
  passedIndex?: number;
}

export const InteractiveMapWeb: React.FC<MapRenderProps> = ({ origin, destination, routeCoords, fitKey, passedIndex }) => {
  const containerRef = useRef<any>(null);
  const mapRef = useRef<any>(null);
  const routeRef = useRef<any>(null);
  const routePassedRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  useEffect(() => {
    const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
    if (g.document && !g.document.getElementById('leaflet-css')) {
      const link = g.document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      g.document.head.appendChild(link);
    }

    if (!containerRef.current) return;
    const domNode = containerRef.current as unknown as HTMLElement;

    let cancelled = false;
    const initMap = async () => {
      const L = await import('leaflet');
      leafletRef.current = L;
      if (cancelled) return;

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const map = L.map(domNode, {
        center: [destination.latitude, destination.longitude],
        zoom: 13,
        zoomControl: true,
        attributionControl: false,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(map);

      const destIcon = L.divIcon({
        html: '<div style="width:26px;height:26px;background:#ef4444;border:3px solid #fca5a5;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });

      const youIcon = L.divIcon({
        html: '<div style="width:20px;height:20px;background:#3b82f6;border:3px solid #93c5fd;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });

      L.marker([destination.latitude, destination.longitude], { icon: destIcon }).addTo(map);
      if (origin) {
        L.marker([origin.latitude, origin.longitude], { icon: youIcon }).addTo(map);
      }

      mapRef.current = map;
      routeRef.current = null;
      routePassedRef.current = null;

      const bounds: [number, number][] = [[destination.latitude, destination.longitude]];
      if (origin) bounds.push([origin.latitude, origin.longitude]);
      if (bounds.length > 1) {
        setTimeout(() => map.fitBounds(bounds, { padding: [50, 60] }), 150);
      }

      setTimeout(() => map.invalidateSize(), 200);
    };

    initMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [destination.latitude, destination.longitude, origin?.latitude, origin?.longitude]);

  // Draw the route polyline whenever it changes, tinting the travelled part.
  useEffect(() => {
    const map = mapRef.current;
    const L: any = leafletRef.current;
    if (!map || !L || routeCoords.length < 2) return;
    const latlngs = routeCoords.map((c) => [c.latitude, c.longitude] as [number, number]);
    if (routeRef.current) {
      routeRef.current.setLatLngs(latlngs);
    } else {
      routeRef.current = L.polyline(latlngs, { color: '#2563eb', weight: 5, opacity: 0.9 }).addTo(map);
    }
    setTimeout(() => {
      if (latlngs.length > 1) map.fitBounds(latlngs, { padding: [50, 60] });
    }, 150);
  }, [routeCoords, fitKey]);

  // Travelled part of the route, drawn as a thinner grey overlay.
  useEffect(() => {
    const map = mapRef.current;
    const L: any = leafletRef.current;
    if (!map || !L || routeCoords.length < 2 || passedIndex == null || passedIndex < 1) return;
    const latlngs = routeCoords
      .slice(0, passedIndex + 1)
      .map((c) => [c.latitude, c.longitude] as [number, number]);
    if (!latlngs.length) return;
    if (routePassedRef.current) {
      routePassedRef.current.setLatLngs(latlngs);
    } else {
      routePassedRef.current = L.polyline(latlngs, { color: '#64748b', weight: 5, opacity: 0.85 }).addTo(map);
    }
  }, [routeCoords, passedIndex]);

  return (
    <View style={{ position: 'relative', flex: 1, overflow: 'hidden', backgroundColor: '#0f172a' }}>
      <View ref={containerRef} style={{ width: '100%', height: '100%' }} />
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
          zIndex: 1000,
        }}
      >
        <Icon name="navigate" size={12} color="#38bdf8" />
        <Text style={{ fontSize: 10, color: '#94a3b8' }}>OpenStreetMap</Text>
      </View>
    </View>
  );
};
