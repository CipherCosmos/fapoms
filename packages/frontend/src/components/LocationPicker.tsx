import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MapPin, Navigation } from 'lucide-react';
import { STREET_TILE_OPTIONS, STREET_TILE_URL } from './geo/basemap';

// ─────────────────────────────────────────────────────────────────────────────
// A lightweight, optional map picker for the registration page.
//
// The candidate can pin their home location to help us derive precise
// coordinates. If they skip it, the system will geocode from their address
// and pincode as before. This is entirely optional — the label and collapse
// state make that clear.
// ─────────────────────────────────────────────────────────────────────────────

/** Fix Leaflet's default icon path in Vite / bundled environments. */
const MARKER_ICON = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

/**
 * Whether a coordinate can be a place in India — the same box the phone app checks
 * (`isPlausibleIndianCoord` in mobile's `MapPicker`), so a pin the phone would refuse is refused
 * here too. A pin dropped in the sea off Chennai or a stray tap on the world view is caught with a
 * sentence, instead of being saved as somebody's home and quietly dropped by the server later.
 */
export function isPlausibleIndianCoord(latitude?: number | null, longitude?: number | null): boolean {
  if (latitude == null || longitude == null) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  return latitude >= 6.4 && latitude <= 37.7 && longitude >= 68.0 && longitude <= 97.5;
}

const PIN_OUTSIDE_INDIA = 'That point is outside India. Move the pin to your home address.';
const FIX_OUTSIDE_INDIA = 'Your device reported a place outside India. Tap the map to place the pin instead.';

/** Default center — geographic center of India. */
const INDIA_CENTER: L.LatLngTuple = [22.5, 82.0];
const DEFAULT_ZOOM = 5;
const PIN_ZOOM = 14;

interface LocationPickerProps {
  /** Saved latitude, or null if unset. */
  latitude: number | null;
  /** Saved longitude, or null if unset. */
  longitude: number | null;
  /** Called when the user drops a pin or clears it. */
  onChange: (lat: number | null, lng: number | null) => void;
}

