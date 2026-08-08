import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X, ExternalLink, Edit2, ArrowRightLeft, Send, AlertTriangle, CheckCircle2,
  User, CreditCard, Award, Clock, MessageSquare, Phone, Mail, MapPin, KeyRound,
} from 'lucide-react';
import { formatRupees, nextAssayerLifecycleStates } from '@fapoms/shared';

import { api } from '../../services/api';
import type { Assayer } from './assayer-shared';
import { STATUS_COLORS } from './assayer-shared';
import { userMessage } from '../../services/errors';
import { CommercialProfileModal, type CommercialProfile } from './CommercialProfileModal';

/**
 * Everything about one person, in a slide-over.
 *
 * The old page put this in a fixed side panel, so reading someone's history meant
 * losing the list you were working through. A drawer keeps the roster underneath:
 * open, act, close, carry on down the list.
 *
 * Each tab loads only when first opened — the roster is the common case and should
 * not pay for five extra requests per row.
 */


const CRITICAL: { key: keyof Assayer; label: string; why: string }[] = [
  { key: 'panNumber', label: 'PAN', why: 'TDS and statutory filing' },
  { key: 'bankAccountNumber', label: 'Bank account', why: 'Payouts' },
  { key: 'ifscCode', label: 'IFSC', why: 'Payouts' },
  { key: 'joiningDate', label: 'Joining date', why: 'Tenure and settlement' },
  { key: 'emergencyContactPhone', label: 'Emergency contact', why: 'Duty of care' },
];

