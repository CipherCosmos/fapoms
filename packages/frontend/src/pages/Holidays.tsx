import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Plus, Trash2, Edit2, ShieldAlert, X } from 'lucide-react';
import { api } from '../services/api';
import { StatusBadge, Modal, AlertBanner } from '../components/ui';

interface Holiday {
  id: string;
  name: string;
  date: string;
  type: 'NATIONAL' | 'BANK' | 'REGIONAL' | 'STATE';
  applicableStates?: string[] | null;
  clientId?: string | null;
  year?: number;
}

interface ClientOption {
  id: string;
  name: string;
  code: string;
}

const HOLIDAY_TYPES = [
  { value: 'BANK', label: '🏦 Bank Holiday' },
  { value: 'NATIONAL', label: '🇮🇳 National Holiday' },
  { value: 'REGIONAL', label: '🗺️ Regional / State Holiday' },
];

const INDIAN_STATES = [
  'Maharashtra', 'Delhi', 'Karnataka', 'Tamil Nadu', 'Telangana', 'West Bengal',
  'Gujarat', 'Uttar Pradesh', 'Rajasthan', 'Kerala', 'Punjab', 'Haryana',
];

export const Holidays: React.FC = () => {
  const [yearFilter, setYearFilter] = useState<number>(new Date().getFullYear());
  const [clientFilter, setClientFilter] = useState<string>('ALL');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [type, setType] = useState('BANK');
  const [clientId, setClientId] = useState<string>('');
  const [selectedStates, setSelectedStates] = useState<string[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: clientsRes } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.request<ClientOption[]>('/clients'),
  });

  const clients = (Array.isArray(clientsRes) ? clientsRes : (clientsRes as any)?.data) || [];

  const { data: holidaysResponse, isLoading, refetch } = useQuery({
    queryKey: ['holidays', yearFilter, clientFilter],
    queryFn: () => api.request<Holiday[]>(`/holidays?year=${yearFilter}${clientFilter !== 'ALL' ? `&clientId=${clientFilter}` : ''}&limit=200`),
  });

  const holidays = (Array.isArray(holidaysResponse) ? holidaysResponse : (holidaysResponse as any)?.data) || [];

  const handleOpenCreate = () => {
    setEditingId(null);
    setName('');
    setDate(`${yearFilter}-01-01`);
    setType('BANK');
    setClientId(clientFilter !== 'ALL' ? clientFilter : '');
    setSelectedStates([]);
    setShowModal(true);
  };

  const handleOpenEdit = (h: Holiday) => {
    setEditingId(h.id);
    setName(h.name);
    setDate(new Date(h.date).toISOString().split('T')[0]);
    setType(h.type);
    setClientId(h.clientId || '');
    setSelectedStates(h.applicableStates || []);
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        await api.request(`/holidays/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name, date, type, applicableStates: selectedStates, clientId: clientId || null }),
        });
        setSuccess('Holiday updated successfully');
      } else {
        await api.request('/holidays', {
          method: 'POST',
          body: JSON.stringify({ name, date, type, applicableStates: selectedStates, clientId: clientId || null }),
        });
        setSuccess('Holiday registered successfully');
      }
      setShowModal(false);
      refetch();
    } catch (err: any) {
      setError(err?.message || 'Operation failed');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this holiday record?')) return;
    try {
      await api.request(`/holidays/${id}`, { method: 'DELETE' });
      setSuccess('Holiday deleted successfully');
      refetch();
    } catch (err: any) {
      setError(err?.message || 'Delete failed');
    }
  };

  const toggleState = (st: string) => {
    setSelectedStates((prev) =>
      prev.includes(st) ? prev.filter((s) => s !== st) : [...prev, st]
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Calendar style={{ color: '#8b5cf6' }} /> State & Bank Holiday Management
          </h2>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Configure national, bank, and regional state holidays to enforce conflict validation during audit scheduling
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            style={{ padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
          >
            <option value="ALL">🏦 All Clients (Global Scope)</option>
            {clients.map((c: any) => (
              <option key={c.id} value={c.id}>🏦 Client: {c.name || c.code}</option>
            ))}
          </select>
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(Number(e.target.value))}
            style={{ padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
          >
            {[2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>{y} Calendar</option>
            ))}
          </select>
          <button onClick={handleOpenCreate} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
            <Plus size={14} /> Add Holiday
          </button>
        </div>
      </div>

      {error && (
        <AlertBanner type="error">{error}</AlertBanner>
      )}
      {success && (
        <AlertBanner type="success">{success}</AlertBanner>
      )}

      {/* Holiday Table Card */}
      <div className="glass-card" style={{ padding: '20px' }}>
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading holiday records...</div>
        ) : holidays.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            <ShieldAlert size={36} style={{ margin: '0 auto 10px', opacity: 0.4 }} />
            <p>No holidays registered for {yearFilter}. Click "Add Holiday" to configure.</p>
          </div>
        ) : (
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-muted)', fontSize: '12px' }}>
                <th style={{ padding: '10px' }}>Date</th>
                <th style={{ padding: '10px' }}>Holiday Name</th>
                <th style={{ padding: '10px' }}>Type</th>
                <th style={{ padding: '10px' }}>Client Scope</th>
                <th style={{ padding: '10px' }}>Applicable States / Scope</th>
                <th style={{ padding: '10px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((h: Holiday) => {
                const matchedClient = clients.find((c: any) => c.id === h.clientId);
                return (
                  <tr key={h.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '13px' }}>
                    <td style={{ padding: '12px 10px', fontWeight: 600, color: '#a5b4fc' }}>
                      {new Date(h.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td style={{ padding: '12px 10px', fontWeight: 600, color: '#fff' }}>{h.name}</td>
                    <td style={{ padding: '12px 10px' }}>
                      <StatusBadge label={h.type} bg={h.type === 'NATIONAL' ? 'rgba(239,68,68,0.15)' : h.type === 'BANK' ? 'rgba(245,158,11,0.15)' : 'rgba(99,102,241,0.15)'} color={h.type === 'NATIONAL' ? '#ef4444' : h.type === 'BANK' ? '#f59e0b' : '#818cf8'} />
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: '12px' }}>
                      {!h.clientId ? (
                        <span style={{ color: '#94a3b8', fontWeight: 500 }}>🌐 All Clients (Global)</span>
                      ) : (
                        <span style={{ color: '#f59e0b', fontWeight: 600 }}>🏦 {matchedClient?.name || 'Specific Client'}</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px', color: 'var(--text-secondary)' }}>
                      {!h.applicableStates || h.applicableStates.length === 0 ? (
                        <span style={{ color: '#10b981', fontWeight: 600 }}>🇮🇳 All India (National)</span>
                      ) : (
                        <span>🗺️ {h.applicableStates.join(', ')}</span>
                      )}
                    </td>
                  <td style={{ padding: '12px 10px', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      <button onClick={() => handleOpenEdit(h)} style={{ padding: '4px 8px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '4px', color: '#a5b4fc', cursor: 'pointer' }}>
                        <Edit2 size={12} />
                      </button>
                      <button onClick={() => handleDelete(h.id)} style={{ padding: '4px 8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '4px', color: '#fca5a5', cursor: 'pointer' }}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <Modal open onClose={() => setShowModal(false)} title={editingId ? 'Edit Holiday Record' : 'Add New State / Bank Holiday'} width="500px" closeIcon={<X size={18} />} asForm onSubmit={handleSubmit}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Save Holiday</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Client Scope (Optional)</label>
                <select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
                >
                  <option value="">🌐 All Clients (Global Holiday Calendar)</option>
                  {clients.map((c: any) => (
                    <option key={c.id} value={c.id}>🏦 Specific Client: {c.name || c.code}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Holiday Title</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Bank Closing Day / Annual Audit Closure"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Holiday Date</label>
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Category Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
                  >
                    {HOLIDAY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Applicable States (Leave empty for All India)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '120px', overflowY: 'auto', padding: '8px', background: 'var(--bg-primary)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                  {INDIAN_STATES.map((st) => {
                    const isSelected = selectedStates.includes(st);
                    return (
                      <button
                        type="button"
                        key={st}
                        onClick={() => toggleState(st)}
                        style={{ padding: '4px 8px', borderRadius: '4px', fontSize: '11px', border: 'none', cursor: 'pointer', backgroundColor: isSelected ? '#6366f1' : '#334155', color: '#fff' }}
                      >
                        {isSelected ? `✓ ${st}` : st}
                      </button>
                    );
                  })}
                </div>
              </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
