import React, { useEffect, useRef } from 'react';
import L from 'leaflet';

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
}

export const InteractivePlanningMap: React.FC<InteractivePlanningMapProps> = ({
  branches,
  selectedBranchId,
  onSelectBranch,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});

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

    // Collect valid coordinate points to calculate zoom bounds
    const bounds: L.LatLngTuple[] = [];

    branches.forEach((b) => {
      if (b.latitude !== null && b.longitude !== null) {
        const lat = Number(b.latitude);
        const lng = Number(b.longitude);

        // Styling based on branch planning status
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

        // Auto open popup for currently selected branch
        if (isSelected) {
          marker.openPopup();
        }
      }
    });

    // Zoom map to cover all branches automatically
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }, [branches, selectedBranchId]);

  // Center on selected branch
  useEffect(() => {
    if (!mapInstanceRef.current || !selectedBranchId) return;

    const marker = markersRef.current[selectedBranchId];
    if (marker) {
      const latLng = marker.getLatLng();
      mapInstanceRef.current.setView(latLng, 12, { animate: true });
      marker.openPopup();
    }
  }, [selectedBranchId]);

  return (
    <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
    </div>
  );
};
