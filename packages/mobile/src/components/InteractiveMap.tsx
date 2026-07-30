import React, { useEffect, useRef } from 'react';
import { View, Text, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface InteractiveMapProps {
  latitude: number;
  longitude: number;
  radiusKm: number;
  onLocationChange: (lat: number, lng: number) => void;
  onRadiusChange: (km: number) => void;
}

export const InteractiveMap: React.FC<InteractiveMapProps> = ({
  latitude,
  longitude,
  radiusKm,
  onLocationChange,
  onRadiusChange,
}) => {
  const mapRef = useRef<any>(null);
  const containerRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const circleRef = useRef<any>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

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
    if (!domNode) return;

    const initMap = async () => {
      const L = await import('leaflet');

      if (mapRef.current) {
        mapRef.current.remove();
      }

      const map = L.map(domNode, {
        center: [latitude, longitude],
        zoom: 12,
        zoomControl: true,
        attributionControl: false,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
      }).addTo(map);

      const markerIcon = L.divIcon({
        html: '<div style="width:24px;height:24px;background:#6366f1;border:3px solid #818cf8;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const marker = L.marker([latitude, longitude], {
        draggable: true,
        icon: markerIcon,
      }).addTo(map);

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onLocationChange(parseFloat(pos.lat.toFixed(7)), parseFloat(pos.lng.toFixed(7)));
      });

      const circle = L.circle([latitude, longitude], {
        radius: radiusKm * 1000,
        color: '#6366f1',
        fillColor: '#6366f1',
        fillOpacity: 0.1,
        weight: 2,
        dashArray: '8 4',
      }).addTo(map);

      map.on('zoomend', () => {
        const zoom = map.getZoom();
        circle.setStyle({ weight: zoom > 14 ? 3 : 2 });
      });

      mapRef.current = map;
      markerRef.current = marker;
      circleRef.current = circle;

      setTimeout(() => map.invalidateSize(), 200);
    };

    initMap();

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (markerRef.current && circleRef.current && mapRef.current) {
      markerRef.current.setLatLng([latitude, longitude]);
      circleRef.current.setLatLng([latitude, longitude]);
      mapRef.current.setView([latitude, longitude], mapRef.current.getZoom());
    }
  }, [latitude, longitude]);

  useEffect(() => {
    if (circleRef.current) {
      circleRef.current.setRadius(radiusKm * 1000);
    }
  }, [radiusKm]);

  return Platform.OS === 'web' ? (
    <View style={{ position: 'relative', height: 220, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0f172a' }}>
      <View ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <View style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(15,23,42,0.85)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 }}>
        <Text style={{ fontSize: 10, color: '#94a3b8' }}>Drag pin • Zoom with scroll • {radiusKm}km radius</Text>
      </View>
    </View>
  ) : (
    <View style={{ position: 'relative', height: 220, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0f172a' }}>
      <View style={{ flex: 1, padding: 16, justifyContent: 'center', alignItems: 'center' }}>
        <Ionicons name="location" size={32} color="#38bdf8" style={{ marginBottom: 6 }} />
        <Text style={{ color: '#38bdf8', fontSize: 14, fontWeight: '700' }}>GPS Coordinates: {latitude.toFixed(4)}, {longitude.toFixed(4)}</Text>
        <Text style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>Coverage Radius: {radiusKm} km</Text>
      </View>
      <View style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(15,23,42,0.85)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 }}>
        <Text style={{ fontSize: 10, color: '#94a3b8' }}>GPS Marker • {radiusKm}km radius</Text>
      </View>
    </View>
  );
};
