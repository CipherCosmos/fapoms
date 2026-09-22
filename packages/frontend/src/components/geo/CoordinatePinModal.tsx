import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MapPin, Navigation, Search, Layers, Check, AlertCircle, Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { GeoPrecisionBadge } from '../GeoPrecisionBadge';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';

/** Fix Leaflet marker icon in Vite */
const MARKER_ICON = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const INDIA_CENTER: L.LatLngTuple = [20.5937, 78.9629];
const DEFAULT_ZOOM = 5;
const PIN_ZOOM = 16;

export interface CoordinatePinModalProps {
  open: boolean;
  onClose: () => void;
  target?: 'branch' | 'assayer';
  id?: string;
  initialLat?: number | null;
  initialLng?: number | null;
  initialAccuracy?: number | null;
  title?: string;
  subtitle?: string;
  onConfirmed?: (latitude: number, longitude: number, note?: string) => void;
}

export const CoordinatePinModal: React.FC<CoordinatePinModalProps> = ({
  open,
  onClose,
  target,
  id,
  initialLat,
  initialLng,
  initialAccuracy,
  title = 'Pin Exact Location',
  subtitle,
  onConfirmed,
}) => {
  const [lat, setLat] = useState<number | null>(initialLat ?? null);
  const [lng, setLng] = useState<number | null>(initialLng ?? null);
  const [note, setNote] = useState('');
  const [linkInput, setLinkInput] = useState('');
  const [layerType, setLayerType] = useState<'street' | 'satellite'>('street');
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseSuccess, setParseSuccess] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  // Sync state when opened with props
  useEffect(() => {
    if (open) {
      setLat(initialLat ?? null);
      setLng(initialLng ?? null);
      setError(null);
      setParseSuccess(null);
      setNote('');
      setLinkInput('');
    }
  }, [open, initialLat, initialLng]);

  // Initialise or update Leaflet map
  useEffect(() => {
    if (!open || !containerRef.current) return;

    if (!mapRef.current) {
      const hasCoords = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
      const center: L.LatLngTuple = hasCoords ? [lat, lng] : INDIA_CENTER;
      const zoom = hasCoords ? PIN_ZOOM : DEFAULT_ZOOM;

      const map = L.map(containerRef.current, {
        center,
        zoom,
        zoomControl: true,
        scrollWheelZoom: true,
      });

      const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      });
      streetLayer.addTo(map);
      tileLayerRef.current = streetLayer;

      if (hasCoords) {
        markerRef.current = L.marker([lat, lng], { icon: MARKER_ICON, draggable: true }).addTo(map);
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current!.getLatLng();
          const newLat = parseFloat(pos.lat.toFixed(7));
          const newLng = parseFloat(pos.lng.toFixed(7));
          setLat(newLat);
          setLng(newLng);
          if (circleRef.current) {
            circleRef.current.setLatLng([newLat, newLng]);
          }
        });

        circleRef.current = L.circle([lat, lng], {
          radius: initialAccuracy && initialAccuracy > 10 ? initialAccuracy : 10,
          color: '#10b981',
          fillColor: '#10b981',
          fillOpacity: 0.15,
        }).addTo(map);
      }

      map.on('click', (e: L.LeafletMouseEvent) => {
        const clickLat = parseFloat(e.latlng.lat.toFixed(7));
        const clickLng = parseFloat(e.latlng.lng.toFixed(7));
        setLat(clickLat);
        setLng(clickLng);

        if (markerRef.current) {
          markerRef.current.setLatLng([clickLat, clickLng]);
        } else {
          markerRef.current = L.marker([clickLat, clickLng], { icon: MARKER_ICON, draggable: true }).addTo(map);
          markerRef.current.on('dragend', () => {
            const pos = markerRef.current!.getLatLng();
            const nLat = parseFloat(pos.lat.toFixed(7));
            const nLng = parseFloat(pos.lng.toFixed(7));
            setLat(nLat);
            setLng(nLng);
            if (circleRef.current) circleRef.current.setLatLng([nLat, nLng]);
          });
        }

        if (circleRef.current) {
          circleRef.current.setLatLng([clickLat, clickLng]);
        } else {
          circleRef.current = L.circle([clickLat, clickLng], {
            radius: 10,
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 0.15,
          }).addTo(map);
        }
      });

      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 200);
    } else {
      mapRef.current.invalidateSize();
      if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
        if (markerRef.current) {
          markerRef.current.setLatLng([lat, lng]);
        } else {
          markerRef.current = L.marker([lat, lng], { icon: MARKER_ICON, draggable: true }).addTo(mapRef.current);
          markerRef.current.on('dragend', () => {
            const pos = markerRef.current!.getLatLng();
            setLat(parseFloat(pos.lat.toFixed(7)));
            setLng(parseFloat(pos.lng.toFixed(7)));
          });
        }
        if (circleRef.current) {
          circleRef.current.setLatLng([lat, lng]);
        }
      }
    }

    return () => {
      // Clean up map when modal closes
      if (!open && mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        circleRef.current = null;
      }
    };
  }, [open, lat, lng, initialAccuracy]);

  // Handle layer switch (Street vs Satellite)
  const toggleLayer = () => {
    if (!mapRef.current) return;
    const nextType = layerType === 'street' ? 'satellite' : 'street';
    setLayerType(nextType);

    if (tileLayerRef.current) {
      mapRef.current.removeLayer(tileLayerRef.current);
    }

    if (nextType === 'satellite') {
      tileLayerRef.current = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          maxZoom: 19,
          attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        }
      ).addTo(mapRef.current);
    } else {
      tileLayerRef.current = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(mapRef.current);
    }
  };

  // Jump to browser geolocation
  const handleLocateMe = () => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const curLat = parseFloat(pos.coords.latitude.toFixed(7));
        const curLng = parseFloat(pos.coords.longitude.toFixed(7));
        setLat(curLat);
        setLng(curLng);
        setError(null);
        if (mapRef.current) {
          mapRef.current.setView([curLat, curLng], PIN_ZOOM);
          if (markerRef.current) markerRef.current.setLatLng([curLat, curLng]);
          if (circleRef.current) circleRef.current.setLatLng([curLat, curLng]);
        }
      },
      (err) => {
        setError(`Unable to retrieve location: ${err.message}`);
      },
      { enableHighAccuracy: true }
    );
  };

  // Parse location input (Google Maps link, DMS, decimal pair)
  const handleParseLocation = async () => {
    if (!linkInput.trim()) return;
    setParsing(true);
    setError(null);
    setParseSuccess(null);

    try {
      const res = await api.get<{ lat: number; lng: number } | null>(
        `/geo/parse-location?input=${encodeURIComponent(linkInput.trim())}`
      );
      if (res && res.lat && res.lng) {
        setLat(res.lat);
        setLng(res.lng);
        setParseSuccess(`Resolved to ${res.lat.toFixed(6)}, ${res.lng.toFixed(6)}`);
        if (mapRef.current) {
          mapRef.current.setView([res.lat, res.lng], PIN_ZOOM);
          if (markerRef.current) markerRef.current.setLatLng([res.lat, res.lng]);
          if (circleRef.current) circleRef.current.setLatLng([res.lat, res.lng]);
        }
      } else {
        setError('Could not extract coordinates from input. Please paste a valid Google Maps link or lat, lng pair.');
      }
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setParsing(false);
    }
  };

  // Submit and confirm pin
  const handleConfirm = async () => {
    if (lat == null || lng == null) {
      setError('Please click on the map or paste coordinates to place a pin.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (target && id) {
        await api.post(`/geo/precision/${target}/${id}/pin`, {
          latitude: lat,
          longitude: lng,
          note: note.trim() || undefined,
        });
      }

      if (onConfirmed) {
        onConfirmed(lat, lng, note.trim() || undefined);
      }

      onClose();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MapPin size={18} style={{ color: 'var(--accent-primary)' }} />
          <span>{title}</span>
        </div>
      }
      width="780px"
      dismissOnBackdrop={false}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {lat != null && lng != null ? (
              <>
                <GeoPrecisionBadge source="manual" accuracyMeters={5} />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  {lat.toFixed(6)}, {lng.toFixed(6)}
                </span>
              </>
            ) : (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Click map or paste link to drop pin
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirm}
              disabled={saving || lat == null || lng == null}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              Confirm Exact Location
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {subtitle && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--bg-surface-2)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>
            {subtitle}
          </div>
        )}

        {/* Input Bar: Paste Google Maps Link or coordinates */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              type="text"
              placeholder="Paste Google Maps URL, DMS (19°04'33.6&quot;N 72°52'39.7&quot;E), or decimal (19.1136, 72.8697)..."
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleParseLocation()}
              className="input-field"
              style={{ width: '100%', fontSize: 'var(--text-xs)', paddingRight: '28px' }}
            />
            {linkInput && (
              <button
                type="button"
                onClick={() => setLinkInput('')}
                style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                &times;
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleParseLocation}
            disabled={parsing || !linkInput.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)' }}
          >
            {parsing ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            Parse & Jump
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleLocateMe}
            title="Use My Current GPS Position"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)' }}
          >
            <Navigation size={13} />
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={toggleLayer}
            title={`Switch to ${layerType === 'street' ? 'Satellite' : 'Street'} View`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)' }}
          >
            <Layers size={13} />
            {layerType === 'street' ? 'Satellite' : 'Street'}
          </button>
        </div>

        {parseSuccess && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Check size={13} /> {parseSuccess}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {/* Leaflet Map Box */}
        <div style={{ position: 'relative', width: '100%', height: '360px', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
          <div ref={containerRef} style={{ width: '100%', height: '100%', zIndex: 1 }} />
          <div
            style={{
              position: 'absolute',
              bottom: '8px',
              left: '8px',
              zIndex: 1000,
              background: 'rgba(15, 23, 42, 0.85)',
              backdropFilter: 'blur(4px)',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: 'var(--text-2xs)',
              color: '#e2e8f0',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            💡 Drag pin or click map to reposition | Green circle = accuracy radius (&le;10m)
          </div>
        </div>

        {/* Optional note input */}
        <div>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: '4px' }}>
            Location Landmark / Pin Note (Optional):
          </label>
          <input
            type="text"
            placeholder="e.g. Front entrance, opposite Metro Gate 2, near ATM"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="input-field"
            style={{ width: '100%', fontSize: 'var(--text-xs)' }}
          />
        </div>
      </div>
    </Modal>
  );
};
