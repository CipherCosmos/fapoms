import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  X, Edit2, ArrowRightLeft, AlertTriangle, CheckCircle2,
  User, CreditCard, Award, Clock, MessageSquare, Phone, Mail, MapPin, KeyRound,
} from 'lucide-react';
import { nextAssayerLifecycleStates, AssayerLifecycleStatus, assayerLifecycleLabel, activityEventLabel } from '@fapoms/shared';

import { api } from '../../services/api';
import { Select } from '../../components/ui';
import type { Assayer } from './assayer-shared';
import {
  STATUS_COLORS, money, missingCriticalFields,
  fieldLabelStyle as label,
} from './assayer-shared';
import { fmtDate, fmtWhen } from '../../utils/dates';
import { userMessage } from '../../services/errors';
import { CommercialProfileModal, type CommercialProfile } from './CommercialProfileModal';
import { AssayerRemarks } from '../../components/AssayerRemarks';
// The capability page owns the wording for a workforce attribute's type; this tab reads it from
// there rather than keeping a second map that would drift. Both modules are lazy-loaded under /hr.
import { attributeTypeLabel } from './HrCapabilityPage';
import { todayDateKey, localDateKey } from '../../utils/statusLabels';

/** Whole days until a recorded expiry; null when nothing is recorded. */
const expiryDays = (iso?: string | null): number | null =>
  iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null;

/**
 * Everything about one person, in a slide-over.
 *
 * The old page put this in a fixed side panel, so reading someone's history meant
 * losing the list you were working through. A drawer keeps the roster underneath:
 * open, act, close, carry on down the list.
 *
 * Each tab loads only when first opened — the roster is the common case and should
 * not pay for five extra requests per row.
 *
 * This is now the ONLY view of a single assayer. A separate full-page profile used to exist
 * alongside it, reached from global search and the planning screen's excluded-candidates list;
 * both now open the roster with `?assayer=<id>`, which lands here. One person, one screen.
 */