const TABS = [
  { key: 'summary', label: 'Summary', icon: User },
  { key: 'commercial', label: 'Pay', icon: CreditCard },
  { key: 'skills', label: 'Skills', icon: Award },
  { key: 'remarks', label: 'Remarks', icon: MessageSquare },
  { key: 'history', label: 'History', icon: Clock },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtWhen = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
// Keeps this screen's em-dash-for-unknown behaviour, now expressed through the shared formatter.
const money = (n?: number | null) => formatRupees(n, { emptyAs: '—' });

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

export const AssayerDetailDrawer: React.FC<{
  assayerId: string;
  canManage: boolean;
  onClose: () => void;
  onEdit: (a: Assayer) => void;
  onChanged: () => void;
}> = ({ assayerId, canManage, onClose, onEdit, onChanged }) => {
  const navigate = useNavigate();
  const [a, setA] = useState<Assayer | null>(null);
  const [tab, setTab] = useState<TabKey>('summary');
  const [loaded, setLoaded] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [remark, setRemark] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [payModal, setPayModal] = useState<{ open: boolean; profile: CommercialProfile | null }>({ open: false, profile: null });

  useEffect(() => {
    api.request<Assayer>(`/assayers/${assayerId}`)
      .then(setA)
      .catch((e) => setErr(userMessage(e)));
  }, [assayerId]);

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab === 'summary' || loaded[tab] !== undefined) return;
    const url = {
      commercial: `/assayers/${assayerId}/commercial`,
      skills: `/assayers/${assayerId}/workforce-attribute`,
      remarks: `/assayers/${assayerId}/remark`,
      history: `/assayers/${assayerId}/activity`,
    }[tab];
    if (!url) return;
    api.request<any[]>(url)
      .then((d) => setLoaded((p) => ({ ...p, [tab]: Array.isArray(d) ? d : [] })))
      .catch(() => setLoaded((p) => ({ ...p, [tab]: [] })));
  }, [tab, assayerId, loaded]);

  const missing = useMemo(
    () => (a ? CRITICAL.filter((f) => { const v = a[f.key]; return v == null || String(v).trim() === ''; }) : []),
    [a],
  );

  const transitions = a ? nextAssayerLifecycleStates(a.lifecycleStatus) : [];

  const move = async () => {
    if (!target) return;
    setBusy(true); setErr(null);
    try {
      await api.request(`/assayers/${assayerId}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: target, reason: reason || `Moved to ${target}` }),
      });
      const fresh = await api.request<Assayer>(`/assayers/${assayerId}`);
      setA(fresh);
      setTarget(''); setReason('');
      setLoaded((p) => ({ ...p, history: undefined }));
      onChanged();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  const addRemark = async () => {
    if (!remark.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.request(`/assayers/${assayerId}/remark`, {
        method: 'POST',
        body: JSON.stringify({ content: remark, category: 'GENERAL', visibility: 'INTERNAL' }),
      });
      setRemark('');
      const fresh = await api.request<any[]>(`/assayers/${assayerId}/remark`);
      setLoaded((p) => ({ ...p, remarks: Array.isArray(fresh) ? fresh : [] }));
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  /**
   * Recovery for a field worker who is locked out — they enter client bank vaults on a
   * schedule, so "come back tomorrow" is a missed audit. HR generates a temporary password the
   * server returns exactly once; it is read to the assayer and forces a change at next sign-in.
   */
  const resetPassword = async () => {
    if (resetting) return;
    setResetting(true); setErr(null); setTempPassword(null);
    try {
      const res = await api.request<{ temporaryPassword?: string }>(`/assayers/${assayerId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setTempPassword(res.temporaryPassword ?? '(set, but not returned)');
    } catch (e) { setErr(userMessage(e)); }
    setResetting(false);
  };

  const tone = a ? STATUS_COLORS[a.lifecycleStatus] ?? 'var(--text-muted)' : 'var(--text-muted)';

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60 }} />
      <aside
        role="dialog"
        aria-label="Assayer detail"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 100vw)', zIndex: 61,
          background: 'var(--bg-card)', borderLeft: '1px solid var(--border-color)',
          display: 'flex', flexDirection: 'column', boxShadow: '-16px 0 40px rgba(0,0,0,0.4)',
        }}
      >
        {!a ? (
          <div style={{ padding: '28px' }}>{err ?? 'Loading…'}</div>
        ) : (
          <>
            <header style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>{a.displayName}</h2>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '5px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    <span style={{ fontFamily: 'monospace' }}>{a.assayerCode}</span>
                    <span style={{ color: tone, fontWeight: 700 }}>{(a.lifecycleStatus ?? '').replace(/_/g, ' ')}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {[a.city, a.state].filter(Boolean).join(', ') || '—'}</span>
                  </div>
                </div>
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', height: 'fit-content' }}>
                  <X size={18} />
                </button>
              </div>

              <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
                <button onClick={() => navigate(`/assayers/${a.id}`)} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <ExternalLink size={12} /> Full profile
                </button>
                {canManage && (
                  <button onClick={() => onEdit(a)} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <Edit2 size={12} /> Edit
                  </button>
                )}
                {a.phone && (
                  <a href={`tel:${a.phone}`} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
                    <Phone size={12} /> Call
                  </a>
                )}
                {a.email && (
                  <a href={`mailto:${a.email}`} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
                    <Mail size={12} /> Email
                  </a>
                )}
              </div>
            </header>

            <nav style={{ display: 'flex', gap: '2px', padding: '0 12px', borderBottom: '1px solid var(--border-color)' }}>
              {TABS.map((t) => {
                const Icon = t.icon;
                const on = tab === t.key;
                return (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px', padding: '9px 11px',
                      fontSize: '12px', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                      color: on ? 'var(--accent)' : 'var(--text-muted)',
                      borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    }}>
                    <Icon size={12} /> {t.label}
                  </button>
                );
              })}
            </nav>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
              {err && (
                <div style={{ padding: '9px 12px', borderRadius: '7px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '12px', marginBottom: '12px' }}>
                  {err}
                </div>
              )}

              {tab === 'summary' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {missing.length > 0 && (
                    <div style={{ padding: '11px 13px', borderRadius: '8px', background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.25)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--warning)', fontWeight: 700, fontSize: '12.5px' }}>
                        <AlertTriangle size={14} /> {missing.length} required field(s) missing
                      </div>
                      <ul style={{ margin: '7px 0 0', paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {missing.map((f) => <li key={String(f.key)}>{f.label} — blocks {f.why.toLowerCase()}</li>)}
                      </ul>
                      {canManage && (
                        <button onClick={() => onEdit(a)} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '5px 10px', marginTop: '9px' }}>
                          Fill them in
                        </button>
                      )}
                    </div>
                  )}
                  {missing.length === 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--success)', fontSize: '12.5px' }}>
                      <CheckCircle2 size={14} /> Record complete — payroll and duty-of-care fields are all present.
                    </div>
                  )}

                  {canManage && transitions.length > 0 && (
                    <section>
                      <div style={{ ...label, marginBottom: '7px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <ArrowRightLeft size={11} /> Move to next stage
                      </div>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <select value={target} onChange={(e) => setTarget(e.target.value)}
                          style={{ padding: '7px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}>
                          <option value="">Choose…</option>
                          {transitions.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                        </select>
                        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)"
                          style={{ flex: 1, minWidth: '160px', padding: '7px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }} />
                        <button onClick={move} disabled={!target || busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '7px 13px' }}>
                          {busy ? 'Moving…' : 'Move'}
                        </button>
                      </div>
                    </section>
                  )}

                  {canManage && (
                    <section>
                      <div style={{ ...label, marginBottom: '7px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <KeyRound size={11} /> Account access
                      </div>
                      {tempPassword ? (
                        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--status-active-bg)', border: '1px solid var(--success)' }}>
                          <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                            Temporary password — read it to the assayer now, it will not be shown again:
                          </div>
                          <code style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em', color: 'var(--success)', userSelect: 'all' }}>{tempPassword}</code>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '5px' }}>
                            They will be asked to choose their own at next sign-in.
                          </div>
                        </div>
                      ) : (
                        <button onClick={resetPassword} disabled={resetting} className="btn btn-secondary" style={{ fontSize: '12px', padding: '7px 13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <KeyRound size={13} /> {resetting ? 'Resetting…' : 'Reset password'}
                        </button>
                      )}
                    </section>
                  )}

                  <Facts rows={[
                    ['Phone', a.phone], ['Alternate', a.alternatePhone], ['Email', a.email],
                    ['Address', a.address], ['District', a.district], ['Pincode', a.pincode],
                    ['Employment', a.employmentType], ['Employee ID', a.employeeId],
                    ['Department', a.department], ['Region', a.region],
                    ['Joined', fmtDate(a.joiningDate)], ['Experience', `${a.experienceYears ?? 0} years`],
                    ['Max daily load', a.maxDailyWorkload], ['Max weekly load', a.maxWeeklyWorkload],
                    ['Emergency contact', a.emergencyContactName], ['Emergency phone', a.emergencyContactPhone],
                  ]} />
                </div>
              )}

              {tab === 'commercial' && (
                <div>
                  {canManage && (
                    <button onClick={() => setPayModal({ open: true, profile: null })}
                      className="btn btn-primary" style={{ fontSize: '12px', padding: '7px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CreditCard size={13} /> Add pay structure
                    </button>
                  )}
                  <List
                    rows={loaded.commercial}
                    empty="No pay structure recorded — this assayer cannot be billed or paid until one exists."
                    render={(c: any) => (
                      <div key={c.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--border-hair)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px' }}>
                          <div>
                            <strong>{money(c.baseFee)} base</strong>
                            {c.currency && <span style={{ color: 'var(--text-muted)', marginLeft: '5px' }}>{c.currency}</span>}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>
                              {fmtDate(c.effectiveStartDate || c.startDate)} → {c.effectiveEndDate ? fmtDate(c.effectiveEndDate) : 'open'}
                            </span>
                            {canManage && (
                              <button onClick={() => setPayModal({ open: true, profile: c })}
                                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                <Edit2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                          {money(c.hourlyRate)}/hr · {money(c.dailyRate)}/day · travel {money(c.travelReimbursement)}
                          {Number(c.accommodationAllowance) > 0 && <> · stay {money(c.accommodationAllowance)}</>}
                          {Number(c.mealAllowance) > 0 && <> · meals {money(c.mealAllowance)}</>}
                        </div>
                      </div>
                    )}
                  />
                </div>
              )}

              {tab === 'skills' && (
                <List
                  rows={loaded.skills}
                  empty="No skills, languages or certifications recorded — planning cannot match this person on competency."
                  render={(w: any) => (
                    <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-hair)', fontSize: '12.5px' }}>
                      <span><strong>{w.name}</strong> <span style={{ ...label, marginLeft: '6px' }}>{w.type}</span></span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>
                        {w.level ?? ''}{w.expiryDate ? ` · expires ${fmtDate(w.expiryDate)}` : ''}
                      </span>
                    </div>
                  )}
                />
              )}

              {tab === 'remarks' && (
                <div>
                  {canManage && (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
                      <input value={remark} onChange={(e) => setRemark(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addRemark(); }}
                        placeholder="Add a remark…"
                        style={{ flex: 1, padding: '8px 11px', fontSize: '12.5px', borderRadius: '7px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }} />
                      <button onClick={addRemark} disabled={!remark.trim() || busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '8px 12px' }}>
                        <Send size={12} />
                      </button>
                    </div>
                  )}
                  <List
                    rows={loaded.remarks}
                    empty="No remarks yet."
                    render={(r: any) => (
                      <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-hair)' }}>
                        <div style={{ fontSize: '12.5px' }}>{r.content}</div>
                        <div style={{ ...label, marginTop: '4px' }}>
                          {r.authorName ?? 'system'} · {fmtWhen(r.createdAt)}{r.category ? ` · ${r.category}` : ''}
                        </div>
                      </div>
                    )}
                  />
                </div>
              )}

              {tab === 'history' && (
                <List
                  rows={loaded.history}
                  empty="No recorded activity."
                  render={(h: any) => (
                    <div key={h.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-hair)' }}>
                      <div style={{ fontSize: '12.5px' }}>
                        {(h.eventType ?? '').replace(/_/g, ' ').toLowerCase()}
                        {(h.previousState || h.newState) && (
                          <> — {h.previousState ?? '—'} → <strong>{h.newState ?? '—'}</strong></>
                        )}
                      </div>
                      <div style={{ ...label, marginTop: '4px' }}>
                        {h.performedByName ?? 'system'} · {fmtWhen(h.occurredAt)}
                      </div>
                      {h.remarks && <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '3px' }}>{h.remarks}</div>}
                    </div>
                  )}
                />
              )}
            </div>
          </>
        )}
      </aside>
      <CommercialProfileModal
        open={payModal.open}
        onClose={() => setPayModal({ open: false, profile: null })}
        assayerId={assayerId}
        profile={payModal.profile}
        onSaved={() => {
          setLoaded((p) => ({ ...p, commercial: undefined }));
          api.request<any[]>(`/assayers/${assayerId}/commercial`)
            .then((d) => setLoaded((p) => ({ ...p, commercial: Array.isArray(d) ? d : [] })))
            .catch(() => setLoaded((p) => ({ ...p, commercial: [] })));
        }}
      />
    </>
  );
};

const Facts: React.FC<{ rows: [string, any][] }> = ({ rows }) => (
  <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '11px', margin: 0 }}>
    {rows.map(([k, v]) => (
      <div key={k}>
        <dt style={label}>{k}</dt>
        <dd style={{ margin: '2px 0 0', fontSize: '12.5px' }}>
          {v === null || v === undefined || v === '' ? <span style={{ color: 'var(--text-muted)' }}>—</span> : String(v)}
        </dd>
      </div>
    ))}
  </dl>
);

/** Shared loading/empty handling so each tab does not reinvent it. */
const List: React.FC<{ rows: any[] | undefined; empty: string; render: (r: any) => React.ReactNode }> = ({
  rows, empty, render,
}) => {
  if (rows === undefined) return <div style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', padding: '18px 0' }}>{empty}</div>;
  return <>{rows.map(render)}</>;
};

export default AssayerDetailDrawer;
