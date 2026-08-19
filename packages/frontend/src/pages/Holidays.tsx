import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Plus, Trash2, Edit2, ShieldAlert, X, ChevronLeft, ChevronRight, List, Grid3x3, Info, CopyPlus } from 'lucide-react';
import { INDIAN_STATES } from '@fapoms/shared';
import { api } from '../services/api';
import { useClientOptions } from '../hooks/useClients';
import { userMessage } from '../services/errors';
import { StatusBadge, Modal, AlertBanner, Select, useConfirm } from '../components/ui';
import type { ConfirmOptions } from '../components/ui';
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
  const { confirm, confirmDialog } = useConfirm();
  const [monthCursor, setMonthCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const yearFilter = monthCursor.getFullYear();
  const [clientFilter, setClientFilter] = useState<string>('ALL');
  const [showModal, setShowModal] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
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

  const { data: clientsRes } = useClientOptions();
  const clients = clientsRes ?? [];

  const { data: holidaysResponse, isLoading, refetch } = useQuery({
    queryKey: ['holidays', yearFilter, clientFilter],
    queryFn: () => api.request<Holiday[]>(`/holidays?year=${yearFilter}${clientFilter !== 'ALL' ? `&clientId=${clientFilter}` : ''}&limit=200`),
  });
  // Memoized so its identity is stable across renders — otherwise the `byDate` Map below rebuilt on
  // every render (form typing, etc.), not just when the data changed.
  const holidays = useMemo(
    // api.request unwraps the {success,data} envelope centrally now.
    () => holidaysResponse ?? [],
    [holidaysResponse],
  );

  const byDate = useMemo(() => {
    const m = new Map<string, Holiday[]>();
    for (const h of holidays) {
      // Local calendar key, matching the `toISODate` used for the grid cells below. The UTC
      // slice this replaces disagreed with the cells whenever the stored timestamp is local
      // midnight (18:30Z the previous day in IST), which parked the holiday on the day before
      // the one it is actually observed on.
      const key = toISODate(new Date(h.date));
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
    /*
     * Default to *today* while the calendar is showing the current month — which is what it
     * opens on and where nearly every holiday is registered from — instead of the 1st, which
     * was almost never the date wanted and had to be retyped every time. Browsing to another
     * month keeps the old behaviour (that month's 1st), since "today" is not in view there.
     */
    const today = new Date();
    const onCurrentMonth = yearFilter === today.getFullYear() && monthCursor.getMonth() === today.getMonth();
    setDate(prefillDate ?? toISODate(onCurrentMonth ? today : new Date(yearFilter, monthCursor.getMonth(), 1)));
    setShowModal(true);
  };

  const handleOpenEdit = (h: Holiday) => {
    setEditingId(h.id);
    setName(h.name);
    setDate(toISODate(new Date(h.date))); // local key — same reason as the byDate map above
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
      setError(`Operation failed. ${userMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Takes the whole record, not just its id, so the dialog can name the holiday being
  // deleted. The delete button sits in a dense table row; "Delete this holiday record?"
  // gave the user no way to tell which row their click had landed on.
  const handleDelete = async (h: Holiday) => {
    const ok = await confirm({
      title: `Delete "${h.name}"?`,
      message: 'This holiday will no longer block scheduling on that date.',
      confirmLabel: 'Delete holiday',
      reversible: false,
      tone: 'danger',
      confirmPhrase: h.name,
    });
    if (!ok) return;
    try {
      await api.request(`/holidays/${h.id}`, { method: 'DELETE' });
      setSuccess('Holiday deleted.');
      refetch();
    } catch (err: any) {
      setError(`Delete failed. ${userMessage(err)}`);
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
      {confirmDialog}
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
          <Select
            value={clientFilter}
            onChange={setClientFilter}
            options={[
              { value: 'ALL', label: '🏦 All Clients (Global Scope)' },
              ...clients.map((c: any) => ({ value: c.id, label: `🏦 Client: ${c.name || c.code}` })),
            ]}
          />
          {canManage && (
            <>
              {/* Most of a year's calendar is last year's calendar with new dates. Retyping
                  forty holidays each January is where the typos and the omissions came from. */}
              <button onClick={() => setShowCopy(true)} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
                <CopyPlus size={14} /> Copy from {yearFilter - 1}
              </button>
              <button onClick={() => handleOpenCreate()} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
                <Plus size={14} /> Add Holiday
              </button>
            </>
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
              {/* An empty year is exactly the moment the copy is wanted, so offer it here
                  rather than making the user find the button in the toolbar. */}
              {canManage && (
                <button onClick={() => setShowCopy(true)} className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
                  <CopyPlus size={14} /> Copy {yearFilter - 1}'s holidays into {yearFilter}
                </button>
              )}
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
                            <button aria-label="Delete holiday" onClick={() => handleDelete(h)} style={{ padding: '4px 8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: '4px', color: 'var(--danger)', cursor: 'pointer' }}><Trash2 size={12} /></button>
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

      {showCopy && canManage && (
        <CopyLastYearModal
          targetYear={yearFilter}
          clientFilter={clientFilter}
          existing={holidays}
          confirm={confirm}
          onClose={() => setShowCopy(false)}
          onDone={(msg, tone) => {
            if (tone === 'error') setError(msg); else setSuccess(msg);
            setShowCopy(false);
            refetch();
          }}
        />
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
              <Select
                value={clientId}
                onChange={setClientId}
                options={[
                  { value: '', label: '🌐 All Clients (Global Holiday Calendar)' },
                  ...clients.map((c: any) => ({ value: c.id, label: `🏦 Specific Client: ${c.name || c.code}` })),
                ]}
                style={{ width: '100%' }}
              />
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
                <Select
                  value={type}
                  onChange={(v) => setType(v as Holiday['type'])}
                  options={HOLIDAY_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                  style={{ width: '100%' }}
                />
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

/**
 * Bring last year's holidays forward.
 *
 * Nearly every holiday on the calendar is the same holiday it was last year, so each January
 * somebody retyped forty records — which is where the omissions and the misspelt names came
 * from, and there was nothing on the empty year to suggest a better way.
 *
 * Three things this deliberately does NOT do:
 *
 * - It does not create anything on open. The list is a *preview*: every row can be unticked,
 *   and nothing is written until the confirm dialog is accepted.
 * - It does not guess a date. A holiday is copied to the same calendar day (same month, same
 *   date) of the target year, and the new weekday is shown beside it, because many Indian
 *   holidays follow a lunar calendar and genuinely move. Silently shifting them to "the same
 *   Monday" would be inventing a fact; showing the weekday lets the person fix the ones that
 *   moved, afterwards, in the normal edit form.
 * - It does not re-create what is already there. A holiday whose name is already registered in
 *   the target year is listed as already present and cannot be ticked, so pressing the button
 *   twice cannot double the calendar.
 *
 * Records are created one at a time (the API takes one holiday per request) which is why the
 * button counts "12 of 40" rather than spinning — the count is real, so it is shown.
 */
const CopyLastYearModal: React.FC<{
  targetYear: number;
  clientFilter: string;
  existing: Holiday[];
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  onClose: () => void;
  onDone: (message: string, tone: 'success' | 'error') => void;
}> = ({ targetYear, clientFilter, existing, confirm, onClose, onDone }) => {
  const sourceYear = targetYear - 1;
  const [source, setSource] = useState<Holiday[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  /** `null` = not running. Otherwise the honest "n of total" the create loop has reached. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Same client scope as the page behind it — copying a global calendar into a client-specific
  // one (or the reverse) would put holidays where nobody asked for them.
  useEffect(() => {
    let cancelled = false;
    api.request<Holiday[]>(`/holidays?year=${sourceYear}${clientFilter !== 'ALL' ? `&clientId=${clientFilter}` : ''}&limit=200`)
      .then((r) => { if (!cancelled) setSource(Array.isArray(r) ? r : []); })
      .catch((e) => { if (!cancelled) { setSource([]); setLoadError(userMessage(e)); } });
    return () => { cancelled = true; };
  }, [sourceYear, clientFilter]);

  /** Names already registered in the target year, compared case-insensitively and trimmed. */
  const alreadyThere = useMemo(
    () => new Set(existing.map((h) => h.name.trim().toLowerCase())),
    [existing],
  );

  const rows = useMemo(() => {
    return (source ?? [])
      .map((h) => {
        const d = new Date(h.date);
        // Same month and date, next year. `new Date(y, m, d)` rolls 29 Feb into 1 March by
        // itself, which is the right answer here: the holiday still needs a day, and the
        // person can move it.
        const moved = new Date(targetYear, d.getMonth(), d.getDate());
        return { source: h, newDate: moved, exists: alreadyThere.has(h.name.trim().toLowerCase()) };
      })
      .sort((a, b) => a.newDate.getTime() - b.newDate.getTime());
  }, [source, targetYear, alreadyThere]);

  // Everything that is not already registered starts ticked — the common case is "bring all of
  // it forward" — but the ticks are the user's to change before anything happens.
  useEffect(() => {
    setChosen(new Set(rows.filter((r) => !r.exists).map((r) => r.source.id)));
  }, [rows]);

  const copyable = rows.filter((r) => !r.exists);
  const selected = rows.filter((r) => chosen.has(r.source.id) && !r.exists);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const run = async () => {
    const ok = await confirm({
      title: `Create ${selected.length} holiday${selected.length === 1 ? '' : 's'} for ${targetYear}?`,
      message: `Each one is copied to the same calendar day of ${targetYear}. Nothing already registered for ${targetYear} is touched, and any date that moved this year can be edited afterwards.`,
      confirmLabel: `Create ${selected.length}`,
    });
    if (!ok) return;

    setProgress({ done: 0, total: selected.length });
    const failed: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      const r = selected[i];
      try {
        await api.request('/holidays', {
          method: 'POST',
          body: JSON.stringify({
            name: r.source.name,
            date: toISODate(r.newDate),
            type: r.source.type,
            applicableStates: r.source.type === 'STATE' ? (r.source.applicableStates ?? []) : [],
            clientId: r.source.clientId || null,
          }),
        });
      } catch (e) {
        // Keep going: one rejected row should not abandon the other thirty-nine, and the names
        // that failed are reported so they can be added by hand.
        failed.push(`${r.source.name} (${userMessage(e)})`);
      }
      setProgress({ done: i + 1, total: selected.length });
    }
    setProgress(null);

    const created = selected.length - failed.length;
    if (failed.length === 0) {
      onDone(`${created} holiday${created === 1 ? '' : 's'} created for ${targetYear}.`, 'success');
    } else {
      onDone(`${created} of ${selected.length} created. Could not create: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? '…' : ''}`, 'error');
    }
  };

  return (
    <Modal
      open
      onClose={progress ? () => undefined : onClose}
      title={`Copy ${sourceYear} holidays into ${targetYear}`}
      width="620px"
      closeIcon={<X size={18} />}
      footer={
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '10px' }}>
          {progress && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: 'auto', fontVariantNumeric: 'tabular-nums' }}>
              Creating {progress.done} of {progress.total}…
            </span>
          )}
          <button type="button" onClick={onClose} className="btn btn-secondary" disabled={!!progress}>Cancel</button>
          <button type="button" onClick={run} className="btn btn-primary" disabled={!!progress || selected.length === 0}>
            {progress ? `${progress.done} of ${progress.total}…` : `Create ${selected.length} holiday${selected.length === 1 ? '' : 's'}`}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
          Nothing is created until you press the button below. Each holiday is copied to the same
          calendar day of {targetYear} — check the weekday, since holidays that follow the lunar
          calendar move from year to year and will need editing afterwards.
        </p>

        {loadError && <AlertBanner type="error">{`Could not read ${sourceYear}'s holidays. ${loadError}`}</AlertBanner>}

        {source === null ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Reading {sourceYear}…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            Nothing registered for {sourceYear} in this client scope, so there is nothing to bring forward.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12px' }}>
              <button type="button" disabled={!!progress}
                onClick={() => setChosen(new Set(copyable.map((r) => r.source.id)))}
                className="btn btn-secondary" style={{ fontSize: '11px', padding: '5px 10px' }}>Select all</button>
              <button type="button" disabled={!!progress}
                onClick={() => setChosen(new Set())}
                className="btn btn-secondary" style={{ fontSize: '11px', padding: '5px 10px' }}>Select none</button>
              <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {selected.length} of {copyable.length} selected
                {rows.length - copyable.length > 0 && ` · ${rows.length - copyable.length} already registered for ${targetYear}`}
              </span>
            </div>

            <div style={{ maxHeight: '340px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
              {rows.map((r) => {
                const tone = TYPE_TONE[r.source.type] ?? TYPE_TONE.STATE;
                return (
                  <label key={r.source.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', fontSize: '12.5px',
                      borderBottom: '1px solid var(--border-hair)',
                      cursor: r.exists || progress ? 'default' : 'pointer',
                      opacity: r.exists ? 0.55 : 1,
                    }}>
                    <input type="checkbox" checked={chosen.has(r.source.id) && !r.exists}
                      disabled={r.exists || !!progress}
                      onChange={() => toggle(r.source.id)} />
                    <span style={{ fontWeight: 600, flex: 1 }}>{r.source.name}</span>
                    <StatusBadge label={r.source.type} bg={tone.bg} color={tone.color} />
                    <span style={{ color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap', minWidth: '150px', textAlign: 'right' }}>
                      {r.newDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                    {r.exists && <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>already registered</span>}
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default Holidays;
