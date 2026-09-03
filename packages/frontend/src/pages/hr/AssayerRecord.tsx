import React, { useEffect, useMemo, useState } from 'react';
import {
  Edit2, ArrowRightLeft, AlertTriangle, CheckCircle2,
  User, CreditCard, Award, Clock, MessageSquare, Phone, Mail, MapPin, KeyRound, ShieldCheck, FileCheck, Gauge, Info,
} from 'lucide-react';
import { nextAssayerLifecycleStates, nextOnboardingStep, AssayerLifecycleStatus, assayerLifecycleLabel, activityEventLabel, employmentTypeLabel, AssayerEngagementType, AssayerUnavailableReason, ASSAYER_RECORD_FIELDS } from '@fapoms/shared';

import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import { useConfirm, AlertBanner, SkeletonList } from '../../components/ui';
import { useToast } from '../../components/ui/Toast';
import { GeoPrecisionBadge, geoNeedsFixing } from '../../components/GeoPrecisionBadge';
import { PinCoordinateControl } from '../../components/PinCoordinateControl';
import type { Assayer } from './assayer-shared';
import {
  STATUS_COLORS, money, missingCriticalFields,
  fieldLabelStyle as label,
  buildAssayerEditBody, changedFormKeys, onboardingNextStep,
  isSensitiveKey, maskedIdentifier, type SensitiveRecordKey,
} from './assayer-shared';
import { SensitiveValue } from './SensitiveValue';
import { EDIT_FIELDS, useManagerOptions, type FieldDef } from './AssayerForms';
import { fmtDate, fmtWhen } from '../../utils/dates';
import { userMessage } from '../../services/errors';
import { CommercialProfileModal, type CommercialProfile } from './CommercialProfileModal';
import { AssayerRemarks } from '../../components/AssayerRemarks';
import { AssayerVettingTab, STANDING_LABELS, standingStance, STANDING_STANCE_TONE } from './AssayerVettingTab';
import { AssayerQualificationTab } from './AssayerQualificationTab';
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

/**
 * Why a freshly issued credential will not work, in words that fit the actual reason.
 *
 * This card used to carry one sentence for every case — "they can sign in once their stage is
 * moved to Active" — which was written when the four onboarding stages were the ones locked out.
 * They are not any more: onboarding can sign in, into a session confined to their own
 * registration. The stages that genuinely cannot sign in today are the ones below, and none of
 * them is waiting on onboarding to finish. Telling a suspended person's manager to "move them to
 * Active" is advice about the wrong problem, and telling it about somebody who has resigned is
 * advice about a person who is not coming back.
 *
 * Anything not listed here can sign in, so a missing key means the fallback beneath is being
 * asked a question the server has already answered `canSignInNow: false` to — say the plain
 * thing and let the reader look at the stage.
 */
