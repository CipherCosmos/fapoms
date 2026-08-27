import React, { useEffect, useMemo, useState } from 'react';
import {
  Edit2, ArrowRightLeft, AlertTriangle, CheckCircle2,
  User, CreditCard, Award, Clock, MessageSquare, Phone, Mail, MapPin, KeyRound, ShieldCheck, FileCheck,
} from 'lucide-react';
import { nextAssayerLifecycleStates, AssayerLifecycleStatus, assayerLifecycleLabel, activityEventLabel, employmentTypeLabel, AssayerEngagementType, AssayerUnavailableReason } from '@fapoms/shared';

import { api } from '../../services/api';
import { Select, useConfirm } from '../../components/ui';
import type { Assayer } from './assayer-shared';
import {
  STATUS_COLORS, money, missingCriticalFields,
  fieldLabelStyle as label,
} from './assayer-shared';
import { fmtDate, fmtWhen } from '../../utils/dates';
import { userMessage } from '../../services/errors';
import { CommercialProfileModal, type CommercialProfile } from './CommercialProfileModal';
import { AssayerRemarks } from '../../components/AssayerRemarks';
import { AssayerVettingTab } from './AssayerVettingTab';
import { AssayerSkillsPanel } from './AssayerSkillsPanel';
import { todayDateKey, localDateKey } from '../../utils/statusLabels';
import { counted } from '../../utils/plural';

/**
 * How they are engaged, and why they are not available — the two halves of the roster's
 * "Active / Inactive" column, which was one cell holding several separate facts.
 */
const ENGAGEMENT_LABELS: Record<string, string> = {
  [AssayerEngagementType.REGULAR]: 'Regular',
  [AssayerEngagementType.LOCAL]: 'Local',
  [AssayerEngagementType.BACK_UP]: 'Back-up',
  [AssayerEngagementType.AGENCY_AUDIT]: 'Agency audits',
  [AssayerEngagementType.MYSTERY_AUDIT]: 'Mystery audits',
};

const UNAVAILABLE_LABELS: Record<string, string> = {
  [AssayerUnavailableReason.REJECTED_BY_US]: 'We rejected them',
  [AssayerUnavailableReason.NOT_INTERESTED]: 'Not interested',
  // The spreadsheet's word for this is "Expired"; it means the person has died, and the record
  // should not say "expired" to whoever opens it next.
  [AssayerUnavailableReason.DECEASED]: 'Deceased',
  [AssayerUnavailableReason.NO_WORK_IN_AREA]: 'No work in their area',
  [AssayerUnavailableReason.MOVED_ABROAD]: 'Moved out of India',
  [AssayerUnavailableReason.MOVED_TO_COMPANY]: 'Now engaged through a company',
};

/**
 * Aadhaar shown as the last four digits only.
 *
 * Enough to confirm which document is on file, which is the only reason this screen shows it.
 * The whole number is a KYC identifier and is reachable through the edit form by the two roles
 * entitled to it — printing it on a summary anyone with the record open can read over is not.
 */
