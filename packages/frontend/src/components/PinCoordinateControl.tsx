import React, { useState } from 'react';
import { MapPin, Map, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { CoordinatePinModal } from './geo/CoordinatePinModal';

/**
 * Place a record's coordinate by hand.
 *
 * This exists because the honest ceiling for free geocoding is not 5–10 m. The free tiers reach
 * the actual building only when somebody has mapped that building in OpenStreetMap; for the rest
 * they reach the locality, ~900 m. The one reliable route to metre accuracy is a person who
 * knows where the place is — usually the assayer who has already been there — and this is the
 * two-field version of that.
 *
 * A pin placed here is marked `manual` on the server and is never overwritten by a re-geocode,
 * an import, or the precision backfill. That is the point: the correction has to outlive the
 * next time somebody re-uploads the client's branch list.
 *
 * The server sanity-checks the pair (in India, and in the state the record claims) before
 * accepting it, so the classic transposed-lat/lng mistake is caught here rather than by whoever
 * reads the map three weeks later.
 */
export const PinCoordinateControl: React.FC<{
  target: 'branch' | 'assayer';
  id: string;
  onPinned?: () => void;
  /** Take the coordinate instead of pinning it. See the note above. */
  onPicked?: (latitude: number, longitude: number) => void;
  initialLat?: number | null;
  initialLng?: number | null;
  initialAccuracy?: number | null;
  title?: string;
  subtitle?: string;
}> = ({ target, id, onPinned, onPicked, initialLat, initialLng, initialAccuracy, title, subtitle }) => {
  const [open, setOpen] = useState(false);
  const [showMapModal, setShowMapModal] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    let lat: number | null = null;
    let lng: number | null = null;

    const trimmed = value.trim();
    // 1. Direct regex for "18.5204, 73.8567"
    const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (match) {
      lat = parseFloat(match[1]);
      lng = parseFloat(match[2]);
    } else {
      // 2. Try parsing Google Maps URLs, DMS, or complex coordinate strings via server helper
      try {
        setSaving(true);
        const parsed = await api.request<{ lat: number; lng: number } | null>(
          `/geo/parse-location?input=${encodeURIComponent(trimmed)}`
        );
        if (parsed && parsed.lat && parsed.lng) {
          lat = parsed.lat;
          lng = parsed.lng;
        }
      } catch {
        // Fall through to error check
      }
    }

    if (lat === null || lng === null) {
      setSaving(false);
      setError('Paste coordinates as "lat, lng" (e.g. 18.5204, 73.8567) or a Google Maps link.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (onPicked) {
        onPicked(lat, lng);
        setOpen(false);
        setValue('');
        setNote('');
        return;
      }
      await api.request(`/geo/precision/${target}/${id}/pin`, {
        method: 'POST',
        body: JSON.stringify({
          latitude: lat,
          longitude: lng,
          note: note.trim() || undefined,
        }),
      });
      setOpen(false);
      setValue('');
      setNote('');
      onPinned?.();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {!open ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="btn btn-secondary"
            style={{ padding: '4px 9px', fontSize: 'var(--text-3xs)', display: 'inline-flex', alignItems: 'center', gap: '5px', width: 'auto' }}
            title="Paste coordinate or Google Maps link directly"
          >
            <MapPin size={12} /> Pin the exact location
          </button>
          <button
            type="button"
            onClick={() => setShowMapModal(true)}
            className="btn btn-secondary"
            style={{ padding: '4px 9px', fontSize: 'var(--text-3xs)', display: 'inline-flex', alignItems: 'center', gap: '5px', width: 'auto' }}
            title="Open interactive satellite & street map to drop a pin"
          >
            <Map size={12} style={{ color: 'var(--accent-primary)' }} /> Pin on Map
          </button>
        </div>
      ) : (
        <div style={{ marginTop: '8px', padding: '9px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>
              Paste decimal coordinates, DMS (e.g. 19°04'33"N 72°52'39"E), or a Google Maps link.
            </div>
            <button
              type="button"
              onClick={() => { setOpen(false); setShowMapModal(true); }}
              title="Open the interactive map to drop a pin"
              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: 'var(--text-3xs)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', padding: 0 }}
            >
              <Map size={11} /> Open Interactive Map
            </button>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setOpen(false); }}
              placeholder="18.520430, 73.856744 or Google Maps link"
              aria-label="Exact coordinate or Google Maps link"
              title="Paste coordinates or a Google Maps link, for example 18.5204, 73.8567"
              style={{ flex: 1, minWidth: '190px', fontSize: 'var(--text-2xs)', fontFamily: 'monospace', padding: '5px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setOpen(false); }}
              placeholder="Note (optional) — e.g. front door"
              style={{ flex: 1, minWidth: '140px', fontSize: 'var(--text-2xs)', padding: '5px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
            />
            <button onClick={submit} disabled={saving || !value.trim()} className="btn btn-primary" style={{ padding: '5px 11px', fontSize: 'var(--text-3xs)', width: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              {saving ? <><Loader2 size={11} className="spinner" /> Saving…</> : 'Pin here'}
            </button>
            <button onClick={() => { setOpen(false); setError(null); }} className="btn btn-secondary" style={{ padding: '5px 11px', fontSize: 'var(--text-3xs)', width: 'auto' }}>
              Cancel
            </button>
          </div>
          {error && <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--danger)', marginTop: '6px' }}>{error}</div>}
        </div>
      )}

      {showMapModal && (
        <CoordinatePinModal
          open={showMapModal}
          onClose={() => setShowMapModal(false)}
          target={target}
          id={id}
          initialLat={initialLat}
          initialLng={initialLng}
          initialAccuracy={initialAccuracy}
          title={title || `Pin Exact ${target === 'branch' ? 'Branch' : 'Assayer'} Location`}
          subtitle={subtitle}
          onConfirmed={(confirmedLat, confirmedLng) => {
            if (onPicked) {
              onPicked(confirmedLat, confirmedLng);
            }
            onPinned?.();
          }}
        />
      )}
    </>
  );
};
