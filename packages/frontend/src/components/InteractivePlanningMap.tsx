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
  fillContainer?: boolean;
  selectedAssayerFromParent?: any | null;
}

// Haversine straight-line distance helper for fast checks
const calculateHaversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

export const InteractivePlanningMap: React.FC<InteractivePlanningMapProps> = ({
  branches,
  selectedBranchId,
  onSelectBranch,
  routePoints,
  fillContainer,
  selectedAssayerFromParent,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});
  const circlesRef = useRef<L.Circle[]>([]);
  const polylineRef = useRef<L.Polyline | null>(null);
  const activeRoutePolylineRef = useRef<L.Polyline | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  // GIP Layer state configuration
  const [showBranches, setShowBranches] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  
  // Phase 4 Analytics Layers states
  const [showSlaRisk, setShowSlaRisk] = useState(false);
  const [showWorkforceDensity, setShowWorkforceDensity] = useState(false);
  const [showRevenueDensity, setShowRevenueDensity] = useState(false);

  // Basemap selection state
  const [useGoogleMap, setUseGoogleMap] = useState(false);

  // Radius search filter config
  const [radiusKm, setRadiusKm] = useState<number>(300);

  // Real-time routing overlay states
  const [selectedAssayerForRouting, setSelectedAssayerForRouting] = useState<any | null>(null);
  const [travelMode, setTravelMode] = useState<'driving' | 'two-wheeler' | 'transit' | 'walking'>('driving');
  const [roadDistanceKm, setRoadDistanceKm] = useState<number | null>(null);
  const [roadDurationMinutes, setRoadDurationMinutes] = useState<number | null>(null);
  const [roadGeometry, setRoadGeometry] = useState<L.LatLngExpression[]>([]);

  // Real Assayers coordinates list loaded from API
  const [realAssayers, setRealAssayers] = useState<any[]>([]);

  // Synchronize parent selected assayer to map routing state
  useEffect(() => {
    if (selectedAssayerFromParent && selectedBranchId) {
      const selectedBranch = branches.find(b => b.id === selectedBranchId);
      if (selectedBranch && selectedBranch.latitude !== null && selectedBranch.longitude !== null) {
        setSelectedAssayerForRouting({
          ...selectedAssayerFromParent,
          straightDistance: selectedAssayerFromParent.distanceKm || calculateHaversineDistance(
            Number(selectedAssayerFromParent.latitude), Number(selectedAssayerFromParent.longitude),
            Number(selectedBranch.latitude), Number(selectedBranch.longitude)
          ),
          aLat: Number(selectedAssayerFromParent.latitude),
          aLng: Number(selectedAssayerFromParent.longitude),
          bLat: Number(selectedBranch.latitude),
          bLng: Number(selectedBranch.longitude),
          branchName: selectedBranch.name
        });
      }
    } else {
      setSelectedAssayerForRouting(null);
    }
  }, [selectedAssayerFromParent, selectedBranchId, branches]);

  // Fetch assayers on mount
  useEffect(() => {
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
    .catch(err => console.error("Failed to load assayers", err));
  }, []);

  // Fetch real-time OSRM driving route when an assayer is clicked
  useEffect(() => {
    if (!selectedAssayerForRouting) {
      setRoadDistanceKm(null);
      setRoadDurationMinutes(null);
      setRoadGeometry([]);
      return;
    }

    const { aLat, aLng, bLat, bLng } = selectedAssayerForRouting;
    
    // Map OSRM profile based on mode
    const osrmProfile = travelMode === 'walking' ? 'foot' : 'driving';
    const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${aLng},${aLat};${bLng},${bLat}?overview=full&geometries=geojson`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.code === 'Ok' && data.routes?.[0]) {
          const route = data.routes[0];
          setRoadDistanceKm(route.distance / 1000);
          setRoadDurationMinutes(route.duration / 60);
          if (route.geometry?.coordinates) {
            const coords = route.geometry.coordinates.map((pt: any) => [pt[1], pt[0]] as L.LatLngExpression);
            setRoadGeometry(coords);
          }
        } else {
          // Fallback to straight-line line on failure
          setRoadDistanceKm(selectedAssayerForRouting.straightDistance);
          setRoadDurationMinutes((selectedAssayerForRouting.straightDistance / 40) * 60);
          setRoadGeometry([[aLat, aLng], [bLat, bLng]]);
        }
      })
      .catch(err => {
        console.error("OSRM Route fetch error", err);
        setRoadDistanceKm(selectedAssayerForRouting.straightDistance);
        setRoadDurationMinutes((selectedAssayerForRouting.straightDistance / 40) * 60);
        setRoadGeometry([[aLat, aLng], [bLat, bLng]]);
      });
  }, [selectedAssayerForRouting, travelMode]);

  // Reset routing if selected branch changes
  useEffect(() => {
    setSelectedAssayerForRouting(null);
  }, [selectedBranchId]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Initialize map if it doesn't exist
    if (!mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapContainerRef.current).setView([20.5937, 78.9629], 5); // Center on India coordinates
    }

    const map = mapInstanceRef.current;

    // Swap tile layers dynamically between OpenStreetMap and Google Satellite Hybrid
    if (tileLayerRef.current) {
      tileLayerRef.current.remove();
    }

    const tileUrl = useGoogleMap 
      ? 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}' // Google Hybrid Satellite
      : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; // OpenStreetMap

    tileLayerRef.current = L.tileLayer(tileUrl, {
      subdomains: useGoogleMap ? ['mt0', 'mt1', 'mt2', 'mt3'] : ['a', 'b', 'c'],
      attribution: useGoogleMap ? '&copy; Google Maps' : '&copy; OpenStreetMap contributors',
    }).addTo(map);

    // Clear old markers
    Object.values(markersRef.current).forEach((marker) => marker.remove());
    markersRef.current = {};

    // Clear old circles
    circlesRef.current.forEach((circle) => circle.remove());
    circlesRef.current = [];

    // Clear old polylines
    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }
    if (activeRoutePolylineRef.current) {
      activeRoutePolylineRef.current.remove();
      activeRoutePolylineRef.current = null;
    }

    const bounds: L.LatLngTuple[] = [];

    // Find selected branch latlng coordinates
    const selectedBranch = branches.find(b => b.id === selectedBranchId);
    let selectedBranchLatLng: [number, number] | null = null;
    if (selectedBranch && selectedBranch.latitude !== null && selectedBranch.longitude !== null) {
      selectedBranchLatLng = [Number(selectedBranch.latitude), Number(selectedBranch.longitude)];
    }

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
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" width="28px" height="28px" style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.4));">
              <!-- A Classical Bank / Office Icon -->
              <path d="M12 2L2 7v2h20V7L12 2zm-7 8v8h3v-8H5zm5 0v8h4v-8h-4zm7 0v8h3v-8h-3zM2 20v2h20v-2H2z"/>
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
            .on('click', () => {
              onSelectBranch(b.id);
            });

          markersRef.current[b.id] = marker;
          bounds.push([lat, lng]);

          // GIP Phase 4 Analytics Layer: SLA Risk Overlay
          if (showSlaRisk && b.status === 'PLANNING') {
            const riskCircle = L.circle([lat, lng], {
              radius: 40000,
              color: '#ef4444',
              fillColor: '#ef4444',
              fillOpacity: 0.15,
              weight: 1
            }).addTo(map);
            circlesRef.current.push(riskCircle);
          }

          // GIP Phase 4 Analytics Layer: Revenue Density Heat
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

    // Branch Proximity Search Radius Circle and Assayer Markers
    if (selectedBranchLatLng) {
      // 1. Draw search radius circle
      const searchCircle = L.circle(selectedBranchLatLng, {
        radius: radiusKm * 1000,
        color: '#8b5cf6',
        fillColor: '#8b5cf6',
        fillOpacity: 0.05,
        weight: 1,
        dashArray: '4, 6'
      }).addTo(map);
      circlesRef.current.push(searchCircle);

      // 2. Render assayers within straight-line radius
      realAssayers.forEach((assayer) => {
        if (assayer.latitude !== null && assayer.longitude !== null) {
          const aLat = Number(assayer.latitude);
          const aLng = Number(assayer.longitude);
          const straightDist = calculateHaversineDistance(selectedBranchLatLng![0], selectedBranchLatLng![1], aLat, aLng);

          if (straightDist <= radiusKm) {
            const assayerSvg = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#a855f7" width="26px" height="26px" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));">
                <!-- Auditor User Avatar -->
                <circle cx="12" cy="12" r="10" fill="none" stroke="#a855f7" stroke-width="2"/>
                <path d="M12 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V18h14v-1.5c0-2.33-4.67-3.5-7-3.5z"/>
              </svg>
            `;

            const assayerIcon = L.divIcon({
              html: assayerSvg,
              className: 'custom-assayer-marker',
              iconSize: [24, 24],
              iconAnchor: [12, 24],
            });

            const assayerMarker = L.marker([aLat, aLng], { icon: assayerIcon })
              .addTo(map)
              .on('click', () => {
                setSelectedAssayerForRouting({
                  ...assayer,
                  straightDistance: straightDist,
                  aLat,
                  aLng,
                  bLat: selectedBranchLatLng![0],
                  bLng: selectedBranchLatLng![1],
                  branchName: selectedBranch?.name || 'Target Branch'
                });
              });

            markersRef.current[`assayer-${assayer.id}`] = assayerMarker;
          }
        }
      });
    }

    // GIP Phase 4 Analytics Layer: Workforce Density
    if (showWorkforceDensity && realAssayers.length > 0 && !selectedBranchLatLng) {
      realAssayers.forEach((assayer) => {
        if (assayer.latitude !== null && assayer.longitude !== null) {
          const lat = Number(assayer.latitude);
          const lng = Number(assayer.longitude);
          const densityCircle = L.circle([lat, lng], {
            radius: 50000,
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 0.15,
            weight: 1
          }).addTo(map);
          circlesRef.current.push(densityCircle);
        }
      });
    }

    // Active Assayer Route Line Overlay (Draw actual OSRM road geometry)
    if (selectedAssayerForRouting && roadGeometry.length > 0) {
      const modeColors = {
        driving: '#3b82f6',
        'two-wheeler': '#a855f7',
        transit: '#f97316',
        walking: '#10b981'
      };

      activeRoutePolylineRef.current = L.polyline(
        roadGeometry,
        {
          color: modeColors[travelMode],
          weight: 6,
          opacity: 0.9,
          dashArray: travelMode === 'walking' ? '3, 6' : '0'
        }
      ).addTo(map);

      // Fit map to show the entire road route
      map.fitBounds(activeRoutePolylineRef.current.getBounds(), { padding: [40, 40] });
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

    // Zoom map to cover bounds automatically, or zoom to selected branch
    if (bounds.length > 0 && !selectedAssayerForRouting) {
      if (selectedBranchId && selectedBranchLatLng) {
        map.setView(selectedBranchLatLng, 12, { animate: true });
      } else {
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    }
  }, [branches, selectedBranchId, routePoints, showBranches, showRoutes, showSlaRisk, showWorkforceDensity, showRevenueDensity, realAssayers, radiusKm, selectedAssayerForRouting, roadGeometry, travelMode, useGoogleMap]);

  // Travel math calculations based on OSRM real road distance
  const actualDistance = roadDistanceKm !== null ? roadDistanceKm : (selectedAssayerForRouting?.straightDistance || 0);
  const costModes = { driving: 8, 'two-wheeler': 3, transit: 1.5, walking: 0 };
  const trafficDelays = { driving: 6, 'two-wheeler': 2, transit: 0, walking: 0 };

  const durationVal = roadDurationMinutes !== null 
    ? Math.round(roadDurationMinutes) 
    : Math.round((actualDistance / 40) * 60);

  const estCost = Math.round(actualDistance * costModes[travelMode]);

  return (
    <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', position: 'relative', flex: fillContainer ? '1' : undefined, minHeight: fillContainer ? 0 : '380px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ fontSize: '15px', fontWeight: 600 }}>Geographic Workspace Map</h4>
      </div>
      
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div 
          ref={mapContainerRef} 
          style={{ 
            height: '100%',
            width: '100%', 
            borderRadius: 'var(--radius-md)', 
            border: '1px solid var(--border-color)',
            background: 'var(--bg-primary)',
            zIndex: 1
          }} 
        />

        {/* Floating Proximity Radius Control Widget */}
        <div style={{
          position: 'absolute',
          top: '10px',
          left: '50px',
          zIndex: 1000,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '11px',
          color: '#fff'
        }}>
          <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Radius:</span>
          <input 
            type="number" 
            value={radiusKm} 
            onChange={(e) => setRadiusKm(Math.max(1, Number(e.target.value)))}
            style={{ width: '40px', padding: '2px 4px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-xs)', color: '#fff', outline: 'none', textAlign: 'center', fontSize: '11px' }} 
          />
          <span style={{ color: 'var(--text-muted)' }}>km</span>
        </div>

      {/* Floating Route Intelligence Panel */}
      {selectedAssayerForRouting && (
        <div style={{
          position: 'absolute',
          top: '55px',
          left: '25px',
          width: '260px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          padding: '12px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <b style={{ color: '#a855f7', fontSize: '13px' }}>{selectedAssayerForRouting.firstName} {selectedAssayerForRouting.lastName}</b>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Route to {selectedAssayerForRouting.branchName}</div>
            </div>
            <button onClick={() => setSelectedAssayerForRouting(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>&times;</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-sm)' }}>
            {(['driving', 'two-wheeler', 'transit', 'walking'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setTravelMode(mode)}
                style={{
                  padding: '4px',
                  background: travelMode === mode ? 'rgba(139, 92, 246, 0.2)' : 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  color: travelMode === mode ? '#fff' : 'var(--text-secondary)',
                  fontSize: '11px',
                  cursor: 'pointer',
                  textAlign: 'center'
                }}
              >
                {mode === 'driving' ? '🚗' : mode === 'two-wheeler' ? '🏍️' : mode === 'transit' ? '🚆' : '🚶'}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Road Distance:</span>
              <b>{actualDistance.toFixed(1)} km</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Est. Duration:</span>
              <b>{durationVal} mins</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Traffic Delay:</span>
              <b style={{ color: trafficDelays[travelMode] > 3 ? '#ef4444' : 'var(--status-active)' }}>
                {trafficDelays[travelMode] > 0 && travelMode !== 'transit' && travelMode !== 'walking' ? `+${trafficDelays[travelMode]} mins` : 'None'}
              </b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px', marginTop: '4px' }}>
              <span>Est. Travel Cost:</span>
              <b style={{ color: '#fff', fontSize: '12px' }}>₹{estCost}</b>
            </div>
          </div>
        </div>
      )}

      <MapLayerControls 
        showBranches={showBranches} setShowBranches={setShowBranches}
        showRoutes={showRoutes} setShowRoutes={setShowRoutes}
        showSlaRisk={showSlaRisk} setShowSlaRisk={setShowSlaRisk}
        showWorkforceDensity={showWorkforceDensity} setShowWorkforceDensity={setShowWorkforceDensity}
        showRevenueDensity={showRevenueDensity} setShowRevenueDensity={setShowRevenueDensity}
        useGoogleMap={useGoogleMap} setUseGoogleMap={setUseGoogleMap}
      />
      </div>
    </div>
  );
};