export const LocationPicker: React.FC<LocationPickerProps> = ({ latitude, longitude, onChange }) => {
  const [expanded, setExpanded] = useState(latitude != null && longitude != null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const [geoStatus, setGeoStatus] = useState<'idle' | 'finding' | 'denied' | 'unavailable'>('idle');
  const [pinError, setPinError] = useState<string | null>(null);
  /** The last accepted pin, so a refused drag can put the marker back where it was. */
  const lastGood = useRef<{ lat: number; lng: number } | null>(
    latitude != null && longitude != null ? { lat: latitude, lng: longitude } : null,
  );

  /**
   * Every way a pin can arrive — a tap, a drag, the device's own fix — goes through here. Outside
   * India it is refused with a sentence and the marker goes back; inside, it is saved.
   */
  const place = useCallback((lat: number, lng: number, fromDevice = false): boolean => {
    if (!isPlausibleIndianCoord(lat, lng)) {
      setPinError(fromDevice ? FIX_OUTSIDE_INDIA : PIN_OUTSIDE_INDIA);
      const back = lastGood.current;
      if (markerRef.current) {
        if (back) markerRef.current.setLatLng([back.lat, back.lng]);
        else if (mapRef.current) { mapRef.current.removeLayer(markerRef.current); markerRef.current = null; }
      }
      return false;
    }
    setPinError(null);
    lastGood.current = { lat: round(lat), lng: round(lng) };
    onChange(round(lat), round(lng));
    return true;
  }, [onChange]);
  // Leaflet's handlers are bound once, when the map is made; they call the latest `place`.
  const placeRef = useRef(place);
  placeRef.current = place;

  // ── Initialise Leaflet ──────────────────────────────────────────────
  useEffect(() => {
    if (!expanded || !containerRef.current || mapRef.current) return;

    const center: L.LatLngTuple =
      latitude != null && longitude != null ? [latitude, longitude] : INDIA_CENTER;
    const zoom = latitude != null ? PIN_ZOOM : DEFAULT_ZOOM;

    const map = L.map(containerRef.current, {
      center,
      zoom,
      zoomControl: true,
      scrollWheelZoom: true,
    });

    /**
     * The attribution is not decoration — it is the licence.
     *
     * These tiles and the data behind them are OpenStreetMap, carried under ODbL, which requires
     * the credit to be visible wherever the data is shown. This map had `attributionControl:
     * false` and a tile layer with no `attribution`, so it displayed OSM data with the credit
     * suppressed. `InteractivePlanningMap` already credits it the same way; this is the one
     * surface that did not.
     */
    L.tileLayer(STREET_TILE_URL, STREET_TILE_OPTIONS).addTo(map);

    if (latitude != null && longitude != null) {
      markerRef.current = L.marker([latitude, longitude], { icon: MARKER_ICON, draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const pos = markerRef.current!.getLatLng();
        placeRef.current(pos.lat, pos.lng);
      });
    }

    map.on('click', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      if (!isPlausibleIndianCoord(lat, lng)) {
        placeRef.current(lat, lng);
        return;
      }
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
      } else {
        markerRef.current = L.marker([lat, lng], { icon: MARKER_ICON, draggable: true }).addTo(map);
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current!.getLatLng();
          placeRef.current(pos.lat, pos.lng);
        });
      }
      placeRef.current(lat, lng);
    });

    mapRef.current = map;

    // Leaflet needs a resize kick when its container appears after being hidden.
    setTimeout(() => map.invalidateSize(), 150);

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Only run on first expansion; lat/lng changes handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // ── Sync marker when external lat/lng changes ───────────────────────
  useEffect(() => {
    if (latitude != null && longitude != null) lastGood.current = { lat: latitude, lng: longitude };
    if (!mapRef.current) return;
    if (latitude != null && longitude != null) {
      if (markerRef.current) {
        markerRef.current.setLatLng([latitude, longitude]);
      } else {
        markerRef.current = L.marker([latitude, longitude], { icon: MARKER_ICON, draggable: true }).addTo(mapRef.current);
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current!.getLatLng();
          placeRef.current(pos.lat, pos.lng);
        });
      }
    }
  }, [latitude, longitude, onChange]);

  // ── Geolocation ─────────────────────────────────────────────────────
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoStatus('unavailable');
      return;
    }
    setGeoStatus('finding');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = round(pos.coords.latitude);
        const lng = round(pos.coords.longitude);
        if (!place(lat, lng, true)) {
          setGeoStatus('idle');
          return;
        }
        if (mapRef.current) {
          mapRef.current.flyTo([lat, lng], PIN_ZOOM, { duration: 0.8 });
        }
        if (markerRef.current) {
          markerRef.current.setLatLng([lat, lng]);
        } else if (mapRef.current) {
          markerRef.current = L.marker([lat, lng], { icon: MARKER_ICON, draggable: true }).addTo(mapRef.current);
          markerRef.current.on('dragend', () => {
            const p = markerRef.current!.getLatLng();
            placeRef.current(p.lat, p.lng);
          });
        }
        setGeoStatus('idle');
      },
      (err) => {
        setGeoStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, timeout: 12000 },
    );
  }, [place]);

  const clearPin = useCallback(() => {
    if (markerRef.current && mapRef.current) {
      mapRef.current.removeLayer(markerRef.current);
      markerRef.current = null;
    }
    lastGood.current = null;
    setPinError(null);
    onChange(null, null);
  }, [onChange]);

  const hasPin = latitude != null && longitude != null;

  return (
    <div style={{
      marginTop: '14px',
      borderRadius: '10px',
      border: '1px solid var(--border-color)',
      background: 'var(--bg-surface-2)',
      overflow: 'hidden',
    }}>
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Hide the map picker' : 'Show the map picker to pin your location'}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
          padding: '12px 16px', background: 'none', border: 'none',
          cursor: 'pointer', color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)', fontWeight: 600, textAlign: 'left',
        }}
      >
        <MapPin size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          Pin your location on the map
          <span style={{ fontWeight: 400, marginLeft: '6px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            (Optional — helps us verify your address faster)
          </span>
        </span>
        {hasPin && (
          <span style={{
            fontSize: 'var(--text-xs)', fontWeight: 600, padding: '2px 7px',
            borderRadius: '999px', background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e',
          }}>
            ✓ Pinned
          </span>
        )}
        <span style={{
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s', fontSize: 'var(--text-xs)',
        }}>
          ▼
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '0 16px 14px 16px' }}>
          <p style={{
            fontSize: 'var(--text-xs)', color: 'var(--text-muted)',
            margin: '0 0 10px 0', lineHeight: 1.5,
          }}>
            Tap or click the map to place your pin. You can also drag it to adjust.
            This helps us assign work near your home and calculate accurate travel costs.
          </p>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={useMyLocation}
              disabled={geoStatus === 'finding'}
              title="Use your device location for the pin"
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '6px 12px', borderRadius: '6px',
                background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
                color: 'var(--text-secondary)', fontSize: 'var(--text-xs)',
                cursor: geoStatus === 'finding' ? 'wait' : 'pointer', fontWeight: 500,
              }}
            >
              <Navigation size={12} />
              {geoStatus === 'finding' ? 'Finding…' : 'Use my current location'}
            </button>
            {hasPin && (
              <button
                type="button"
                onClick={clearPin}
                title="Remove the pinned location"
                style={{
                  padding: '6px 12px', borderRadius: '6px',
                  background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)',
                  color: 'var(--danger)', fontSize: 'var(--text-xs)',
                  cursor: 'pointer', fontWeight: 500,
                }}
              >
                Clear pin
              </button>
            )}
          </div>

          {pinError && (
            <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginBottom: '8px' }}>
              {pinError}
            </div>
          )}
          {geoStatus === 'denied' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', marginBottom: '8px' }}>
              Location access was denied. You can still tap the map to place your pin manually.
            </div>
          )}
          {geoStatus === 'unavailable' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', marginBottom: '8px' }}>
              Location is not available on this device. Tap the map to place your pin manually.
            </div>
          )}

          {/* Map container */}
          <div
            ref={containerRef}
            style={{
              width: '100%', height: '260px', borderRadius: '8px',
              border: '1px solid var(--border-color)', overflow: 'hidden',
            }}
          />

          {hasPin && (
            <div style={{
              marginTop: '8px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: '4px',
            }}>
              <MapPin size={11} />
              {latitude!.toFixed(5)}, {longitude!.toFixed(5)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function round(n: number): number {
  return Math.round(n * 10_000_000) / 10_000_000;
}
