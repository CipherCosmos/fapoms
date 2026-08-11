import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Plus, Trash2, Edit2, ShieldAlert, X, ChevronLeft, ChevronRight, List, Grid3x3, Info } from 'lucide-react';
import { INDIAN_STATES } from '@fapoms/shared';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { StatusBadge, Modal, AlertBanner } from '../components/ui';
import { useCurrentRoles, canManageHolidays } from '../hooks/useCurrentRoles';

interface Holiday {
  id: string;
  name: string;
  date: string;
  type: 'NATIONAL' | 'BANK' | 'STATE';
  applicableStates?: string[] | null;
  clientId?: string | null;
  year?: number;
}

interface ClientOption {
  id: string;
  name: string;
  code: string;
}

/**
 * The only three values this deployment's holidays actually use. The form used
 * to offer BANK / NATIONAL / REGIONAL — but the real data (and the branch/scheduling
 * code that reads it) uses STATE, not REGIONAL, so editing an existing
 * state-scoped holiday through the old form would silently save it as the wrong
 * type: the dropdown had nothing selected, and the first option would win.
 */
const HOLIDAY_TYPES: { value: Holiday['type']; label: string }[] = [
  { value: 'BANK', label: '🏦 Bank Holiday' },
  { value: 'NATIONAL', label: '🇮🇳 National Holiday' },
  { value: 'STATE', label: '🗺️ State Holiday' },
];

