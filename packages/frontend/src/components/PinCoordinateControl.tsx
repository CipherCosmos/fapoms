import React, { useState } from 'react';
import { MapPin } from 'lucide-react';
import { api } from '../services/api';
import { userMessage } from '../services/errors';

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
/**
 * `onPicked` is for a subject that has no row to pin yet.
 *
 * The registration wizard is the case: it fills in a candidate's APPLICATION, and there is no
 * assayer to POST `/geo/precision/assayer/:id/pin` against until somebody approves it. The
 * coordinate is still worth collecting — `latitude` and `longitude` are on the registration
 * allow-list precisely so an application can carry them, and promotion applies them — so the
 * control hands the pair back instead of writing it, and the caller puts it wherever it belongs.
 *
 * Given `onPicked`, nothing is sent from here at all.
 */
export const PinCoordinateControl: React.FC<{
  target: 'branch' | 'assayer';
  id: string;
  onPinned?: () => void;
  /** Take the coordinate instead of pinning it. See the note above. */
  onPicked?: (latitude: number, longitude: number) => void;
}> = ({ target, id, onPinned, onPicked }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    // Accepts what people actually paste: "18.5204, 73.8567" straight out of Google Maps or
    // OpenStreetMap. Requiring two separate fields is how you get one of them left blank.
    const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) {
      setError('Paste the coordinate as "latitude, longitude" — for example 18.520430, 73.856744.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (onPicked) {
        onPicked(parseFloat(match[1]), parseFloat(match[2]));
        setOpen(false);
        setValue('');
        setNote('');
        return;
      }
      await api.request(`/geo/precision/${target}/${id}/pin`, {
        method: 'POST',
        body: JSON.stringify({
          latitude: parseFloat(match[1]),
          longitude: parseFloat(match[2]),
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

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn btn-secondary"
        style={{ marginTop: '6px', padding: '4px 9px', fontSize: 'var(--text-3xs)', display: 'inline-flex', alignItems: 'center', gap: '5px', width: 'auto' }}
      >
        <MapPin size={12} /> Pin the exact location
      </button>
    );
  }

  return (
    <div style={{ marginTop: '8px', padding: '9px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
      <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginBottom: '6px' }}>
        Find the place on{' '}
        <a href="https://www.openstreetmap.org" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>
          OpenStreetMap
        </a>{' '}
        or Google Maps, right-click the exact spot, and paste the coordinate here. It will not be
        overwritten by any future re-geocode or import.
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setOpen(false); }}
          placeholder="18.520430, 73.856744"
          aria-label="Exact coordinate as latitude, longitude"
          style={{ flex: 1, minWidth: '170px', fontSize: 'var(--text-2xs)', fontFamily: 'monospace', padding: '5px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setOpen(false); }}
          placeholder="Note (optional) — e.g. front door"
          style={{ flex: 1, minWidth: '150px', fontSize: 'var(--text-2xs)', padding: '5px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
        />
        <button onClick={submit} disabled={saving || !value.trim()} className="btn btn-primary" style={{ padding: '5px 11px', fontSize: 'var(--text-3xs)', width: 'auto' }}>
          {saving ? 'Saving…' : 'Pin here'}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} className="btn btn-secondary" style={{ padding: '5px 11px', fontSize: 'var(--text-3xs)', width: 'auto' }}>
          Cancel
        </button>
      </div>
      {error && <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--danger)', marginTop: '6px' }}>{error}</div>}
    </div>
  );
};
