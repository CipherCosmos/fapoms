import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MapLayerControls } from './MapLayerControls';

interface MapBranch {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
}

interface InteractivePlanningMapProps {
  branches: MapBranch[];
  selectedBranchId: string | null;
  onSelectBranch: (id: string) => void;
  routePoints?: { latitude: number; longitude: number }[];
}

export const InteractivePlanningMap: React.FC<InteractivePlanningMapProps> = ({
  branches,
  selectedBranchId,
  onSelectBranch,
  routePoints,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});
  const circlesRef = useRef<L.Circle[]>([]);
  const polylineRef = useRef<L.Polyline | null>(null);

  // GIP Layer state configuration
  const [showBranches, setShowBranches] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  
  // Phase 4 Analytics Layers states
  const [showSlaRisk, setShowSlaRisk] = useState(false);
  const [showWorkforceDensity, setShowWorkforceDensity] = useState(false);
  const [showRevenueDensity, setShowRevenueDensity] = useState(false);

  // Real Assayers coordinates list loaded from API
  const [realAssayers, setRealAssayers] = useState<any[]>([]);

  useEffect(() => {
    if (showWorkforceDensity) {
      fetch('/api/v1/assayers?limit=100', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        }
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setRealAssayers(data.data);
        }
      })
      .catch(err => console.error("Failed to load assayers for density overlay", err));
    } else {
      setRealAssayers([]);
    }
  }, [showWorkforceDensity]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Initialize map if it doesn't exist
    if (!mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapContainerRef.current).setView([20.5937, 78.9629], 5); // Center on India coordinates

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(mapInstanceRef.current);
    }

    const map = mapInstanceRef.current;

    // Clear old markers
    Object.values(markersRef.current).forEach((marker) => marker.remove());
    markersRef.current = {};

    // Clear old circles
    circlesRef.current.forEach((circle) => circle.remove());
    circlesRef.current = [];

    // Clear old polyline
    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }

    const bounds: L.LatLngTuple[] = [];

    // Layer 1: Branches
    if (showBranches) {
      branches.forEach((b) => {
        if (b.latitude !== null && b.longitude !== null) {
          const lat = Number(b.latitude);
          const lng = Number(b.longitude);

          const isSelected = b.id === selectedBranchId;
          const color = isSelected
            ? '#6366f1' // Selected Indigo
            : b.status === 'ASSIGNMENT_CONFIRMED' || b.status === 'SCHEDULED'
            ? '#10b981' // Green
            : '#f59e0b'; // Amber

          const markerSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" width="28px" height="28px" style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3));">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
          `;

          const customIcon = L.divIcon({
            html: markerSvg,
            className: 'custom-leaflet-marker',
            iconSize: [28, 28],
            iconAnchor: [14, 28],
          });

          const marker = L.marker([lat, lng], { icon: customIcon })
            .addTo(map)
            .bindPopup(`<b>${b.name}</b><br/>Status: ${b.status.replace(/_/g, ' ')}`)
            .on('click', () => {
              onSelectBranch(b.id);
            });

          markersRef.current[b.id] = marker;
          bounds.push([lat, lng]);

          if (isSelected) {
            marker.openPopup();
          }

          // GIP Phase 4 Analytics Layer: SLA Risk Overlay (draw warning circle around pending branches)
          if (showSlaRisk && b.status === 'PLANNING') {
            const riskCircle = L.circle([lat, lng], {
              radius: 40000, // 40km risk buffer zone
              color: '#ef4444',
              fillColor: '#ef4444',
              fillOpacity: 0.15,
              weight: 1
            }).addTo(map);
            circlesRef.current.push(riskCircle);
          }

          // GIP Phase 4 Analytics Layer: Revenue Density Heat (draw gold circles around completed sites)
          if (showRevenueDensity && (b.status === 'CLOSED' || b.status === 'AUDIT_COMPLETED')) {
            const revenueCircle = L.circle([lat, lng], {
              radius: 35000,
              color: '#f59e0b',
              fillColor: '#f59e0b',
              fillOpacity: 0.2,
              weight: 1
            }).addTo(map);
            circlesRef.current.push(revenueCircle);
          }
        }
      });
    }

    // GIP Phase 4 Analytics Layer: Workforce Density (drawing real assayers home bases)
    if (showWorkforceDensity && realAssayers.length > 0) {
      realAssayers.forEach((assayer) => {
        if (assayer.latitude !== null && assayer.longitude !== null) {
          const lat = Number(assayer.latitude);
          const lng = Number(assayer.longitude);
          const densityCircle = L.circle([lat, lng], {
            radius: 50000, // 50km density zone around auditor home base
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 0.15,
            weight: 1
          }).addTo(map);
          circlesRef.current.push(densityCircle);
        }
      });
    }

    // Layer 2: Routes
    if (showRoutes && routePoints && routePoints.length > 1) {
      const latLngs = routePoints.map((p) => [p.latitude, p.longitude] as L.LatLngTuple);
      polylineRef.current = L.polyline(latLngs, {
        color: '#6366f1',
        weight: 4,
        opacity: 0.8,
        dashArray: '5, 10',
      }).addTo(map);

      if (bounds.length === 0) {
        latLngs.forEach((coord) => bounds.push(coord));
      }
    }

    // Zoom map to cover bounds automatically
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }, [branches, selectedBranchId, routePoints, showBranches, showRoutes, showSlaRisk, showWorkforceDensity, showRevenueDensity, realAssayers]);

  // Center on selected branch
  useEffect(() => {
    if (!mapInstanceRef.current || !selectedBranchId) return;

    const marker = markersRef.current[selectedBranchId];
    if (marker && showBranches) {
      const latLng = marker.getLatLng();
      mapInstanceRef.current.setView(latLng, 12, { animate: true });
      marker.openPopup();
    }
  }, [selectedBranchId, showBranches]);

  return (
    <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ fontSize: '15px', fontWeight: 600 }}>Geographic Workspace Map</h4>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Interactive coordinates tracking</span>
      </div>
      <div 
        ref={mapContainerRef} 
        style={{ 
          height: '260px', 
          width: '100%', 
          borderRadius: 'var(--radius-md)', 
          border: '1px solid var(--border-color)',
          background: 'var(--bg-primary)',
          zIndex: 1
        }} 
      />
      <MapLayerControls 
        showBranches={showBranches}
        setShowBranches={setShowBranches}
        showRoutes={showRoutes}
        setShowRoutes={setShowRoutes}
        showSlaRisk={showSlaRisk}
        setShowSlaRisk={setShowSlaRisk}
        showWorkforceDensity={showWorkforceDensity}
        setShowWorkforceDensity={setShowWorkforceDensity}
        showRevenueDensity={showRevenueDensity}
        setShowRevenueDensity={setShowRevenueDensity}
      />
    </div>
  );
};