const TABS = [
  { key: 'summary', label: 'Summary', icon: User },
  { key: 'commercial', label: 'Pay', icon: CreditCard },
  { key: 'skills', label: 'Skills', icon: Award },
  { key: 'remarks', label: 'Remarks', icon: MessageSquare },
  { key: 'history', label: 'History', icon: Clock },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/** Mirrors the server's list in AssayerService — moves that must say why. */
const LIFECYCLE_MOVES_NEEDING_A_REASON: string[] = [
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.INACTIVE,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
];

export const AssayerDetailDrawer: React.FC<{
  assayerId: string;
  canManage: boolean;
  onClose: () => void;
  onEdit: (a: Assayer) => void;
  onChanged: () => void;
}> = ({ assayerId, canManage, onClose, onEdit, onChanged }) => {
  const [a, setA] = useState<Assayer | null>(null);
  const [tab, setTab] = useState<TabKey>('summary');
  const [loaded, setLoaded] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
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
    // Remarks are fetched by <AssayerRemarks> itself (react-query), so the planning desk and
    // this drawer read one list from one API; only the other tabs load through here.
    const url: Partial<Record<TabKey, string>> = {
      commercial: `/assayers/${assayerId}/commercial`,
      skills: `/assayers/${assayerId}/workforce-attribute`,
      history: `/assayers/${assayerId}/activity`,
    };
    const tabUrl = url[tab];
    if (!tabUrl) return;
    api.request<any[]>(tabUrl)
      .then((d) => setLoaded((p) => ({ ...p, [tab]: Array.isArray(d) ? d : [] })))
      .catch(() => setLoaded((p) => ({ ...p, [tab]: [] })));
  }, [tab, assayerId, loaded]);

  const missing = useMemo(() => missingCriticalFields(a), [a]);

  /**
   * Skills, languages and certifications with the ones that stop working soonest at the top, and
   * the expired ones called out separately above the list. Server order was insertion order.
   */
  const sortedAttributes = useMemo(() => {
    const rows: any[] | undefined = loaded.skills;
    if (!rows) return rows;
    return [...rows].sort((x, y) => {
      const ex = x.expiryDate ? new Date(x.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      const ey = y.expiryDate ? new Date(y.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      if (ex !== ey) return ex - ey;
      return String(x.name).localeCompare(String(y.name));
    });
  }, [loaded.skills]);

  const lapsedCertifications = useMemo(
    () => (loaded.skills ?? []).filter((w: any) => {
      const d = expiryDays(w.expiryDate);
      return d !== null && d < 0;
    }),
    [loaded.skills],
  );

  /**
   * The pay structure that is actually being quoted today, and whether a later one is queued.
   * The list showed every profile with equal weight, so a superseded rate and the live one
   * looked the same — and the future-dated one at the top read as the current price.
   */
  const commercialRows = useMemo(() => {
    const rows: any[] | undefined = loaded.commercial;
    if (!rows) return rows;
    const today = todayDateKey();
    const withState = rows.map((c) => {
      const start = localDateKey(c.effectiveStartDate || c.startDate);
      const end = c.effectiveEndDate ? localDateKey(c.effectiveEndDate) : null;
      const state = start > today ? 'future' : end && end < today ? 'past' : 'current';
      return { ...c, __start: start, __state: state };
    });
    // Newest start first, matching the fee calculator's "latest profile effective on the date wins".
    return withState.sort((x, y) => (x.__start < y.__start ? 1 : x.__start > y.__start ? -1 : 0));
  }, [loaded.commercial]);

  const bankMissing = !!a && (!a.bankAccountNumber?.trim() || !a.ifscCode?.trim());

  const transitions = a ? nextAssayerLifecycleStates(a.lifecycleStatus) : [];

  /**
   * Suspension, deactivation, resignation and termination go on an employment record and are
   * what a later dispute or reference check is judged on, so the server refuses them without a
   * reason. Say so here rather than letting someone press Move and be told no.
   */
  const reasonRequired = LIFECYCLE_MOVES_NEEDING_A_REASON.includes(target);

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
      // The endpoint returns a pre-enveloped body ({ success, temporaryPassword, message }) with no
      // `data` key, so it must be read with withMeta — otherwise api.request unwraps `.data` (undefined)
      // and the one-time password, which the server never stores readably, is lost.
      const res = await api.request<{ temporaryPassword?: string }>(`/assayers/${assayerId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({}),
        withMeta: true,
      } as any);
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
                    <span style={{ color: tone, fontWeight: 700 }}>{assayerLifecycleLabel(a.lifecycleStatus)}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {[a.city, a.state].filter(Boolean).join(', ') || '—'}</span>
                  </div>
                </div>
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', height: 'fit-content' }}>
                  <X size={18} />
                </button>
              </div>

              <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
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

            <nav style={{ display: 'flex', gap: '2px', padding: '0 12px', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
              {TABS.map((t) => {
                const Icon = t.icon;
                const on = tab === t.key;
                return (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px', padding: '9px 11px',
                      fontSize: '12px', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                      whiteSpace: 'nowrap', flexShrink: 0,
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
                        <Select
                          value={target}
                          onChange={setTarget}
                          options={transitions.map((t) => ({ value: t, label: assayerLifecycleLabel(t) }))}
                          placeholder="Choose…"
                        />
                        <input value={reason} onChange={(e) => setReason(e.target.value)}
                          placeholder={reasonRequired ? 'Why? — goes on their record' : 'Reason (optional)'}
                          style={{ flex: 1, minWidth: '160px', padding: '7px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: `1px solid ${reasonRequired && !reason.trim() ? 'var(--warning)' : 'var(--border-color)'}` }} />
                        <button onClick={move} disabled={!target || busy || (reasonRequired && !reason.trim())} className="btn btn-primary" style={{ fontSize: '12px', padding: '7px 13px' }}>
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
                  {/*
                    Rates and banking are two different records — the rates live on the commercial
                    profile below, the account number and IFSC live on the assayer record itself,
                    behind Edit → Financial. Every one of the eight people on the roster has rates
                    but no bank details, which is what happens when a tab called "Pay" says nothing
                    at all about where the money is actually sent. It says so now, and the button
                    opens the same form on the same person.
                  */}
                  <div style={{
                    padding: '11px 13px', borderRadius: '8px', marginBottom: '12px',
                    background: bankMissing ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
                    border: `1px solid ${bankMissing ? 'rgba(216,174,71,0.25)' : 'var(--border-color)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 700, fontSize: '12.5px', color: bankMissing ? 'var(--warning)' : 'var(--success)' }}>
                      {bankMissing ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                      {bankMissing ? 'No bank details — cannot be paid' : 'Bank details on file'}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      {bankMissing
                        ? 'The rates below decide what this assayer earns; the account they are paid into is on their record, under Financial.'
                        : `Account ending ${String(a.bankAccountNumber).slice(-4)} · IFSC ${a.ifscCode}`}
                    </div>
                    {canManage && bankMissing && (
                      <button onClick={() => onEdit(a)} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '5px 10px', marginTop: '9px' }}>
                        Add bank details
                      </button>
                    )}
                  </div>
                  {canManage && (
                    <button onClick={() => setPayModal({ open: true, profile: null })}
                      className="btn btn-primary" style={{ fontSize: '12px', padding: '7px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CreditCard size={13} /> Add pay structure
                    </button>
                  )}
                  <List
                    rows={commercialRows}
                    empty="No pay structure recorded — this assayer cannot be billed or paid until one exists."
                    render={(c: any) => (
                      <div key={c.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--border-hair)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px' }}>
                          <div>
                            <strong>{money(c.baseFee)} base</strong>
                            {c.currency && <span style={{ color: 'var(--text-muted)', marginLeft: '5px' }}>{c.currency}</span>}
                            <span style={{
                              marginLeft: '7px', fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px',
                              background: c.__state === 'current' ? 'var(--status-active-bg)' : 'var(--bg-surface-2)',
                              color: c.__state === 'current' ? 'var(--success)' : c.__state === 'future' ? 'var(--accent)' : 'var(--text-muted)',
                            }}>
                              {c.__state === 'current' ? 'In force' : c.__state === 'future' ? 'Starts later' : 'Ended'}
                            </span>
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
                <>
                  {/*
                    An expired certification is refused by the eligibility gate, so the person is
                    quietly unassignable. Said here, at the top, rather than left to be worked out
                    from a date halfway down a list — with the way to fix it one click away.
                  */}
                  {lapsedCertifications.length > 0 && (
                    <div style={{ padding: '11px 13px', borderRadius: '8px', marginBottom: '12px', background: 'var(--status-cancelled-bg)', border: '1px solid rgba(220,80,80,0.3)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--danger)', fontWeight: 700, fontSize: '12.5px' }}>
                        <AlertTriangle size={14} /> {lapsedCertifications.length} certification(s) expired
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '5px' }}>
                        {lapsedCertifications.map((c: any) => c.name).join(', ')} — any branch that requires these will
                        refuse this assayer until the renewal date is recorded.
                      </div>
                      {canManage && (
                        <Link to={`/hr/skills?assayer=${assayerId}`} className="btn btn-secondary"
                          style={{ fontSize: '11.5px', padding: '5px 10px', marginTop: '9px', display: 'inline-block', textDecoration: 'none' }}>
                          Record the renewal
                        </Link>
                      )}
                    </div>
                  )}
                  <List
                    rows={sortedAttributes}
                    empty="No skills, languages or certifications recorded — planning cannot match this person on competency."
                    render={(w: any) => {
                      const days = expiryDays(w.expiryDate);
                      return (
                        <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--border-hair)', fontSize: '12.5px' }}>
                          {/* Was the raw column value — "CERTIFICATION" next to the name. */}
                          <span><strong>{w.name}</strong> <span style={{ ...label, marginLeft: '6px' }}>{attributeTypeLabel(w.type)}</span></span>
                          <span style={{ color: days !== null && days < 0 ? 'var(--danger)' : days !== null && days <= 30 ? 'var(--warning)' : 'var(--text-muted)', fontSize: '11.5px', whiteSpace: 'nowrap' }}>
                            {w.level ?? ''}
                            {w.expiryDate && (
                              days !== null && days < 0
                                ? ` · expired ${fmtDate(w.expiryDate)}`
                                : ` · expires ${fmtDate(w.expiryDate)}`
                            )}
                          </span>
                        </div>
                      );
                    }}
                  />
                </>
              )}

              {/*
                Rated, attributed staff remarks — the same component the planning desk shows in
                its assayer-detail modal, and the same figure the recommendation engine scores
                from. Who may write is decided by role inside the component (the operations desk
                can, not only HR), so it is deliberately not gated on `canManage`.
              */}
              {tab === 'remarks' && <AssayerRemarks assayerId={assayerId} />}

              {tab === 'history' && (
                <List
                  rows={loaded.history}
                  empty="Nothing recorded for this assayer yet. Status changes, assignments and HR updates will be listed here."
                  render={(h: any) => (
                    <div key={h.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-hair)' }}>
                      <div style={{ fontSize: '12.5px' }}>
                        {activityEventLabel(h.eventType)}
                        {/* Both ends of a lifecycle move are stored statuses, so both need the
                            shared wording — showing "Status changed — ON_LEAVE → ACTIVE" only
                            fixed half the line. */}
                        {(h.previousState || h.newState) && (
                          <> — {assayerLifecycleLabel(h.previousState)} → <strong>{assayerLifecycleLabel(h.newState)}</strong></>
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
