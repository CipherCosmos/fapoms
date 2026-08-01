import React, { useState } from 'react';
import { Check, X, Search, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

interface AssayerOption {
  id: string;
  displayName: string;
  name?: string;
  status?: string;
}

export const AssayerMultiSelect: React.FC<{
  label: React.ReactNode;
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  exclude?: string[];
}> = ({ label, value, onChange, placeholder, exclude = [] }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery<AssayerOption[]>({
    queryKey: ['assayers', 'options'],
    queryFn: async () => {
      const res = await api.request<AssayerOption[] | { data: AssayerOption[] }>('/assayers', { method: 'GET' });
      return Array.isArray(res) ? res : (res as any).data ?? [];
    },
    staleTime: 5 * 60_000,
  });

  const allOptions = data ?? [];
  const options = allOptions.filter((a) => !exclude.includes(a.id));
  const selected = options.filter((a) => value.includes(a.id));
  const filtered = search ? options.filter((a) => (a.displayName || a.name || '').toLowerCase().includes(search.toLowerCase())) : options;

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
      {label}
      <div style={{ position: 'relative' }}>
        {selected.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
            {selected.map((a) => (
              <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: '#93c5fd' }}>
                {a.displayName || a.name}
                <button type="button" onClick={() => toggle(a.id)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex' }} aria-label={`Remove ${a.displayName}`}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          onClick={() => setOpen((o) => !o)}
          style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>{selected.length > 0 ? `${selected.length} selected` : (placeholder ?? 'Select assayers...')}</span>
          {isLoading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
        </div>
        {open && (
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--bg-elevated, var(--bg-secondary))', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 20, overflow: 'hidden' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assayers..."
              style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-primary)', border: 'none', borderBottom: '1px solid var(--border-color)', color: '#fff', outline: 'none', fontSize: 13 }}
            />
            <div style={{ maxHeight: 200, overflowY: 'auto', padding: 4 }}>
              {filtered.length === 0 && <div style={{ padding: 10, color: 'var(--text-muted)', textAlign: 'center' }}>No assayers found</div>}
              {filtered.map((a) => {
                const isChecked = value.includes(a.id);
                return (
                  <div
                    key={a.id}
                    onClick={() => toggle(a.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', borderRadius: 'var(--radius-sm)', background: isChecked ? 'rgba(59,130,246,0.1)' : 'transparent' }}
                  >
                    <span style={{ width: 16, height: 16, borderRadius: 4, border: isChecked ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isChecked ? 'var(--accent-primary)' : 'transparent', flexShrink: 0 }}>
                      {isChecked && <Check size={11} color="#fff" />}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>{a.displayName || a.name}</span>
                    {a.status && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.status}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