const maskAadhaar = (v?: string | null): string | null => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••• •••• ${digits.slice(-4)}` : null;
};

/**
 * Everything about one person, on its own page.
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
  // Two tabs over one fetch. They answer one question together — may we send this person out,
  // and to whom — but they are looked for by different names: somebody chasing a missing NDA
  // goes looking for "Documents", and nobody goes looking for it under "Vetting".
  { key: 'vetting', label: 'Vetting', icon: ShieldCheck },
  { key: 'documents', label: 'Documents', icon: FileCheck },
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

/**
 * What each stage actually does to the person, in the words an office user needs.
 *
 * The dropdown offered "Suspended", "Archived", "Inactive" and so on and stopped there. Those are
 * HR's words for a filing state; what a clerk needs to know before pressing Move is whether the
 * person can still be given work tomorrow, and whether they can be put back. Nothing on this
 * screen said so — someone picking "Inactive" to park a person for a fortnight had no way to learn
 * they had just taken them out of every planning list, and the difference between "Resigned" and
 * "Terminated" on a permanent employment record was left to be guessed from the word alone.
 */
export const STAGE_CONSEQUENCE: Record<string, string> = {
  [AssayerLifecycleStatus.INVITED]: 'They are back at the start of joining and cannot be given work.',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'They wait for their documents to be checked and cannot be given work yet.',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'They wait for their background check and cannot be given work yet.',
  [AssayerLifecycleStatus.TRAINING]: 'They are in training and cannot be given work yet.',
  [AssayerLifecycleStatus.ACTIVE]: 'They can be planned, offered work and paid from now on.',
  [AssayerLifecycleStatus.ON_LEAVE]: 'They stay on the roster but are not offered work until they are made Active again.',
  [AssayerLifecycleStatus.SUSPENDED]: 'They are blocked from all work immediately. This goes on their employment record.',
  [AssayerLifecycleStatus.INACTIVE]: 'They stop appearing for planning and receive no new work.',
  [AssayerLifecycleStatus.RESIGNED]: 'They are recorded as having left of their own accord, and are removed from all planning.',
  [AssayerLifecycleStatus.TERMINATED]: 'They are recorded as dismissed by the company, and are removed from all planning.',
  [AssayerLifecycleStatus.ARCHIVED]: 'Their record is closed and filed away. They will no longer appear on the working roster.',
};

/** Moves that go on a permanent employment record or end the working relationship. */
export const HARD_TO_REVERSE_STAGES: string[] = [
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
];

/**
 * Their face, where a name alone used to be.
 *
 * Field staff are dispatched to bank branches by people who have never met them, and every
 * record already had somewhere to keep a photograph — it just had no way to put one there and
 * nowhere to show it. Uploaded on the Documents tab, under Photograph.
 *
 * Fetched as a blob because the route needs an Authorization header, and a 404 is the ordinary
 * case rather than an error: most records have no photograph, and initials are a better answer
 * than a broken image.
 */
const Photograph: React.FC<{ assayerId: string; name: string }> = ({ assayerId, name }) => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.request<Blob>(`/assayers/${assayerId}/photo`, { raw: true })
      .then((b) => { if (!live) return; made = URL.createObjectURL(b); setUrl(made); })
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [assayerId]);

  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const box: React.CSSProperties = {
    width: '46px', height: '46px', borderRadius: '50%', flexShrink: 0,
    border: '1px solid var(--border-color)', objectFit: 'cover',
  };

  if (!url) {
    return (
      <div
        style={{
          ...box, background: 'var(--bg-surface-2)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: '15px', fontWeight: 700, color: 'var(--text-muted)',
        }}
        aria-hidden
      >
        {initials || '—'}
      </div>
    );
  }
  return <img src={url} alt={`Photograph of ${name}`} style={box} />;
};

export const AssayerRecord: React.FC<{
  assayerId: string;
  canManage: boolean;
  onClose: () => void;
  onEdit: (a: Assayer) => void;
  onChanged: () => void;
  /**
   * Bumped by the roster whenever this record has been changed anywhere — an edit saved, a
   * lifecycle move, a bulk action.
   *
   * Without it this panel read the record once, when it opened, and never again. So an edit
   * saved correctly and the drawer behind it went on showing the old values until the page was
   * reloaded: the change was in the database and not on the screen, which is indistinguishable
   * from a save that silently did nothing.
   */
  reloadKey?: number;
}> = ({ assayerId, canManage, onClose, onEdit, onChanged, reloadKey = 0 }) => {
  const [a, setA] = useState<Assayer | null>(null);
  const [tab, setTab] = useState<TabKey>('summary');
  const [loaded, setLoaded] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [payModal, setPayModal] = useState<{ open: boolean; profile: CommercialProfile | null }>({ open: false, profile: null });
  const { confirm, confirmDialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    api.request<Assayer>(`/assayers/${assayerId}`)
      .then((fresh) => { if (!cancelled) setA(fresh); })
      .catch((e) => { if (!cancelled) setErr(userMessage(e)); });
    return () => { cancelled = true; };
  }, [assayerId, reloadKey]);

  // The per-tab panels are cached in `loaded`; a change to the record invalidates that cache
  // too, or the Pay and Skills tabs keep serving what they fetched before the edit.
  useEffect(() => { setLoaded({}); }, [assayerId, reloadKey]);

  // Escape goes back to the list. It closed the drawer this used to be, and the habit outlives
  // the drawer; the page carries a Back link for everyone else.
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

  /**
   * Moving someone's stage, with the consequence stated before it happens.
   *
   * This used to fire on one click of a button labelled "Move". Suspending, dismissing or
   * archiving a person are all one dropdown pick away from each other, they all take effect on the
   * live roster the moment the button is pressed, and none of them can be taken back by picking
   * the previous stage again — the state machine does not run backwards. So the moves that end
   * someone's work now ask first, in a dialog that names the person and says what happens to them.
   * Routine moves (Active, On Leave, the joining steps) are still one click, because making a
   * clerk confirm every ordinary step is how people learn to click through dialogs unread.
   */
  const move = async () => {
    if (!target) return;
    if (a && HARD_TO_REVERSE_STAGES.includes(target)) {
      const ok = await confirm({
        title: `Move ${a.displayName} to ${assayerLifecycleLabel(target)}?`,
        message: (
          <>
            {STAGE_CONSEQUENCE[target] ?? ''}{' '}
            {a.displayName} ({a.assayerCode}) is currently {assayerLifecycleLabel(a.lifecycleStatus)}.
            Any work already assigned to them is not cancelled by this — check their assignments separately.
          </>
        ),
        confirmLabel: `Move to ${assayerLifecycleLabel(target)}`,
        reversible: false,
        reversibleNote: 'The stages only run forwards, so this cannot be put back by choosing the old stage again.',
        tone: 'danger',
      });
      if (!ok) return;
    }
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
    // The old password stops working the instant this runs, and the replacement is shown once and
    // never again. A clerk exploring the drawer could lock a field worker out of the app mid-shift
    // by pressing a button whose label ("Reset password") did not say that anything was destroyed.
    const ok = await confirm({
      title: `Give ${a?.displayName ?? 'this assayer'} a new password?`,
      message: 'Their current password stops working straight away. A one-time password appears here for you to read out to them over the phone — it is shown once and cannot be looked up afterwards, and they must be able to sign in with it to choose a new one.',
      confirmLabel: 'Create one-time password',
      reversible: false,
    });
    if (!ok) return;
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
      {confirmDialog}
      {/*
        A PAGE, NOT A SLIDE-OVER.

        This was a 560px drawer over the roster, which was right when it held a summary and a
        list of remarks. It now holds the whole record — vetting, client standing, references,
        twenty-one documents split into identity and paperwork, skills with their renewal dates —
        and 560px turned all of that into a column of wrapped two-word cells. Reading somebody's
        file meant scrolling a narrow strip beside a list nobody was looking at any more.

        The roster is one click away and the record has its own URL, so the thing the drawer was
        protecting — not losing your place in the list — is handled by the back button instead.
      */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {!a ? (
          <div style={{ padding: '28px' }}>{err ?? 'Loading…'}</div>
        ) : (
          <>
            <header style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '12px', minWidth: 0, alignItems: 'center' }}>
                  <Photograph assayerId={assayerId} name={a.displayName} />
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>{a.displayName}</h2>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '5px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    <span style={{ fontFamily: 'monospace' }}>{a.assayerCode}</span>
                    <span style={{ color: tone, fontWeight: 700 }}>{assayerLifecycleLabel(a.lifecycleStatus)}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {[a.city, a.state].filter(Boolean).join(', ') || '—'}</span>
                  </div>
                </div>
                </div>
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
                  {/*
                    Above the fold, in the alarm colour, because it is the one fact on this screen
                    that says the person being planned is not the person who will attend.

                    21 rows of the appraiser roster record it — "Staff doing audit", "Husband doing
                    audit" — and every audit those rows cover was signed off by somebody the client
                    never empanelled and we never vetted. Left in a fact grid it reads as another
                    field; it is the reason to stop.
                  */}
                  {a.workDoneBySomeoneElse && (
                    <div style={{ padding: '11px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg, rgba(220,80,80,0.10))', border: '1px solid var(--danger)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--danger)', fontWeight: 700, fontSize: '12.5px' }}>
                        <AlertTriangle size={14} /> Their work is being done by somebody else
                      </div>
                      <div style={{ margin: '7px 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        The roster records that audits under this code are attended by a member of
                        staff, a relative or a friend — not by the person empanelled here. Nobody
                        has vetted whoever is entering the branch, and the client has not accepted
                        them. Resolve this before planning any further work on this code.
                      </div>
                    </div>
                  )}

                  {missing.length > 0 && (
                    <div style={{ padding: '11px 13px', borderRadius: '8px', background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.25)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--warning)', fontWeight: 700, fontSize: '12.5px' }}>
                        <AlertTriangle size={14} /> {counted(missing.length, 'required field')} missing
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
                          {busy ? 'Moving…' : target ? `Move to ${assayerLifecycleLabel(target)}` : 'Move'}
                        </button>
                      </div>
                      {/* The picked stage explained before the button is pressed, not after. */}
                      {target && STAGE_CONSEQUENCE[target] && (
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '7px', lineHeight: 1.5 }}>
                          {STAGE_CONSEQUENCE[target]}
                          {reasonRequired && ' A reason is required and is kept on their employment record.'}
                        </div>
                      )}
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

                  {/*
                    Sixteen facts in one undifferentiated grid, in the order the database happens
                    to store them: a phone number, then a pincode, then an employment type, then a
                    workload cap. Someone looking up how to reach this person had to read past
                    "Max weekly load" to be sure they had not missed a second number, because
                    nothing told them where contact details ended. Same sixteen facts, in the four
                    groups a clerk actually asks for — nothing hidden, nothing added.

                    "Employment" also printed the stored value: every person on the live roster
                    reads "INTERNAL", a word that appears nowhere in the edit form's own list of
                    employment types, so there was no way to find out what it meant.
                  */}
                  <FactGroup title="How to reach them" rows={[
                    ['Phone', a.phone], ['Alternate phone', a.alternatePhone], ['Email', a.email],
                    ['Emergency contact', a.emergencyContactName], ['Emergency phone', a.emergencyContactPhone],
                  ]} />
                  <FactGroup title="Where they are" rows={[
                    ['Address', a.address], ['District', a.district], ['Pincode', a.pincode],
                    ['Region', a.region],
                  ]} />
                  <FactGroup title="Their job" rows={[
                    ['Employment', employmentTypeLabel(a.employmentType)], ['Employee ID', a.employeeId],
                    ['Department', a.department],
                    ['Joined', fmtDate(a.joiningDate)], ['Experience', `${a.experienceYears ?? 0} years`],
                    ['Engaged as', a.engagementType ? (ENGAGEMENT_LABELS[a.engagementType] ?? a.engagementType) : null],
                    ['Not available because', a.unavailableReason ? (UNAVAILABLE_LABELS[a.unavailableReason] ?? a.unavailableReason) : null],
                    ['HR owner', a.hrOwnerName],
                  ]} />
                  <FactGroup title="Who they are" rows={[
                    ['Date of birth', fmtDate(a.dateOfBirth)], ['Qualification', a.qualification],
                    ['Aadhaar', maskAadhaar(a.aadhaarNumber)], ['VSTS code', a.vstsCode],
                  ]} />
                  <FactGroup title="How much work they can take" rows={[
                    ['Most jobs in a day', a.maxDailyWorkload], ['Most jobs in a week', a.maxWeeklyWorkload],
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
                <AssayerSkillsPanel assayerId={assayerId} assayerName={a.displayName} canManage={canManage} />
              )}

              {/*
                Rated, attributed staff remarks — the same component the planning desk shows in
                its assayer-detail modal, and the same figure the recommendation engine scores
                from. Who may write is decided by role inside the component (the operations desk
                can, not only HR), so it is deliberately not gated on `canManage`.
              */}
              {tab === 'vetting' && <AssayerVettingTab assayerId={assayerId} canManage={canManage} section="checks" />}

              {tab === 'documents' && <AssayerVettingTab assayerId={assayerId} canManage={canManage} section="documents" />}

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
      </div>
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

/** One titled block of facts, so the summary reads as answers to questions rather than a dump. */
const FactGroup: React.FC<{ title: string; rows: [string, any][] }> = ({ title, rows }) => (
  <section>
    <div style={{ ...label, marginBottom: '8px' }}>{title}</div>
    <Facts rows={rows} />
  </section>
);

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

export default AssayerRecord;
