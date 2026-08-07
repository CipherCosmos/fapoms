import React, { useEffect, useRef, useState } from 'react';
import { Loader, MapPin, AlertTriangle } from 'lucide-react';
import { api } from '../../services/api';

/** A real, whole-India place returned by GET /geo/autocomplete (live Google Places). */
export interface IndiaPlaceResult {
  label: string;
  type: string;
  state: string;
  district: string;
  pincode: string;
}

/**
 * Debounced type-to-search dropdown backed by the live geo endpoint, so the user
 * can pick a real place anywhere in India instead of typing free text that the
 * backend then has to guess at.
 */
export const Autocomplete: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSelect?: (r: IndiaPlaceResult) => void;
  placeholder?: string;
  filterType?: (r: IndiaPlaceResult) => boolean;
  minChars?: number;
}> = ({ value, onChange, onSelect, placeholder, filterType, minChars = 2 }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [opts, setOpts] = useState<IndiaPlaceResult[]>([]);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = (value || '').trim();
    if (q.length < minChars) {
      setOpts([]); setOpen(false); return;
    }
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setBusy(true); setErr(false);
      try {
        const res = await api.request<IndiaPlaceResult[]>(`/geo/autocomplete?q=${encodeURIComponent(q)}`);
        const list = (Array.isArray(res) ? res : []).filter((r) => !filterType || filterType(r));
        setOpts(list);
        setOpen(list.length > 0);
      } catch {
        setErr(true); setOpen(false);
      }
      setBusy(false);
    }, 350);
    return () => { if (deb.current) clearTimeout(deb.current); };
  }, [value, minChars]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (r: IndiaPlaceResult) => {
    onChange(r.label);
    onSelect?.(r);
    setOpen(false);
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); }}
        onFocus={() => { if (opts.length) setOpen(true); }}
        autoComplete="off"
        style={{
          padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', width: '100%',
          boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px', paddingRight: '30px',
        }}
      />
      {busy && (
        <span style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>
          <Loader size={14} />
        </span>
      )}
      {err && (
        <span style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--danger)' }}>
          <AlertTriangle size={14} />
        </span>
      )}
      {open && opts.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
          background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '8px',
          boxShadow: '0 12px 30px rgba(0,0,0,0.35)', maxHeight: 260, overflow: 'auto',
        }}>
          {opts.map((r, i) => (
            <button
              key={`${r.label}-${i}`}
              type="button"
              onClick={() => pick(r)}
              style={{
                display: 'flex', gap: '8px', width: '100%', textAlign: 'left', padding: '8px 12px',
                background: 'none', border: 'none', cursor: 'pointer', fontSize: '12.5px',
                color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hair)',
              }}
            >
              <MapPin size={13} style={{ flex: 'none', marginTop: 1, opacity: 0.6 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block' }}>{r.label}</span>
                <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                  {r.type}{r.pincode ? ` · ${r.pincode}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default Autocomplete;