const TYPE_TONE: Record<string, { bg: string; color: string }> = {
  NATIONAL: { bg: 'var(--status-cancelled-bg)', color: 'var(--danger)' },
  BANK: { bg: 'var(--status-pending-bg)', color: 'var(--warning)' },
  STATE: { bg: 'rgba(216,174,71,0.15)', color: 'var(--accent)' },
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** RBI rule the backend enforces but never showed anywhere: every Sunday, and the
 * 2nd/4th Saturday of each month, is a bank holiday regardless of what is registered. */
function isAutoWeekendHoliday(date: Date): string | null {
  const day = date.getDay();
  if (day === 0) return 'Sunday';
  if (day === 6) {
    const week = Math.ceil(date.getDate() / 7);
    if (week === 2) return '2nd Saturday';
    if (week === 4) return '4th Saturday';
  }
  return null;
}

const toISODate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const Holidays: React.FC = () => {
  const canManage = canManageHolidays(useCurrentRoles());

  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [monthCursor, setMonthCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const yearFilter = monthCursor.getFullYear();
  const [clientFilter, setClientFilter] = useState<string>('ALL');
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [type, setType] = useState<Holiday['type']>('BANK');
  const [clientId, setClientId] = useState<string>('');
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  const [stateSearch, setStateSearch] = useState('');

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
  // Memoized so its identity is stable across renders — otherwise the `byDate` Map below rebuilt on
  // every render (form typing, etc.), not just when the data changed.
  const holidays = useMemo(
    () => (Array.isArray(holidaysResponse) ? holidaysResponse : (holidaysResponse as any)?.data) || [],
    [holidaysResponse],
  );

  const byDate = useMemo(() => {
    const m = new Map<string, Holiday[]>();
    for (const h of holidays) {
      const key = new Date(h.date).toISOString().slice(0, 10);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(h);
    }
    return m;
  }, [holidays]);

  const resetForm = () => {
    setName(''); setType('BANK'); setClientId(clientFilter !== 'ALL' ? clientFilter : ''); setSelectedStates([]); setStateSearch('');
  };

  const handleOpenCreate = (prefillDate?: string) => {
    setEditingId(null);
    resetForm();
    setDate(prefillDate ?? toISODate(new Date(yearFilter, monthCursor.getMonth(), 1)));
    setShowModal(true);
  };

  const handleOpenEdit = (h: Holiday) => {
    setEditingId(h.id);
    setName(h.name);
    setDate(new Date(h.date).toISOString().split('T')[0]);
    setType((h.type as Holiday['type']) ?? 'BANK');
    setClientId(h.clientId || '');
    setSelectedStates(h.applicableStates || []);
    setStateSearch('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = { name, date, type, applicableStates: type === 'STATE' ? selectedStates : [], clientId: clientId || null };
    setSubmitting(true);
    try {
      if (editingId) {
        await api.request(`/holidays/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
        setSuccess('Holiday updated.');
      } else {
        await api.request('/holidays', { method: 'POST', body: JSON.stringify(body) });
        setSuccess('Holiday registered.');
      }
      setShowModal(false);
      refetch();
    } catch (err: any) {
      setError(`Operation failed ${userMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this holiday record?')) return;
    try {
      await api.request(`/holidays/${id}`, { method: 'DELETE' });
      setSuccess('Holiday deleted.');
      refetch();
    } catch (err: any) {
      setError(`Delete failed ${userMessage(err)}`);
    }
  };

  const toggleState = (st: string) =>
    setSelectedStates((prev) => (prev.includes(st) ? prev.filter((s) => s !== st) : [...prev, st]));

  const filteredStateOptions = INDIAN_STATES.filter((s) => s.label.toLowerCase().includes(stateSearch.toLowerCase()));

  // ── Calendar grid for the current month ──────────────────────────────────
  const grid = useMemo(() => {
    const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(monthCursor.getFullYear(), monthCursor.getMonth(), d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [monthCursor]);

  const today = toISODate(new Date());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Calendar style={{ color: 'var(--accent)' }} /> Holiday Calendar
          </h2>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            National, bank and state holidays used to keep audits off dates nobody can work.
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden' }}>
            <button onClick={() => setView('calendar')} title="Calendar view"
              style={{ padding: '7px 10px', background: view === 'calendar' ? 'var(--accent-primary)' : 'transparent', border: 'none', color: view === 'calendar' ? 'var(--on-accent)' : 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
              <Grid3x3 size={14} />
            </button>
            <button onClick={() => setView('list')} title="List view"
              style={{ padding: '7px 10px', background: view === 'list' ? 'var(--accent-primary)' : 'transparent', border: 'none', color: view === 'list' ? 'var(--on-accent)' : 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
              <List size={14} />
            </button>
          </div>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            style={{ padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }}
          >
            <option value="ALL">🏦 All Clients (Global Scope)</option>
            {clients.map((c: any) => (
              <option key={c.id} value={c.id}>🏦 Client: {c.name || c.code}</option>
            ))}
          </select>
          {canManage && (
            <button onClick={() => handleOpenCreate()} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
              <Plus size={14} /> Add Holiday
            </button>
          )}
        </div>
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {success && <AlertBanner type="success">{success}</AlertBanner>}

      {view === 'calendar' ? (
        <div className="glass-card" style={{ padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <button onClick={() => setMonthCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
              className="btn btn-secondary" style={{ padding: '6px 10px' }}><ChevronLeft size={14} /></button>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>{MONTH_NAMES[monthCursor.getMonth()]} {monthCursor.getFullYear()}</div>
            <button onClick={() => setMonthCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
              className="btn btn-secondary" style={{ padding: '6px 10px' }}><ChevronRight size={14} /></button>
          </div>

          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
                {WEEKDAY_LABELS.map((w) => (
                  <div key={w} style={{ textAlign: 'center', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: '4px 0' }}>{w}</div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
                {grid.map((d, i) => {
                  if (!d) return <div key={i} />;
                  const key = toISODate(d);
                  const regs = byDate.get(key) ?? [];
                  const auto = isAutoWeekendHoliday(d);
                  const isToday = key === today;
                  return (
                    <div
                      key={i}
                      onClick={() => (canManage ? (regs.length ? handleOpenEdit(regs[0]) : handleOpenCreate(key)) : undefined)}
                      style={{
                        minHeight: '76px', padding: '6px', borderRadius: '8px', cursor: canManage ? 'pointer' : 'default',
                        background: regs.length ? 'rgba(216,174,71,0.08)' : auto ? 'var(--border-hair)' : 'transparent',
                        border: isToday ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                        display: 'flex', flexDirection: 'column', gap: '3px',
                      }}
                    >
                      <div style={{ fontSize: '11px', fontWeight: isToday ? 800 : 600, color: isToday ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>{d.getDate()}</div>
                      {regs.slice(0, 2).map((h) => (
                        <div key={h.id} title={h.name} style={{
                          fontSize: '9.5px', padding: '1px 4px', borderRadius: '3px', overflow: 'hidden',
                          whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                          background: TYPE_TONE[h.type]?.bg ?? 'var(--border-hair)', color: TYPE_TONE[h.type]?.color ?? 'var(--text-primary)',
                        }}>
                          {h.name}
                        </div>
                      ))}
                      {regs.length > 2 && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>+{regs.length - 2} more</div>}
                      {!regs.length && auto && (
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)' }} title={`${auto} — automatic bank holiday`}>{auto}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: '14px', marginTop: '14px', fontSize: '11px', color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Info size={12} />
            <span>Every Sunday and the 2nd/4th Saturday are bank holidays automatically — not shown in the list below because nothing needs to be registered for them.</span>
          </div>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: '20px' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading holiday records...</div>
          ) : holidays.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <ShieldAlert size={36} style={{ margin: '0 auto 10px', opacity: 0.4 }} />
              <p>No holidays registered for {yearFilter}.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', minWidth: '640px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '10px' }}>Date</th>
                  <th style={{ padding: '10px' }}>Holiday Name</th>
                  <th style={{ padding: '10px' }}>Type</th>
                  <th style={{ padding: '10px' }}>Client Scope</th>
                  <th style={{ padding: '10px' }}>Applicable States</th>
                  {canManage && <th style={{ padding: '10px', textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {[...holidays].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((h: Holiday) => {
                  const matchedClient = clients.find((c: any) => c.id === h.clientId);
                  return (
                    <tr key={h.id} style={{ borderBottom: '1px solid var(--border-hair)', fontSize: '13px' }}>
                      <td style={{ padding: '12px 10px', fontWeight: 600, color: 'var(--accent)' }}>
                        {new Date(h.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td style={{ padding: '12px 10px', fontWeight: 600, color: 'var(--text-primary)' }}>{h.name}</td>
                      <td style={{ padding: '12px 10px' }}>
                        <StatusBadge label={h.type} bg={(TYPE_TONE[h.type] ?? TYPE_TONE.STATE).bg} color={(TYPE_TONE[h.type] ?? TYPE_TONE.STATE).color} />
                      </td>
                      <td style={{ padding: '12px 10px', fontSize: '12px' }}>
                        {!h.clientId ? <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>🌐 All Clients</span> : <span style={{ color: 'var(--warning)', fontWeight: 600 }}>🏦 {matchedClient?.name || 'Specific Client'}</span>}
                      </td>
                      <td style={{ padding: '12px 10px', color: 'var(--text-secondary)' }}>
                        {!h.applicableStates || h.applicableStates.length === 0 ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>🇮🇳 All India</span> : <span>🗺️ {h.applicableStates.join(', ')}</span>}
                      </td>
                      {canManage && (
                        <td style={{ padding: '12px 10px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                            <button aria-label="Edit holiday" onClick={() => handleOpenEdit(h)} style={{ padding: '4px 8px', background: 'rgba(216,174,71,0.1)', border: '1px solid rgba(216,174,71,0.3)', borderRadius: '4px', color: 'var(--accent)', cursor: 'pointer' }}><Edit2 size={12} /></button>
                            <button aria-label="Delete holiday" onClick={() => handleDelete(h.id)} style={{ padding: '4px 8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: '4px', color: 'var(--danger)', cursor: 'pointer' }}><Trash2 size={12} /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {showModal && canManage && (
        <Modal open onClose={() => setShowModal(false)} title={editingId ? 'Edit Holiday Record' : 'Add New Holiday'} width="500px" closeIcon={<X size={18} />} asForm onSubmit={handleSubmit}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary" disabled={submitting}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving…' : 'Save Holiday'}</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Client Scope (Optional)</label>
              <select value={clientId} onChange={(e) => setClientId(e.target.value)}
                style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }}>
                <option value="">🌐 All Clients (Global Holiday Calendar)</option>
                {clients.map((c: any) => <option key={c.id} value={c.id}>🏦 Specific Client: {c.name || c.code}</option>)}
              </select>
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Holiday Title</label>
              <input type="text" required placeholder="e.g. Maharashtra Day" value={name} onChange={(e) => setName(e.target.value)}
                style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Holiday Date</label>
                <input type="date" required value={date} onChange={(e) => setDate(e.target.value)}
                  style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Category Type</label>
                <select value={type} onChange={(e) => setType(e.target.value as Holiday['type'])}
                  style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }}>
                  {HOLIDAY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>

            {type === 'STATE' && (
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                  Applicable States <span style={{ fontWeight: 400 }}>(at least one — matching ignores case, so branch data spelled differently still matches)</span>
                </label>
                <input
                  type="text" placeholder="Search states…" value={stateSearch} onChange={(e) => setStateSearch(e.target.value)}
                  style={{ width: '100%', padding: '7px 9px', marginBottom: '6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '12px' }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '150px', overflowY: 'auto', padding: '8px', background: 'var(--bg-primary)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                  {filteredStateOptions.map((st) => {
                    const isSelected = selectedStates.includes(st.value);
                    return (
                      <button type="button" key={st.value} onClick={() => toggleState(st.value)}
                        style={{ padding: '4px 8px', borderRadius: '4px', fontSize: '11px', border: 'none', cursor: 'pointer', backgroundColor: isSelected ? 'var(--accent)' : 'var(--bg-tertiary)', color: isSelected ? 'var(--on-accent)' : 'var(--text-primary)' }}>
                        {isSelected ? `✓ ${st.label}` : st.label}
                      </button>
                    );
                  })}
                  {filteredStateOptions.length === 0 && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No match.</span>}
                </div>
              </div>
            )}
            {type !== 'STATE' && (
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                {type === 'NATIONAL' ? 'Applies across all states.' : 'Bank holiday — applies wherever this client audits, across all states.'}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};

export default Holidays;