const SIGN_IN_CLOSED_REASON: Partial<Record<AssayerLifecycleStatus, string>> = {
  [AssayerLifecycleStatus.SUSPENDED]:
    'It will not work while they are suspended. Sign-in opens again when their record goes back to Active.',
  [AssayerLifecycleStatus.INACTIVE]:
    'It will not work while their record is on hold. Sign-in opens again when they go back to Active.',
  [AssayerLifecycleStatus.RESIGNED]:
    'It will not work — they have left, and sign-in is closed on their record.',
  [AssayerLifecycleStatus.TERMINATED]:
    'It will not work — their employment has ended, and sign-in is closed on their record.',
  [AssayerLifecycleStatus.ARCHIVED]:
    'It will not work — their record has been closed and archived, and sign-in closed with it.',
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
 * Who this record belongs to, and whether the reader may uncover a KYC identifier on it.
 *
 * A context rather than a prop threaded through `FactGroup` into `Facts`: which fields are
 * sensitive is decided by `isSensitiveKey`, so a row moved from one group to another must keep
 * its treatment. Passing the permission per group would have made that a per-group decision, and
 * the failure mode of getting it wrong is a whole Aadhaar printed on screen.
 */
const SensitiveCtx = React.createContext<{ assayerId: string; canReveal: boolean } | null>(null);

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
  /*
    ONE NAME FOR ONE THING. This tab was "Pay" here, "Pay & terms" on the section's own tab strip
    (HrLayout), and its contents were called "pay structures" — three names for the same screen,
    and a clerk told to "check their pay terms" had to work out that all three were it. The
    destination is "Pay & terms" everywhere it is named; the rows in it are "pay structures"
    everywhere they are named. The `commercial` key is internal and never shown.
  */
  { key: 'commercial', label: 'Pay & terms', icon: CreditCard },
  { key: 'skills', label: 'Skills', icon: Award },
  // Two tabs over one fetch. They answer one question together — may we send this person out,
  // and to whom — but they are looked for by different names: somebody chasing a missing NDA
  // goes looking for "Documents", and nobody goes looking for it under "Vetting".
  { key: 'vetting', label: 'Vetting', icon: ShieldCheck },
  { key: 'documents', label: 'Documents', icon: FileCheck },
  // The roster's data synthesized into one judgment: 0–100 dimensions, per-partner scores,
  // audited overrides, and the printable profile handed to partners during empanelment.
  { key: 'qualification', label: 'Qualification', icon: Gauge },
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
 * Where the record says they are, on the map.
 *
 * Shown to four decimal places — about eleven metres, which is the precision this is used at
 * (distance filtering and travel cost), and printing fourteen digits of float noise implies an
 * accuracy the geocoder never claimed.
 */
const coordinates = (a: { latitude?: number | null; longitude?: number | null }): string | null => {
  if (a.latitude == null || a.longitude == null) return null;
  return `${Number(a.latitude).toFixed(4)}, ${Number(a.longitude).toFixed(4)}`;
};

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
}> = ({ assayerId, canManage, onClose, onChanged, reloadKey = 0 }) => {
  const [a, setA] = useState<Assayer | null>(null);
  const [tab, setTab] = useState<TabKey>('summary');

  /**
   * The banks question, answered on the FIRST screen. Which lenders is this person empanelled
   * with, and what does their credit check say — both lived only inside the Vetting tab, so
   * "what banks can we send them to?" meant knowing which tab to open. One dossier read (the
   * same endpoint the Vetting tab uses; the browser caches nothing here but the payload is
   * small); a viewer whose role cannot read the dossier simply does not get the strip.
   */
  const [dossierGlance, setDossierGlance] = useState<{
    empanelments: Array<{ id: string; status: string; statusReason?: string | null; client?: { id: string; name: string } | null }>;
    currentCheck: { cibilScore?: number | null; cibilBand?: string | null; checkedOn?: string | null } | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.request<any>(`/assayers/${assayerId}/dossier`)
      .then((d) => { if (!cancelled) setDossierGlance({ empanelments: d?.empanelments ?? [], currentCheck: d?.currentCheck ?? null }); })
      .catch(() => { /* not entitled to the dossier — the strip just does not render */ });
    return () => { cancelled = true; };
  }, [assayerId, reloadKey]);
  const [loaded, setLoaded] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  /**
   * The ONE place this page reports something the reader has to act on.
   *
   * It was two places on one screen: a failed save arrived as a toast in the corner, while a
   * failed stage move and a failed password reset arrived as a red strip above the tabs. Same
   * screen, same person, same kind of failure, two different things to look at — and the toast
   * takes itself away after a few seconds, so a save that did not happen could vanish before it
   * was read. Everything that needs a decision now lands here and stays until dismissed;
   * `toast()` keeps only the transient confirmations ("3 changes saved").
   */
  const [err, setErr] = useState<string | null>(null);
  const [payModal, setPayModal] = useState<{ open: boolean; profile: CommercialProfile | null }>({ open: false, profile: null });
  const { confirm, confirmDialog } = useConfirm();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const autoEditRef = React.useRef(false);

  /**
   * Editing the Summary in place. `editForm` is the boxes; `editInitial` is what they held when
   * editing began, so a save sends only what actually changed — see `changedFormKeys`. The
   * reporting-manager picker needs the roster; loaded only while editing, and only for staff.
   */
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editInitial, setEditInitial] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const managerOpts = useManagerOptions(editing && canManage, assayerId);

  const snapshotEdit = (rec: Assayer): Record<string, string> => {
    const f: Record<string, string> = {};
    for (const key of SUMMARY_EDIT_KEYS) {
      /**
       * A masked identifier never enters the form.
       *
       * PAN, Aadhaar and bank account arrive from the server as `••••••234F`. Seeding a box with
       * that would make the mask the starting point of an edit, and a clerk correcting one digit
       * would save the mask plus a digit over a real KYC number. Empty here, filled by the reveal
       * — see `revealSensitive`, and `SensitiveValue` for the control that does it.
       */
      if (isSensitiveKey(key)) { f[key] = ''; continue; }
      let val = (rec as any)[key];
      if (key === 'dateOfBirth' || key === 'joiningDate') val = val ? new Date(val).toISOString().split('T')[0] : '';
      else val = val !== null && val !== undefined ? String(val) : '';
      f[key] = val;
    }
    return f;
  };

  /**
   * The real value arriving from a deliberate reveal, seeded into BOTH the box and the baseline.
   *
   * Both, because the diff in `changedFormKeys` decides what a save sends: seeding only the box
   * would make the act of looking at somebody's PAN count as a change to it, and every reveal
   * would re-write the column it revealed. Uncovering a number is not editing it.
   */
  const revealSensitive = (key: string, full: string) => {
    setEditForm((f) => ({ ...f, [key]: full }));
    setEditInitial((f) => ({ ...f, [key]: full }));
  };

  const startEdit = () => {
    if (!a) return;
    const snap = snapshotEdit(a);
    setEditForm(snap); setEditInitial(snap); setTab('summary'); setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); };
  const saveEdit = async () => {
    if (!a) return;
    setSavingEdit(true);
    setErr(null);
    try {
      const changed = changedFormKeys(editForm, editInitial);
      if (changed.length === 0) { setEditing(false); return; }
      const touched: Record<string, string | undefined> = {};
      for (const key of changed) touched[key] = editForm[key];
      const { body, problems } = buildAssayerEditBody(EDIT_FIELDS, touched, a);
      // Both failure paths go to the banner, not a toast: the form is still open with the
      // operator's unsaved typing in it, and a message that removes itself after four seconds is
      // the wrong way to tell somebody their work has not been stored.
      if (problems.length) { setErr(`Could not save. ${problems.join(' ')}`); return; }
      await api.request(`/assayers/${a.id}`, { method: 'PUT', body: JSON.stringify(body) });
      toast({ type: 'success', title: 'Saved', message: `${counted(changed.length, 'change')} saved.` });
      setEditing(false);
      onChanged();
    } catch (e) { setErr(`Could not save. ${userMessage(e)}`); }
    finally { setSavingEdit(false); }
  };
  const editCtx: EditCtx | undefined = editing
    ? {
        form: editForm,
        set: (key, val) => setEditForm((f) => ({ ...f, [key]: val })),
        reveal: revealSensitive,
        managers: managerOpts.people ? managerOpts.people.map((p) => ({ id: p.value, name: p.label })) : null,
      }
    : undefined;

  useEffect(() => {
    let cancelled = false;
    api.request<Assayer>(`/assayers/${assayerId}`)
      .then((fresh) => { if (!cancelled) setA(fresh); })
      .catch((e) => { if (!cancelled) setErr(userMessage(e)); });
    return () => { cancelled = true; };
  }, [assayerId, reloadKey]);

  // Arriving with `?edit=1` (the roster's edit pencil links here) drops straight into editing,
  // once, then strips the flag so a refresh does not re-trigger it.
  useEffect(() => {
    if (autoEditRef.current || !a || !canManage) return;
    if (searchParams.get('edit') === '1') {
      autoEditRef.current = true;
      startEdit();
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      setSearchParams(next, { replace: true });
    }
    // startEdit is stable enough for this one-shot; deps kept minimal on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, canManage]);

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
   * Tracked fields that are empty but block nothing.
   *
   * The banner counted the blocking ones only, so a record showing six "Not recorded" markers
   * announced "2 required fields missing" and read as though it were hiding the rest.
   */
  const alsoIncomplete = useMemo(
    () => ASSAYER_RECORD_FIELDS.filter((f) => {
      if (f.critical) return false;
      const v = (a as any)?.[f.key];
      return v == null || String(v).trim() === '';
    }),
    [a],
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
   * The one step that carries a joiner forward, singled out from the legal moves around it.
   *
   * Everything else in `transitions` is a side road — deactivating somebody mid-onboarding, parking
   * an active person on leave. This is the move the planner has been asking for on the other screen.
   */
  const forwardStep = a ? nextOnboardingStep(a.lifecycleStatus) : null;

  /**
   * Suspension, deactivation, resignation and termination go on an employment record and are
   * what a later dispute or reference check is judged on, so the server refuses them without a
   * reason. Ask for it in front of the button rather than letting someone press it and be told no.
   */
  const needsReason = (to: string) => LIFECYCLE_MOVES_NEEDING_A_REASON.includes(to);

  /**
   * Moving someone's stage, with the consequence stated before it happens.
   *
   * This used to be a dropdown of filing states and a button labelled "Move", which meant walking a
   * new joiner from INVITED to ACTIVE was four separate picks — and each pick required the clerk to
   * already know which of eleven stages came next. It is now a button per legal move, so the step
   * is named rather than looked up.
   *
   * WHAT DID NOT CHANGE, deliberately: nothing advances on its own, and there is no button that
   * walks the whole chain. Each stage is a judgement somebody in HR makes about a real person —
   * their papers were checked, their background came back, they finished training — and software
   * that makes four of those at once has made three of them up. The button is a shortcut for a
   * decision, not a replacement for it.
   *
   * Suspending, dismissing or archiving all take effect on the live roster the moment they are
   * pressed and none can be taken back by choosing the previous stage again — the state machine
   * does not run backwards — so those ask first, in a dialog naming the person. Routine moves stay
   * one click, because making a clerk confirm every ordinary step is how people learn to click
   * through dialogs unread.
   */
  const move = async (to: string, why: string) => {
    if (!to || !a) return;
    if (HARD_TO_REVERSE_STAGES.includes(to)) {
      const ok = await confirm({
        title: `Move ${a.displayName} to ${assayerLifecycleLabel(to)}?`,
        message: (
          <>
            {STAGE_CONSEQUENCE[to] ?? ''}{' '}
            {a.displayName} ({a.assayerCode}) is currently {assayerLifecycleLabel(a.lifecycleStatus)}.
            Any work already assigned to them is not cancelled by this — check their assignments separately.
          </>
        ),
        confirmLabel: `Move to ${assayerLifecycleLabel(to)}`,
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
        body: JSON.stringify({ targetStatus: to, reason: why || `Moved to ${to}` }),
      });
      const fresh = await api.request<Assayer>(`/assayers/${assayerId}`);
      setA(fresh);
      setTarget(''); setReason('');
      setLoaded((p) => ({ ...p, history: undefined }));
      onChanged();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  /**
   * A move that needs a reason opens its own box instead of firing.
   *
   * One reason box for a dropdown was fine; one shared box under a row of buttons is not — it
   * would sit there empty beside four buttons, three of which do not want it, and the clerk would
   * have to work out which. Pressing "Move to Inactive" asks why, and nothing else on the panel
   * changes.
   */
  const startMove = (to: string) => {
    if (needsReason(to)) { setTarget(to); setReason(''); return; }
    void move(to, '');
  };

  /**
   * A credential shown exactly once, from either of the two things that produce one.
   *
   * `username`, `canSignInNow` and `accessScope` come from the invitation route and are absent on
   * a reset; the card renders what it was given, and the undefined case is the reset, which says
   * nothing about reach because nothing about the person's stage changed. One piece of state
   * because there is one card, and a screen that could show two different one-time passwords at
   * once would be a screen where somebody reads out the wrong one.
   */
  const [credential, setCredential] = useState<{
    kind: 'invite' | 'reset';
    password: string;
    username?: string;
    canSignInNow?: boolean;
    accessScope?: 'FULL' | 'REGISTRATION_ONLY';
  } | null>(null);
  const [issuing, setIssuing] = useState<'invite' | 'reset' | null>(null);

  /**
   * FIRST-TIME APP ACCESS, which was being handed out as a password reset.
   *
   * The only route to a credential from this screen was "Reset password" — the recovery path, and
   * it says so in its own dialog — so giving somebody the app for the first time meant resetting a
   * password that had never existed. `POST /assayers/:id/app-access` is the invitation.
   *
   * It answers two separate questions and the card must read both. `canSignInNow` is whether the
   * credential works at all; `accessScope` is how far it goes. These were one field meaning
   * "fully usable", back when the four onboarding stages could not sign in — they can now, into a
   * session confined to finishing their own registration. So a card reading `canSignInNow` alone
   * fell silent for exactly the people it existed to warn: the password worked, every ordinary
   * screen answered 403, and HR heard about it from the assayer's phone call three days later.
   * Issuing access mid-onboarding is deliberately allowed, because the handover happens while the
   * person is standing at the desk; the card says what they will and will not be able to do.
   */
  const issueAppAccess = async () => {
    if (issuing) return;
    setIssuing('invite'); setErr(null); setCredential(null);
    try {
      const res = await api.request<{
        username: string;
        temporaryPassword: string;
        canSignInNow: boolean;
        accessScope: 'FULL' | 'REGISTRATION_ONLY';
      }>(
        `/assayers/${assayerId}/app-access`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setCredential({
        kind: 'invite',
        password: res.temporaryPassword,
        username: res.username,
        canSignInNow: res.canSignInNow,
        accessScope: res.accessScope,
      });
    } catch (e) { setErr(userMessage(e)); }
    finally { setIssuing(null); }
  };

  /**
   * Recovery for a field worker who is locked out — they enter client bank vaults on a
   * schedule, so "come back tomorrow" is a missed audit. HR generates a temporary password the
   * server returns exactly once; it is read to the assayer and forces a change at next sign-in.
   */
  const resetPassword = async () => {
    if (issuing) return;
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
    setIssuing('reset'); setErr(null); setCredential(null);
    try {
      // The endpoint returns a pre-enveloped body ({ success, temporaryPassword, message }) with no
      // `data` key, so it must be read with withMeta — otherwise api.request unwraps `.data` (undefined)
      // and the one-time password, which the server never stores readably, is lost. The invitation
      // route beside it is a normal envelope, which is why only this one carries the flag.
      const res = await api.request<{ temporaryPassword?: string }>(`/assayers/${assayerId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({}),
        withMeta: true,
      } as any);
      setCredential({ kind: 'reset', password: res.temporaryPassword ?? '(set, but not returned)' });
    } catch (e) { setErr(userMessage(e)); }
    finally { setIssuing(null); }
  };

  const tone = a ? STATUS_COLORS[a.lifecycleStatus] ?? 'var(--text-muted)' : 'var(--text-muted)';

  /**
   * Who may uncover a KYC identifier here. `canManage` is ADMIN and OPERATIONS, which is exactly
   * the pair `GET /assayers/:id/sensitive/:field` admits — so a reader who is shown the button can
   * always use it, and a reader who cannot is told why rather than being handed a guaranteed 403.
   */
  const sensitiveCtx = useMemo(
    () => ({ assayerId, canReveal: canManage }),
    [assayerId, canManage],
  );

  return (
    <SensitiveCtx.Provider value={sensitiveCtx}>
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
          /*
            "Loading…" on an otherwise blank page says nothing about what is coming, and the same
            slot printed the load failure in the same grey, so a record that could not be fetched
            looked exactly like one that was still fetching. Skeleton for the wait, the shared
            error banner for the failure.
          */
          <div style={{ padding: '20px 18px' }}>
            <AlertBanner type="error" message={err} onClose={() => setErr(null)} style={{ marginBottom: '14px' }} />
            {!err && <SkeletonList rows={4} height={70} />}
          </div>
        ) : (
          <>
            <header style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '12px', minWidth: 0, alignItems: 'center' }}>
                  <Photograph assayerId={assayerId} name={a.displayName} />
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>{a.displayName}</h2>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '5px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    <span style={{ fontFamily: 'monospace' }}>{a.assayerCode}</span>
                    <span style={{ color: tone, fontWeight: 700 }}>{assayerLifecycleLabel(a.lifecycleStatus)}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {[a.city, a.state].filter(Boolean).join(', ') || '—'}</span>
                  </div>
                </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
                {canManage && (editing ? (
                  <>
                    <button onClick={saveEdit} disabled={savingEdit} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <CheckCircle2 size={12} /> {savingEdit ? 'Saving…' : 'Save changes'}
                    </button>
                    <button onClick={cancelEdit} disabled={savingEdit} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 10px' }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button onClick={startEdit} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <Edit2 size={12} /> Edit
                  </button>
                ))}
                {a.phone && (
                  <a href={`tel:${a.phone}`} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
                    <Phone size={12} /> Call
                  </a>
                )}
                {a.email && (
                  <a href={`mailto:${a.email}`} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
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
              {/* The single failure channel for this page — see `err` above. */}
              <AlertBanner type="error" message={err} onClose={() => setErr(null)} style={{ marginBottom: '12px' }} />

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
                    <div style={{ padding: '11px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--danger)' }}>
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
                    <div style={{ padding: '11px 13px', borderRadius: '8px', background: 'var(--status-pending-bg)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--warning)', fontWeight: 700, fontSize: '12.5px' }}>
                        <AlertTriangle size={14} /> {counted(missing.length, 'required field')} missing
                      </div>
                      <ul style={{ margin: '7px 0 0', paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {missing.map((f) => <li key={String(f.key)}>{f.label} — blocks {f.why.toLowerCase()}</li>)}
                      </ul>
                      {/*
                        The banner counted only the blocking fields while six others read "Not
                        recorded" further down the page, so it looked like the record was hiding
                        most of what was wrong with it. Both counts are on screen now, and the
                        difference between them — blocks something, versus merely incomplete —
                        is the whole reason there are two.
                      */}
                      {alsoIncomplete.length > 0 && (
                        <div style={{ marginTop: '7px', fontSize: '12px', color: 'var(--text-muted)' }}>
                          {counted(alsoIncomplete.length, 'other field is', 'other fields are')} also
                          empty — {alsoIncomplete.map((f) => f.label.toLowerCase()).join(', ')}. Nothing is
                          blocked by them; each is marked where it belongs on this record.
                        </div>
                      )}
                      {canManage && (
                        <button onClick={startEdit} className="btn btn-secondary" style={{ fontSize: '12px', padding: '5px 10px', marginTop: '9px' }}>
                          Fill them in
                        </button>
                      )}
                    </div>
                  )}
                  {missing.length === 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--success)', fontSize: '12.5px' }}>
                      <CheckCircle2 size={14} />
                      {alsoIncomplete.length === 0
                        ? 'Record complete — every tracked field is filled in.'
                        : `Nothing is blocked — but ${counted(alsoIncomplete.length, 'field is', 'fields are')} still empty, marked below.`}
                    </div>
                  )}

                  {/*
                    NEXT STEPS, NOT A LIST OF FILING STATES.

                    This was a dropdown of eleven lifecycle names and a button called "Move". Taking
                    a new joiner from invited to active meant four separate visits to it, and each
                    one asked the clerk a question the software already knew the answer to: which of
                    these comes next? Meanwhile the planning screen was printing that answer at them
                    — "in training, mark training complete on the HR roster to activate" — and the
                    roster it named said nothing back.

                    So the legal moves are buttons, and the one that carries a joiner forward is the
                    primary one. Both halves come from rules that already existed and are not
                    restated here: `nextAssayerLifecycleStates` decides what may be offered at all,
                    `nextOnboardingStep` picks the forward one out of that set, and STAGE_CONSEQUENCE
                    says what each does to the person. Nothing advances by itself and no button takes
                    more than one step — each stage is a judgement about a real human being, and four
                    of them at once is three that nobody made.
                  */}
                  {canManage && transitions.length > 0 && (
                    <section>
                      <div style={{ ...label, marginBottom: '7px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <ArrowRightLeft size={11} /> What happens next
                      </div>
                      {/*
                        What is actually wanted from this person, in the words the rest of the
                        platform already uses — one map in `@fapoms/shared`, read by the planner's
                        refusal and by this sentence. A coordinator told on the planning screen that
                        somebody is "in training — mark training complete on the HR roster to
                        activate" arrives here and reads it back, above the button that does it.
                      */}
                      {onboardingNextStep(a) && (
                        <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
                          Onboarding is not finished — they are {onboardingNextStep(a)}.
                        </div>
                      )}

                      {forwardStep && (
                        <StageStep
                          to={forwardStep}
                          primary
                          busy={busy}
                          asking={target === forwardStep}
                          reason={reason}
                          onReason={setReason}
                          onPress={() => startMove(forwardStep)}
                          onConfirm={() => void move(forwardStep, reason)}
                          onCancel={() => { setTarget(''); setReason(''); }}
                        />
                      )}

                      {/*
                        The side roads. Kept plainly available and plainly secondary: parking
                        somebody or ending their engagement is a real thing HR does from this screen,
                        and it is not what the screen is for.
                      */}
                      {transitions.filter((t) => t !== forwardStep).length > 0 && (
                        <div style={{ marginTop: forwardStep ? '12px' : 0 }}>
                          {forwardStep && (
                            <div style={{ ...label, marginBottom: '6px' }}>Or, instead</div>
                          )}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {transitions.filter((t) => t !== forwardStep).map((t) => (
                              <StageStep
                                key={t}
                                to={t}
                                busy={busy}
                                asking={target === t}
                                reason={reason}
                                onReason={setReason}
                                onPress={() => startMove(t)}
                                onConfirm={() => void move(t, reason)}
                                onCancel={() => { setTarget(''); setReason(''); }}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {canManage && (
                    <section>
                      <div style={{ ...label, marginBottom: '7px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <KeyRound size={11} /> Account access
                      </div>
                      {credential ? (
                        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--status-active-bg)', border: '1px solid var(--success)' }}>
                          {credential.username && (
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                              They sign in as{' '}
                              <code style={{ fontWeight: 700, userSelect: 'all' }}>{credential.username}</code>
                            </div>
                          )}
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                            Temporary password — read it to the assayer now, it will not be shown again:
                          </div>
                          <code style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em', color: 'var(--success)', userSelect: 'all' }}>{credential.password}</code>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '5px' }}>
                            They will be asked to choose their own at next sign-in.
                          </div>
                          {/*
                            THE ONE THING THIS CARD EXISTS TO SAY, when it applies — and it is two
                            different things, which is why there are two blocks.

                            This was a single warning gated on `canSignInNow`, written when the
                            four onboarding stages could not sign in at all. They can now, into a
                            session that only lets them finish their own registration, so the flag
                            went true for them and the card fell silent for precisely the people
                            it existed to warn: HR handed over a password that signs in and then
                            refuses every screen, and said nothing. The scope is not a warning —
                            being able to upload your own papers before you start is the point of
                            it — so it is stated plainly rather than in amber. The warning is kept
                            for the credential that genuinely does not work, with the reason that
                            actually applies (see SIGN_IN_CLOSED_REASON).
                          */}
                          {credential.canSignInNow === false && (
                            <div style={{ marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--warning)', lineHeight: 1.5 }}>
                              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
                              <span>
                                {(a && SIGN_IN_CLOSED_REASON[a.lifecycleStatus as AssayerLifecycleStatus])
                                  ?? 'It will not work at the moment — sign-in is closed on their record. Check their stage before handing this over.'}
                              </span>
                            </div>
                          )}
                          {credential.canSignInNow !== false && credential.accessScope === 'REGISTRATION_ONLY' && (
                            <div style={{ marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              <Info size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
                              <span>
                                They can sign in with this straight away, but only to finish their
                                own registration — uploading their papers and their own details.
                                The rest of the app opens once their joining checks are signed off.
                              </span>
                            </div>
                          )}
                          <button
                            onClick={() => setCredential(null)}
                            className="btn btn-secondary"
                            style={{ fontSize: '12px', padding: '5px 10px', marginTop: '9px' }}
                          >
                            I have read it out
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                          {/*
                            Two buttons for two different jobs, which used to be one.

                            "Reset password" was the only way to get a credential out of this
                            screen, so first-time access was handed out by resetting a password
                            that had never existed — and its own dialog says the current password
                            stops working, which is untrue and alarming for somebody who has never
                            had one.
                          */}
                          <button onClick={issueAppAccess} disabled={!!issuing} className="btn btn-secondary" style={{ fontSize: '12px', padding: '7px 13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <KeyRound size={13} /> {issuing === 'invite' ? 'Creating…' : 'Give them app access'}
                          </button>
                          <button onClick={resetPassword} disabled={!!issuing} className="btn btn-secondary" style={{ fontSize: '12px', padding: '7px 13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <KeyRound size={13} /> {issuing === 'reset' ? 'Resetting…' : 'Reset password'}
                          </button>
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)', flex: '1 1 220px', lineHeight: 1.5 }}>
                            The first is for somebody getting the app for the first time; the second
                            is for somebody locked out of it.
                          </span>
                        </div>
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
                  {/*
                    Laid out as panels that wrap, rather than five headings stacked in one column.
                    Forty fields down a full-width page read as one undifferentiated list, and the
                    headings stopped separating anything.
                  */}
                  {dossierGlance && (
                    <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px 16px', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)' }}>Banks &amp; standing</span>
                        <button type="button" onClick={() => setTab('vetting')} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                          Manage standings
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                        {dossierGlance.empanelments.length === 0 && (
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            No bank standings recorded yet — they will appear here after vetting or a roster import.
                          </span>
                        )}
                        {dossierGlance.empanelments.map((e) => {
                          /*
                            One rule, not a pair of local booleans. `blocking` here was the vetting
                            tab's old `BLOCKING_STANDINGS` — four refusals — while `positive` was
                            hand-written as ACTIVE-or-RECOMMENDED, which is the planner's actual
                            gate. So the two disagreed inside one chip: a DOCUMENTS_PENDING
                            standing was neither, and fell through to an amber that said nothing
                            about the person being unplannable. `standingStance` decides both from
                            `standingAllowsPlanning` in @fapoms/shared.
                          */
                          const tone = STANDING_STANCE_TONE[standingStance(e.status)];
                          return (
                            <span key={e.id} title={e.statusReason ?? undefined} style={{
                              display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 9px',
                              borderRadius: '999px', fontSize: '12px', fontWeight: 600,
                              background: tone.bg,
                              color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                            }}>
                              <span style={{ fontWeight: 700 }}>{e.client?.name ?? 'Unknown client'}</span>
                              <span style={{ color: tone.fg }}>
                                {STANDING_LABELS[e.status] ?? e.status}
                              </span>
                            </span>
                          );
                        })}
                        {/*
                          Two abbreviations nothing on this screen expanded.

                          "VSTS: none" is the person's code in the vault system (the edit form's
                          own placeholder says so, and nothing else in the app ever did) — read
                          cold it looks like a failed check. "Credit: GOOD (742)" is a CIBIL
                          score, the Indian credit bureau's; a three-digit number beside a word
                          means nothing unless you know which scale it is on.
                        */}
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: 'auto', display: 'inline-flex', gap: '12px', flexWrap: 'wrap' }}>
                          <span title="Their code in the vault system. Blank simply means they have not been given one.">
                            Vault system code: <b>{a.vstsCode || 'none'}</b>
                          </span>
                          {dossierGlance.currentCheck && (dossierGlance.currentCheck.cibilScore != null || dossierGlance.currentCheck.cibilBand) && (
                            <span title="Their CIBIL credit score, from the background check. Recorded, not scored by us.">
                              CIBIL credit score: <b>{dossierGlance.currentCheck.cibilBand ?? '—'}</b>
                              {dossierGlance.currentCheck.cibilScore != null ? ` (${dossierGlance.currentCheck.cibilScore})` : ''}
                              {dossierGlance.currentCheck.checkedOn ? `, checked ${fmtDate(dossierGlance.currentCheck.checkedOn)}` : ''}
                            </span>
                          )}
                        </span>
                      </div>
                    </section>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                  <FactGroup edit={editCtx} title="How to reach them" rows={[
                    ['Phone', a.phone, 'phone'],
                    ['Alternate phone', a.alternatePhone, 'alternatePhone'],
                    ['Email', a.email, 'email'],
                    ['Emergency contact', a.emergencyContactName, 'emergencyContactName'],
                    ['Emergency phone', a.emergencyContactPhone, 'emergencyContactPhone'],
                    ['Emergency relation', a.emergencyContactRelation, 'emergencyContactRelation'],
                  ]} />
                  <FactGroup
                    edit={editCtx}
                    title="Where they are"
                    rows={[
                      ['Address', a.address, 'address'],
                      ['City or town', a.city, 'city'],
                      ['District', a.district, 'district'],
                      ['State', a.state, 'state'],
                      ['Pincode', a.pincode, 'pincode'],
                      // Region is derived from the state — it follows automatically, so it stays a
                      // read-only readout even while the rest of the group is being edited.
                      ['Region', a.region],
                      /*
                        The banner said "Map location — blocks distance filtering" and no field on
                        this screen showed one, so the reader was told something was missing and
                        sent to look for it among forty facts that never mentioned it. Now it shows
                        the coordinate, says how much to trust it, and — below — lets somebody set
                        it. Still not an inline text box: a bare lat/lng field invites a typed
                        guess, where the control underneath takes a coordinate copied off a map and
                        has the server check it falls inside the state this person claims.
                      */
                      ['Map location', coordinates(a)
                        ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'monospace' }}>{coordinates(a)}</span>
                            <GeoPrecisionBadge source={a.geoSource} matchedName={a.geoMatchedName} compact />
                          </span>
                        )
                        : null],
                    ]}
                    footer={canManage && (editing || geoNeedsFixing(a.geoSource)) ? (
                      /*
                        THE FIX FOR 98 PEOPLE WITH NO HOME PIN, 76 OF THEM ACTIVE.

                        The completeness banner at the top of this page calls "Map location" a
                        critical gap and says it blocks distance filtering — and until now there
                        was no control anywhere in the web app that could close it. The same
                        component has been mounted on Branches since the precision work; it posts
                        to `/geo/precision/assayer/:id/pin`, which already accepts `assayer` as a
                        target and rejects a coordinate that falls outside the state on the record
                        (the transposed lat/lng mistake, caught here rather than by whoever reads
                        the map three weeks later). A pin set this way is marked `manual` and is
                        never overwritten by a re-geocode, an import or the backfill.

                        Shown while editing — the deliberate act of correcting this record — and,
                        exactly as on Branches, whenever the stored coordinate is a placeholder
                        rather than a location, which includes having none at all.
                      */
                      <>
                        {geoNeedsFixing(a.geoSource) && (
                          <div style={{ fontSize: '12px', color: 'var(--warning)', lineHeight: 1.5 }}>
                            {coordinates(a)
                              ? 'This pin is a stand-in, not their home — it can be tens of kilometres out, so '
                                + 'distance filtering and travel costs based on it will be wrong.'
                              : 'No home location has been recorded, so this person is left out of every '
                                + 'distance-based search.'}
                          </div>
                        )}
                        <PinCoordinateControl
                          target="assayer"
                          id={a.id}
                          onPinned={() => {
                            api.request<Assayer>(`/assayers/${assayerId}`)
                              .then(setA)
                              .catch((e) => setErr(`The pin was saved, but the record could not be re-read. ${userMessage(e)}`));
                            onChanged();
                          }}
                        />
                      </>
                    ) : undefined}
                  />
                  {/*
                    EVERY VALUE BELOW IS THE READ-MODE ONE, and that is not a regression.

                    Each of these rows used to read `editing ? a.rawColumn : label(a.rawColumn)`,
                    which looks like "show the raw enum while editing so the input has something
                    to hold". It never did: a row whose `recordKey` is in EDIT_FIELDS renders an
                    `<InlineField>` and ignores the value entirely (see `Facts`), and all of
                    employmentType, joiningDate, dateOfBirth, engagementType, unavailableReason
                    and experienceYears are in that list. So the raw branch was dead code that
                    read as a deliberate decision to show `INTERNAL` and `2019-04-01T00:00:00Z`
                    to a clerk — the next person to add a row here would have copied it.
                  */}
                  <FactGroup edit={editCtx} title="Their job" rows={[
                    ['Employment', employmentTypeLabel(a.employmentType), 'employmentType'],
                    ['Employee ID', a.employeeId, 'employeeId'],
                    ['Department', a.department, 'department'],
                    ['Joined', fmtDate(a.joiningDate), 'joiningDate'],
                    // Shown only when there IS one — a permanent "Left —" row on serving people
                    // would read as forty more dashes of noise.
                    ...(a.exitDate ? ([['Left', fmtDate(a.exitDate)]] as [string, any][]) : []),
                    ['Experience', `${a.experienceYears ?? 0} years`, 'experienceYears'],
                    ['Engaged as', a.engagementType ? (ENGAGEMENT_LABELS[a.engagementType] ?? a.engagementType) : null, 'engagementType'],
                    /*
                      Said "Not available because —" when the person was perfectly available, in
                      the same grey as every real gap. It is the one blank on this screen that is
                      good news, so it says so.
                    */
                    ['Availability',
                      a.unavailableReason ? (UNAVAILABLE_LABELS[a.unavailableReason] ?? a.unavailableReason) : 'Available for work',
                      'unavailableReason'],
                    ['Reporting manager', a.managerId, 'managerId'],
                    ['HR owner', a.hrOwnerName, 'hrOwnerName'],
                  ]} />
                  <FactGroup
                    edit={editCtx}
                    title="Who they are"
                    /*
                      THE PRODUCT DECISION, WRITTEN WHERE THE FIELDS ARE.
                      An Aadhaar is held complete and encrypted — the mask is a display rule, not a
                      statement about storage — and a clerk who reads "•••••••1234" with nothing
                      beside it reasonably concludes the company only kept four digits and stops
                      asking for the card. Both halves have to be said in the same place: all of it
                      is on file, and seeing all of it is a recorded act.
                    */
                    footer={(
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        Aadhaar and PAN are kept in full and encrypted. Screens show the last few
                        digits only; showing the whole number is a deliberate click, and each one
                        goes into the audit log with your name and the time.
                      </div>
                    )}
                    rows={[
                    ['Date of birth', fmtDate(a.dateOfBirth), 'dateOfBirth'],
                    ['Qualification', a.qualification, 'qualification'],
                    // Masked by the server and masked again on the way to the screen — see
                    // `maskedIdentifier`. Uncovering either is `SensitiveValue`'s job, in read mode
                    // and in edit mode alike.
                    ['Aadhaar', maskedIdentifier(a.aadhaarNumber), 'aadhaarNumber'],
                    ['PAN', maskedIdentifier(a.panNumber), 'panNumber'],
                    // Expanded for the same reason as the strip above: "VSTS" appears nowhere else
                    // in the product, so the abbreviation names nothing the reader can look up.
                    ['Vault system code', a.vstsCode, 'vstsCode'],
                    ['Documents folder', a.documentsLink
                      ? <a href={a.documentsLink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>Open folder</a>
                      : null],
                  ]} />
                  <FactGroup edit={editCtx} title="How they are paid" rows={[
                    ['Bank', a.bankName, 'bankName'],
                    ['Account', maskedIdentifier(a.bankAccountNumber), 'bankAccountNumber'],
                    // Not masked, and deliberately so: an IFSC identifies a bank branch, not a
                    // person or an account. Covering it would say something untrue about what it is.
                    ['IFSC', a.ifscCode, 'ifscCode'],
                  ]} />
                  <FactGroup edit={editCtx} title="How much work they can take" rows={[
                    ['Most jobs in a day', a.maxDailyWorkload, 'maxDailyWorkload'],
                    ['Most jobs in a week', a.maxWeeklyWorkload, 'maxWeeklyWorkload'],
                  ]} />
                  </div>
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
                    border: `1px solid ${bankMissing ? 'color-mix(in srgb, var(--warning) 30%, transparent)' : 'var(--border-color)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 700, fontSize: '12.5px', color: bankMissing ? 'var(--warning)' : 'var(--success)' }}>
                      {bankMissing ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                      {bankMissing ? 'No bank details — cannot be paid' : 'Bank details on file'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      {bankMissing
                        ? 'The rates below decide what this assayer earns; the account they are paid into is on their record, under Financial.'
                        : `Account ${maskedIdentifier(a.bankAccountNumber)} · IFSC ${a.ifscCode}`}
                    </div>
                    {canManage && bankMissing && (
                      <button onClick={startEdit} className="btn btn-secondary" style={{ fontSize: '12px', padding: '5px 10px', marginTop: '9px' }}>
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
                              marginLeft: '7px', fontSize: '12px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px',
                              background: c.__state === 'current' ? 'var(--status-active-bg)' : 'var(--bg-surface-2)',
                              color: c.__state === 'current' ? 'var(--success)' : c.__state === 'future' ? 'var(--accent)' : 'var(--text-muted)',
                            }}>
                              {c.__state === 'current' ? 'In force' : c.__state === 'future' ? 'Starts later' : 'Ended'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                              {fmtDate(c.effectiveStartDate || c.startDate)} → {c.effectiveEndDate ? fmtDate(c.effectiveEndDate) : 'open'}
                            </span>
                            {canManage && (
                              // Was a bare pencil with no title and no aria-label: to anyone not
                              // using a mouse, an unnamed button next to a row of money.
                              <button
                                onClick={() => setPayModal({ open: true, profile: c })}
                                aria-label={`Change the pay structure starting ${fmtDate(c.effectiveStartDate || c.startDate)}`}
                                title="Change this pay structure"
                                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                              >
                                <Edit2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
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
              {tab === 'vetting' && <AssayerVettingTab assayerId={assayerId} canManage={canManage} section="checks" lifecycleStatus={a.lifecycleStatus} />}

              {tab === 'documents' && <AssayerVettingTab assayerId={assayerId} canManage={canManage} section="documents" lifecycleStatus={a.lifecycleStatus} />}

              {tab === 'qualification' && <AssayerQualificationTab assayerId={assayerId} canManage={canManage} />}

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
                      {h.remarks && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>{h.remarks}</div>}
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
    </SensitiveCtx.Provider>
  );
};

/**
 * One legal move, as a button that says what it does to the person.
 *
 * The consequence is beside the button rather than revealed after choosing, which is what the
 * dropdown did — "Inactive" told a clerk parking somebody for a fortnight nothing about having
 * just removed them from every planning list. It is `STAGE_CONSEQUENCE`, unchanged, in its own
 * words; this component adds no copy of its own beyond the label the stage already has.
 *
 * A move the server will not accept without a reason opens the box here instead of firing, and the
 * button becomes the confirmation. Two clicks for those, one for the ordinary steps.
 */
const StageStep: React.FC<{
  to: string;
  primary?: boolean;
  busy: boolean;
  /** True while this is the move waiting for its reason. */
  asking: boolean;
  reason: string;
  onReason: (v: string) => void;
  onPress: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ to, primary, busy, asking, reason, onReason, onPress, onConfirm, onCancel }) => {
  const stage = assayerLifecycleLabel(to);
  return (
    <div
      style={{
        padding: primary ? '12px 14px' : '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-color)'}`,
        background: primary ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'var(--bg-surface-2)',
      }}
    >
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={asking ? onConfirm : onPress}
          disabled={busy || (asking && !reason.trim())}
          className={primary ? 'btn btn-primary' : 'btn btn-secondary'}
          style={{ fontSize: '12px', padding: primary ? '8px 14px' : '6px 12px', whiteSpace: 'nowrap' }}
        >
          {busy ? 'Moving…' : `Move to ${stage}`}
        </button>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, flex: '1 1 220px' }}>
          {STAGE_CONSEQUENCE[to] ?? `They are moved to ${stage}.`}
        </span>
      </div>
      {asking && (
        <div style={{ marginTop: '9px' }}>
          <label style={{ ...label, display: 'block', marginBottom: '4px' }} htmlFor={`reason-${to}`}>
            Why? This is kept on their employment record
          </label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <input
              id={`reason-${to}`}
              autoFocus
              value={reason}
              onChange={(e) => onReason(e.target.value)}
              placeholder="e.g. no longer available for work in their area"
              style={{
                flex: '1 1 220px', padding: '7px 10px', fontSize: '12px', borderRadius: '6px',
                background: 'var(--bg-page)', color: 'inherit',
                border: `1px solid ${reason.trim() ? 'var(--border-color)' : 'var(--warning)'}`,
              }}
            />
            <button onClick={onCancel} disabled={busy} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** One titled block of facts, so the summary reads as answers to questions rather than a dump. */
/**
 * One fact. The third element names the record field it comes from, where there is one.
 *
 * That name is what lets a blank say which kind of blank it is — see `Facts`.
 */
type Fact = [label: string, value: any, recordKey?: string];

/**
 * A group of facts, in a box of its own.
 *
 * These were five headings stacked in one column with nothing but a small caption between them,
 * so on a full-width page they read as one long list of forty fields and the headings stopped
 * doing any work. Each is a panel now, and they sit side by side where there is room.
 */
/**
 * Editing happens on the record, in place — not in a separate modal with its own set of tabs.
 *
 * The record used to open a second window to edit: eight sections in a vocabulary of their own
 * (Personal / Money / Capacity …) laid over the eight tabs the record already had (Summary /
 * Pay / Vetting …), so the same person was organised two different ways depending on whether
 * you were reading or writing. Now the Summary's own facts become inputs where they sit — the
 * label stays, the value turns editable — and a field is corrected exactly where it is read.
 *
 * A fact is editable when it carries a `recordKey` this form knows how to write; the field's
 * type, options and validation all come from the one `EDIT_FIELDS` definition the modal used,
 * so the two never disagree about what a valid PAN or a real employment type is. Facts with no
 * such key — a map location, a derived "available for work" — stay read-only.
 */
const EDIT_FIELD_BY_KEY = new Map<string, FieldDef>(EDIT_FIELDS.map((f) => [f.key, f]));

/** The fields the Summary lets you edit in place. Everything here has a definition in EDIT_FIELDS. */
const SUMMARY_EDIT_KEYS = [
  'phone', 'alternatePhone', 'email', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'address', 'city', 'district', 'state', 'pincode',
  'employmentType', 'employeeId', 'department', 'joiningDate', 'managerId', 'engagementType', 'unavailableReason', 'hrOwnerName',
  'dateOfBirth', 'qualification', 'aadhaarNumber', 'panNumber', 'vstsCode',
  'bankName', 'bankAccountNumber', 'ifscCode',
  'maxDailyWorkload', 'maxWeeklyWorkload', 'experienceYears',
];

interface EditCtx {
  form: Record<string, string>;
  set: (key: string, val: string) => void;
  /** A KYC identifier uncovered on purpose. Seeds the box and the baseline — see `revealSensitive`. */
  reveal: (key: string, full: string) => void;
  managers: { id: string; name: string }[] | null;
}

const inlineControl: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: '12.5px', boxSizing: 'border-box',
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: '6px', outline: 'none',
};

/**
 * One fact, turned into the right control for its field — select, date, number or text.
 *
 * A KYC identifier is wrapped: EDITING IT REQUIRES UNCOVERING IT FIRST. The box cannot open on a
 * mask, because a mask is what the record hands this form and one corrected digit on top of
 * `••••••234F` is a destroyed PAN that looks fine on every screen afterwards. A field with nothing
 * on file has no mask to uncover and is typed straight in.
 */
const InlineField: React.FC<{ fieldKey: string; ctx: EditCtx; masked?: string | null }> = ({
  fieldKey, ctx, masked,
}) => {
  const sensitive = React.useContext(SensitiveCtx);
  const control = <InlineControl fieldKey={fieldKey} ctx={ctx} />;
  if (!isSensitiveKey(fieldKey) || !sensitive) return control;
  return (
    <SensitiveValue
      assayerId={sensitive.assayerId}
      fieldKey={fieldKey as SensitiveRecordKey}
      masked={masked}
      canReveal={sensitive.canReveal}
      onRevealed={(full) => ctx.reveal(fieldKey, full)}
      renderRevealed={() => control}
      emptyState={control}
    />
  );
};

const InlineControl: React.FC<{ fieldKey: string; ctx: EditCtx }> = ({ fieldKey, ctx }) => {
  const def = EDIT_FIELD_BY_KEY.get(fieldKey);
  if (!def) return null;
  const val = ctx.form[fieldKey] ?? '';
  const onChange = (v: string) => ctx.set(fieldKey, v);
  if (def.people) {
    return (
      <select style={inlineControl} value={val} onChange={(e) => onChange(e.target.value)}>
        <option value="">{ctx.managers === null ? 'Loading…' : '— none —'}</option>
        {(ctx.managers ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    );
  }
  if (def.options) {
    return (
      <select style={inlineControl} value={val} onChange={(e) => onChange(e.target.value)}>
        <option value="">— choose —</option>
        {def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const type = def.type === 'date' ? 'date' : def.type === 'number' ? 'number' : 'text';
  return (
    <input
      type={type}
      style={{ ...inlineControl, fontFamily: FIELD_MONO_KEYS.has(fieldKey) ? 'monospace' : undefined,
        textTransform: (fieldKey === 'panNumber' || fieldKey === 'ifscCode') ? 'uppercase' : undefined }}
      value={val}
      placeholder={def.placeholder}
      inputMode={type === 'number' || fieldKey === 'pincode' || fieldKey.toLowerCase().includes('phone') ? 'numeric' : fieldKey === 'email' ? 'email' : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

const FIELD_MONO_KEYS = new Set(['panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'employeeId']);

/**
 * `footer` is for a control that belongs to the whole group rather than to one fact — the map-pin
 * control under "Where they are". It sits below the grid rather than inside a cell because it
 * opens into a two-input panel, and a cell in a `minmax(150px, 1fr)` grid is not a place to put
 * one.
 */
const FactGroup: React.FC<{ title: string; rows: Fact[]; edit?: EditCtx; footer?: React.ReactNode }> = ({
  title, rows, edit, footer,
}) => (
  <section
    style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-color)',
      borderRadius: '10px', padding: '14px 16px', flex: '1 1 340px', minWidth: 0,
    }}
  >
    <div style={{ ...label, marginBottom: '10px' }}>{title}</div>
    <Facts rows={rows} edit={edit} />
    {footer && <div style={{ marginTop: '10px' }}>{footer}</div>}
  </section>
);

const Facts: React.FC<{ rows: Fact[]; edit?: EditCtx }> = ({ rows, edit }) => {
  const sensitive = React.useContext(SensitiveCtx);
  return (
  <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '11px', margin: 0 }}>
    {rows.map(([k, v, recordKey]) => {
      const editable = !!(edit && recordKey && EDIT_FIELD_BY_KEY.has(recordKey));
      const blank = v === null || v === undefined || v === '';
      /**
       * An em-dash meant three different things on this screen.
       *
       * "Aadhaar —" was a gap somebody should close. "VSTS code —" was a field this person
       * simply has none of. And "Not available because —" was the *good* state — it meant they
       * are available — printed in the same grey as the other two. Somebody reading the record
       * could not tell which of the forty dashes were work.
       *
       * A field the record-fields list tracks says it is not recorded, and what that costs.
       * Everything else keeps the dash, which now means only "nothing here".
       */
      const gap = blank && recordKey
        ? ASSAYER_RECORD_FIELDS.find((f) => f.key === recordKey)
        : undefined;

      return (
        <div key={k}>
          <dt style={label}>{k}</dt>
          <dd style={{ margin: '2px 0 0', fontSize: '12.5px' }}>
            {editable ? (
              <InlineField
                fieldKey={recordKey as string}
                ctx={edit as EditCtx}
                masked={typeof v === 'string' ? v : null}
              />
            ) : recordKey && isSensitiveKey(recordKey) && sensitive && !blank ? (
              /*
                Covered by default, uncovered on purpose, and the uncovering recorded. See
                SensitiveValue — the warning is printed beside the button rather than hidden in a
                tooltip, because an audit trail nobody is told about is a trap, not a control.
              */
              <SensitiveValue
                assayerId={sensitive.assayerId}
                fieldKey={recordKey as SensitiveRecordKey}
                masked={String(v)}
                canReveal={sensitive.canReveal}
              />
            ) : gap ? (
              <span
                title={`Blocks ${gap.blocks.toLowerCase()}`}
                style={{ color: gap.critical ? 'var(--danger)' : 'var(--warning)', fontWeight: 600 }}
              >
                Not recorded
              </span>
            ) : blank ? (
              <span style={{ color: 'var(--text-muted)' }}>—</span>
            ) : React.isValidElement(v) ? (
              // A fact may be a link (the documents folder); String() would print
              // "[object Object]" where the anchor should be.
              v
            ) : String(v)}
          </dd>
        </div>
      );
    })}
  </dl>
  );
};

/** Shared loading/empty handling so each tab does not reinvent it. */
const List: React.FC<{ rows: any[] | undefined; empty: string; render: (r: any) => React.ReactNode }> = ({
  rows, empty, render,
}) => {
  // A skeleton in the shape of the rows that are coming, rather than the word "Loading…" — the
  // same treatment HrPayPage and Branches already use, so a tab switch does not read as a stall.
  if (rows === undefined) return <SkeletonList rows={3} height={52} />;
  if (rows.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', padding: '18px 0' }}>{empty}</div>;
  return <>{rows.map(render)}</>;
};

export default AssayerRecord;
