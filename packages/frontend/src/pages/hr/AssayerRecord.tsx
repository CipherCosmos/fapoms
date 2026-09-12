import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  Edit2, ArrowRightLeft, AlertTriangle, CheckCircle2,
  User, CreditCard, Award, Clock, MessageSquare, Phone, Mail, KeyRound, ShieldCheck, FileCheck, Gauge, Info, Trash2,
  Download,
} from 'lucide-react';
import {
  nextAssayerLifecycleStates, nextOnboardingStep, AssayerLifecycleStatus, assayerLifecycleLabel,
  activityEventLabel, employmentTypeLabel, AssayerEngagementType, AssayerUnavailableReason,
  ASSAYER_RECORD_FIELDS, isValidIfsc, IDENTITY_GATE_DOCUMENTS,
} from '@fapoms/shared';
import { useSearchParams } from 'react-router-dom';

import { api } from '../../services/api';
import { useConfirm, AlertBanner, SkeletonList, Select } from '../../components/ui';
import { useToast } from '../../components/ui/Toast';
import { GeoPrecisionBadge, geoNeedsFixing } from '../../components/GeoPrecisionBadge';
import { PinCoordinateControl } from '../../components/PinCoordinateControl';
import { Autocomplete } from '../../components/ui/Autocomplete';
import type { Assayer } from './assayer-shared';
import {
  STATUS_COLORS, money, missingCriticalFields,
  fieldLabelStyle as label,
  buildAssayerEditBody, changedFormKeys, onboardingNextStep,
  isSensitiveKey, maskedIdentifier, type SensitiveRecordKey,
} from './assayer-shared';
import { SensitiveValue } from './SensitiveValue';
import {
  EDIT_FIELDS, PERFORMANCE_RATINGS, useManagerOptions, useHrOwnerOptions, applyPlace, GEO_AUTO_FIELDS, resolveIfsc,
  type FieldDef, type IfscInfo,
} from './AssayerForms';
import { fmtDate, fmtWhen } from '../../utils/dates';
import { isAbsentById, userMessage } from '../../services/errors';
import { LoadFailure, caughtLoad } from '../../components/LoadFailure';
import { CommercialProfileModal, type CommercialProfile } from './CommercialProfileModal';
import { AssayerRemarks } from '../../components/AssayerRemarks';
import {
  AssayerVettingTab, STANDING_LABELS, standingStance, STANDING_STANCE_TONE,
  VERDICT_LABELS, ADVERSE_BACKGROUND_VERDICTS, humanizeEnum,
} from './AssayerVettingTab';
import { AssayerQualificationTab } from './AssayerQualificationTab';
import { AssayerSkillsPanel } from './AssayerSkillsPanel';
import { counted } from '../../utils/plural';
import { LIFECYCLE_MOVE_REASONS, OTHER_LIFECYCLE_REASON, REHIRE_REASON } from './lifecycle-reason-vocabulary';
import { resolveRecordSection, type SummaryGroupKey } from './record-sections';
import { canDeleteAssayers, useCurrentRoles } from '../../hooks/useCurrentRoles';
import { queryClient } from '../../queryClient';
import { queryKeys } from '../../hooks/queryKeys';
import {
  invalidateLifecycleMutation,
  invalidateBankMutation,
} from '../../services/queryInvalidation';

// Domain and modular command center components
import type { AssayerDossier, FrozenPayableItem, ActiveAssignment } from './record/record-types';
import { DeploymentReadinessCard } from './record/DeploymentReadinessCard';
import { KycReadinessCard } from './record/KycReadinessCard';
import { BankProfileCard } from './record/BankProfileCard';
import { FrozenPayoutDestinationCard } from './record/FrozenPayoutDestinationCard';
import { EmpanelmentStandingCard } from './record/EmpanelmentStandingCard';
import { CurrentAssignmentsCard } from './record/CurrentAssignmentsCard';
import { RecentTimelineCard, type TimelineEvent } from './record/RecentTimelineCard';
import { DeleteAssayerModal } from './record/DeleteAssayerModal';

const ENGAGEMENT_LABELS: Record<string, string> = {
  [AssayerEngagementType.REGULAR]: 'Regular',
  [AssayerEngagementType.LOCAL]: 'Local',
  [AssayerEngagementType.BACK_UP]: 'Back-up',
  [AssayerEngagementType.AGENCY_AUDIT]: 'Agency audits',
  [AssayerEngagementType.MYSTERY_AUDIT]: 'Mystery audits',
};

const SIGN_IN_CLOSED_REASON: Partial<Record<AssayerLifecycleStatus, string>> = {
  [AssayerLifecycleStatus.INVITED]: 'They have only been invited — they cannot sign in until they accept.',
  [AssayerLifecycleStatus.ON_LEAVE]: 'They are marked on leave.',
  [AssayerLifecycleStatus.SUSPENDED]: 'It will not work while they are suspended — check their stage before handing this over.',
  [AssayerLifecycleStatus.INACTIVE]: 'They are marked inactive.',
  [AssayerLifecycleStatus.RESIGNED]: 'They have resigned — they have left, and sign-in is closed on their record.',
  [AssayerLifecycleStatus.TERMINATED]: 'Their engagement was terminated — they have left, and sign-in is closed on their record.',
  [AssayerLifecycleStatus.ARCHIVED]: 'Their record has been archived.',
};

const UNAVAILABLE_LABELS: Record<string, string> = {
  [AssayerUnavailableReason.REJECTED_BY_US]: 'Rejected by us',
  [AssayerUnavailableReason.NOT_INTERESTED]: 'Not interested',
  [AssayerUnavailableReason.DECEASED]: 'Deceased',
  [AssayerUnavailableReason.MOVED_ABROAD]: 'Moved abroad',
  [AssayerUnavailableReason.NO_WORK_IN_AREA]: 'No work in area',
  [AssayerUnavailableReason.MOVED_TO_COMPANY]: 'Moved to company',
};

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

export const HARD_TO_REVERSE_STAGES: string[] = [
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
];

const isRehireMove = (from: string, to: string): boolean =>
  (from === AssayerLifecycleStatus.RESIGNED || from === AssayerLifecycleStatus.TERMINATED)
  && to === AssayerLifecycleStatus.INVITED;

const coordinates = (a: Assayer): string | null => {
  if (a.latitude === null || a.latitude === undefined || a.longitude === null || a.longitude === undefined) return null;
  return `${Number(a.latitude).toFixed(4)}, ${Number(a.longitude).toFixed(4)}`;
};

const TABS = [
  { key: 'summary', label: 'Summary', icon: User },
  { key: 'commercial', label: 'Pay & terms', icon: CreditCard },
  { key: 'skills', label: 'Skills', icon: Award },
  { key: 'vetting', label: 'Vetting & background', icon: ShieldCheck },
  { key: 'documents', label: 'Documents', icon: FileCheck },
  { key: 'qualification', label: 'Qualification', icon: Gauge },
  { key: 'remarks', label: 'Remarks', icon: MessageSquare },
  { key: 'history', label: 'History', icon: Clock },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface SensitiveContextValue {
  assayerId: string;
  canReveal: boolean;
}
const SensitiveCtx = React.createContext<SensitiveContextValue | null>(null);

/**
 * What the profile fetch has actually told us — which is not the same question as "is `a` null?".
 *
 * `a === null` used to mean both "the answer has not arrived" and "the answer was that there is
 * no such person", and the screen rendered the first of those for both. So a record that does not
 * exist showed loading skeletons for ever: the API answered 404 in 40 ms, the console logged it,
 * and the page went on pretending to wait. A mistyped or stale link therefore looked identical to
 * a slow network, which is exactly the distinction an operator needs in order to know whether
 * waiting will help.
 *
 * Four states, because collapsing any two of them reintroduces the bug in a different place:
 * `failed` must not read as `absent` (a 500 does not mean the person was deleted), and `loading`
 * must not read as `failed` (a slow response is not an error).
 */
type ProfileLoad = 'loading' | 'ready' | 'absent' | 'failed';

export const AssayerRecord: React.FC<{
  assayerId: string;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
  reloadKey?: number;
  /**
   * There is no such person. Raised once per id, so the ROUTE can answer with the application's
   * own not-found page rather than this component inventing a second dialect of "missing" — see
   * AssayerRecordPage. Optional: mounted anywhere else, the component still renders its own
   * "no such record" panel below rather than skeletons.
   */
  onMissing?: (assayerId: string) => void;
}> = ({ assayerId, canManage, onClose, onChanged, reloadKey = 0, onMissing }) => {
  const [a, setA] = useState<Assayer | null>(null);
  const [profileLoad, setProfileLoad] = useState<ProfileLoad>('loading');
  /** Bumped by the retry button on the failure panel; re-runs the loader below. */
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<TabKey>('summary');
  const [dossier, setDossier] = useState<AssayerDossier | null>(null);
  const [frozenPayables, setFrozenPayables] = useState<FrozenPayableItem[]>([]);
  const [activeAssignments, setActiveAssignments] = useState<ActiveAssignment[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);

  /**
   * Which of the record's four SIDE loads could not be read, and why.
   *
   * The main profile request has said "failed" or "no such person" for a while. The four beside
   * it — the dossier, the frozen payables, the active assignments and the timeline — each caught
   * their own error, threw it away, and left their state at `[]` or `null`. The panels below
   * then drew, in the operator's own words:
   *
   *   - no empanelments and no background check, on a person who may hold both;
   *   - "No money has been booked against this person yet";
   *   - an empty Current work list, which is what somebody reads before they terminate a
   *     contractor or hand their branches to somebody else;
   *   - an empty history, which is what somebody reads before they conclude nothing happened.
   *
   * The dossier's `catch` even carried the comment "not entitled to dossier" — the refusal was
   * known at the point it was discarded, and still nothing on screen said so. Recorded here, keyed
   * by what the reader would call it, and cleared per load so a recovered fetch stops warning.
   */
  const [sideLoadErrors, setSideLoadErrors] = useState<Record<string, unknown>>({});

  const [dossierGlance, setDossierGlance] = useState<{
    empanelments: Array<{ id: string; status: string; statusReason?: string | null; client?: { id: string; name: string } | null }>;
    currentCheck: { cibilScore?: number | null; cibilBand?: string | null; checkedOn?: string | null; verdict?: string | null; findings?: string | null } | null;
    documentsTotal: number;
    documentsVerified: number;
    identityGapLabels: string[];
  } | null>(null);

  const [loaded, setLoaded] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [payModal, setPayModal] = useState<{ open: boolean; profile: CommercialProfile | null }>({ open: false, profile: null });
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  /** True while the ID card PDF is being fetched — a second click before it lands would ask the server to build the same file twice. */
  const [idCardBusy, setIdCardBusy] = useState(false);

  const { confirm, confirmDialog } = useConfirm();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const arrivedRef = useRef(false);
  const [flashGroup, setFlashGroup] = useState<SummaryGroupKey | null>(null);

  const roles = useCurrentRoles();
  const canDelete = canManage && (typeof canDeleteAssayers === 'function' ? canDeleteAssayers(roles) : true);

  // In-place editing state
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editInitial, setEditInitial] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const managerOpts = useManagerOptions(editing && canManage, assayerId);
  const hrOwnerOpts = useHrOwnerOptions(editing && canManage);

  const [credential, setCredential] = useState<{
    username: string;
    password?: string;
    canSignInNow?: boolean;
    accessScope?: string;
  } | null>(null);
  const [issuing, setIssuing] = useState<'invite' | 'reset' | null>(null);

  // Parallel data loading
  useEffect(() => {
    let cancelled = false;
    /**
     * A different person: forget the previous one before the new answer arrives.
     *
     * Without this the screen keeps rendering the record it already had while the next id loads —
     * and if that id turns out to be missing, it keeps rendering somebody else's name and PAN
     * right up until the 404 lands. A functional update rather than a plain `setA(null)` because
     * a `reloadKey` bump re-runs this effect for the SAME person after a save, and blanking the
     * record to skeletons on every save is the flicker this component was built to avoid.
     */
    setA((prev) => (prev && prev.id !== assayerId ? null : prev));
    setProfileLoad('loading');
    setSideLoadErrors({});
    /** Remember a side load's failure under the name the panel it feeds goes by on screen. */
    const sideFailed = (what: string) => (e: unknown) => {
      if (!cancelled) setSideLoadErrors((prev) => ({ ...prev, [what]: e }));
    };
    // 1. Assayer Profile — the one request that decides whether this screen has a subject at all.
    api.request<Assayer>(`/assayers/${assayerId}`)
      .then((fresh) => { if (!cancelled) { setA(fresh); setProfileLoad('ready'); } })
      .catch((e) => {
        if (cancelled) return;
        /**
         * Absent, not broken. `isAbsentById` is the single place that decides which statuses mean
         * "this id addresses nothing" (404, and the 400 a malformed uuid earns from
         * ParseUUIDPipe) — see services/errors.ts. An ARCHIVED assayer is NOT absent: reads
         * resolve one and answer 200, so it lands on the `ready` branch above and renders like
         * anybody else, which is the whole reason this cannot key off lifecycle state.
         */
        if (isAbsentById(e)) {
          setA(null);
          setProfileLoad('absent');
          onMissing?.(assayerId);
          return;
        }
        setErr(userMessage(e));
        setProfileLoad('failed');
      });

    // 2. Dossier
    api.request<AssayerDossier>(`/assayers/${assayerId}/dossier`)
      .then((d) => {
        if (cancelled) return;
        setDossier(d);
        const onboarding: any[] = Array.isArray(d?.onboarding) ? d.onboarding : [];
        setDossierGlance({
          empanelments: d?.empanelments ?? [],
          currentCheck: d?.currentCheck ?? null,
          documentsTotal: onboarding.length,
          documentsVerified: onboarding.filter((r) => r.verificationStatus === 'VERIFIED').length,
          identityGapLabels: onboarding
            .filter((r) => IDENTITY_GATE_DOCUMENTS.includes(r.requirement) && r.verificationStatus !== 'VERIFIED')
            .map((r) => r.label ?? humanizeEnum(String(r.requirement))),
        });
      })
      // Most often a refusal — the dossier is empanelment, background checks and documents, which
      // not every HR role may see. Named rather than swallowed: the glance panels below cannot
      // tell "no empanelments" from "not shown to you" on their own.
      .catch(sideFailed('their empanelment and background file'));

    // 3. Frozen Payables (snapshot)
    api.request<any[]>(`/assayers/${assayerId}/payables`)
      .then((p) => { if (!cancelled && Array.isArray(p)) setFrozenPayables(p); })
      .catch((e) => { if (!cancelled) setFrozenPayables([]); sideFailed('what they have been paid')(e); });

    // 4. Active Assignments
    api.request<{ items: ActiveAssignment[] }>(`/assignments/assayer/${assayerId}?scope=active`)
      .then((res) => { if (!cancelled && Array.isArray(res?.items)) setActiveAssignments(res.items); })
      .catch((e) => { if (!cancelled) setActiveAssignments([]); sideFailed('their current work')(e); });

    // 5. Activity Timeline
    api.request<any>(`/assayers/${assayerId}/activity`)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
        setTimelineEvents(list);
      })
      .catch((e) => { if (!cancelled) setTimelineEvents([]); sideFailed('their history')(e); });

    return () => { cancelled = true; };
    // `onMissing` is the parent's callback and is deliberately not a dependency: it is an
    // identity-less arrow in AssayerRecordPage, so listing it would re-fire all five requests on
    // every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assayerId, reloadKey, attempt]);

  // Tab per-content caching
  useEffect(() => {
    if (tab === 'summary' || loaded[tab] !== undefined) return;
    const url: Partial<Record<TabKey, string>> = {
      commercial: `/assayers/${assayerId}/commercial`,
      history: `/assayers/${assayerId}/activity`,
    };
    const tabUrl = url[tab];
    if (!tabUrl) return;
    api.request<any[]>(tabUrl)
      .then((d) => setLoaded((p) => ({ ...p, [tab]: Array.isArray(d) ? d : [] })))
      // The Pay and History tabs each render "nothing here yet" off an empty array, so a refused
      // tab fetch read as a person with no commercial terms and no recorded history. Same
      // treatment as the four side loads above: the tab still renders, and the banner says why
      // it is bare.
      .catch((e) => {
        setLoaded((p) => ({ ...p, [tab]: [] }));
        setSideLoadErrors((prev) => ({ ...prev, [tab === 'commercial' ? 'their pay and terms' : 'their history']: e }));
      });
  }, [tab, assayerId, loaded]);

  // Manager display resolution
  const [managerLookup, setManagerLookup] = useState<{ id: string; name: string | null } | null>(null);
  useEffect(() => {
    const managerId = a?.managerId;
    if (!managerId) return;
    let cancelled = false;
    api.request<Assayer>(`/assayers/${managerId}`)
      .then((m) => {
        if (cancelled) return;
        setManagerLookup({ id: managerId, name: m.assayerCode ? `${m.displayName} · ${m.assayerCode}` : m.displayName });
      })
      .catch(() => { if (!cancelled) setManagerLookup({ id: managerId, name: null }); });
    return () => { cancelled = true; };
  }, [a?.managerId]);

  const managerDisplay = !a?.managerId ? null
    : managerLookup?.id === a.managerId
      ? (managerLookup.name ?? a.managerId)
      : 'Loading…';

  // Deep linking and URL navigation
  useEffect(() => {
    if (arrivedRef.current || !a) return;
    arrivedRef.current = true;
    const targetSection = resolveRecordSection(searchParams.get('section'));
    if (targetSection) {
      setTab(targetSection.tab);
      if (targetSection.group) setFlashGroup(targetSection.group);
    }
    if (searchParams.get('edit') === '1' && canManage) startEdit();
    if (searchParams.has('edit') || searchParams.has('section')) {
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      next.delete('section');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, canManage]);

  useEffect(() => {
    if (!flashGroup) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(`record-group-${flashGroup}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    });
    const fade = setTimeout(() => setFlashGroup(null), 2400);
    return () => { cancelAnimationFrame(raf); clearTimeout(fade); };
  }, [flashGroup]);

  // Edit methods
  const snapshotEdit = (rec: Assayer): Record<string, string> => {
    const f: Record<string, string> = {};
    for (const key of SUMMARY_EDIT_KEYS) {
      if (isSensitiveKey(key)) { f[key] = ''; continue; }
      let val = (rec as any)[key];
      if (key === 'dateOfBirth' || key === 'joiningDate') val = val ? new Date(val).toISOString().split('T')[0] : '';
      else val = val !== null && val !== undefined ? String(val) : '';
      f[key] = val;
    }
    return f;
  };

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
      if (problems.length) { setErr(`Could not save. ${problems.join(' ')}`); return; }
      await api.request(`/assayers/${a.id}`, { method: 'PUT', body: JSON.stringify(body) });
      toast({ type: 'success', title: 'Saved', message: `${counted(changed.length, 'change')} saved.` });
      const hasBankChange = changed.some((k) => ['bankAccountNumber', 'ifscCode', 'bankName', 'bankAccountName'].includes(k));
      if (hasBankChange) {
        void invalidateBankMutation(queryClient, a.id);
      } else {
        void queryClient.invalidateQueries({ queryKey: ['assayer-record', a.id] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.hr.rosterAll });
      }
      setEditing(false);
      onChanged();
      const fresh = await api.request<Assayer>(`/assayers/${assayerId}`);
      setA(fresh);
    } catch (e) {
      setErr(`Could not save. ${userMessage(e)}`);
    } finally {
      setSavingEdit(false);
    }
  };

  const editCtx: EditCtx | undefined = editing
    ? {
        form: editForm,
        set: (key, val) => setEditForm((f) => ({ ...f, [key]: val })),
        setMany: (next) => setEditForm(next),
        reveal: revealSensitive,
        managers: managerOpts.people ? managerOpts.people.map((p) => ({ id: p.value, name: p.label })) : null,
        hrOwners: hrOwnerOpts.people ? hrOwnerOpts.people.map((p) => p.label) : null,
      }
    : undefined;

  // Lifecycle transition handling with 409 concurrency protection
  // Lifted out of both memos: they only ever depended on this one field, but referencing `a`
  // inside the callback made the rule ask for the whole record as a dependency -- which changes
  // identity on every refetch and would have recomputed both on every one.
  const lifecycleStatus = a?.lifecycleStatus;
  const transitions = useMemo(
    () => (lifecycleStatus ? nextAssayerLifecycleStates(lifecycleStatus) : []),
    [lifecycleStatus],
  );
  const forwardStep = useMemo(
    () => (lifecycleStatus ? nextOnboardingStep(lifecycleStatus) : null),
    [lifecycleStatus],
  );

  const startMove = (to: string) => {
    setErr(null);
    if (AssayerService_LIFECYCLE_MOVES_NEEDING_A_REASON.has(to as AssayerLifecycleStatus) || isRehireMove(a?.lifecycleStatus ?? '', to)) {
      setTarget(to);
      setReason(isRehireMove(a?.lifecycleStatus ?? '', to) ? REHIRE_REASON : '');
    } else {
      void move(to);
    }
  };

  const move = async (to: string, why?: string) => {
    if (!a) return;
    if (a.lifecycleStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION && to === AssayerLifecycleStatus.BACKGROUND_VERIFICATION && dossierGlance && dossierGlance.documentsVerified === 0) {
      const ok = await confirm({
        title: `Move ${a.displayName} to ${assayerLifecycleLabel(to)}?`,
        message: `No documents have been checked yet — 0 of ${dossierGlance.documentsTotal} on their dossier are verified. Move them on anyway?`,
        confirmLabel: `Move to ${assayerLifecycleLabel(to)}`,
      });
      if (!ok) return;
    }

    if (
      a.lifecycleStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION
      && to === AssayerLifecycleStatus.TRAINING
      && dossierGlance?.currentCheck?.verdict
      && ADVERSE_BACKGROUND_VERDICTS.includes(dossierGlance.currentCheck.verdict)
    ) {
      const verdict = dossierGlance.currentCheck.verdict;
      const finding = (VERDICT_LABELS[verdict] ?? humanizeEnum(verdict))
        + (dossierGlance.currentCheck.findings ? ` — ${dossierGlance.currentCheck.findings}` : '');
      const ok = await confirm({
        title: `Move ${a.displayName} to ${assayerLifecycleLabel(to)}?`,
        message: (
          <>
            Their background check recorded: <strong style={{ color: 'var(--warning)' }}>{finding}</strong>.
            {' '}Moving them forward does not clear it. Continue?
          </>
        ),
        confirmLabel: `Move to ${assayerLifecycleLabel(to)}`,
      });
      if (!ok) return;
    }

    if (a.lifecycleStatus === AssayerLifecycleStatus.TRAINING && to === AssayerLifecycleStatus.ACTIVE) {
      const missingFields = missingCriticalFields(a);
      const gaps = [...missingFields.map((f) => f.label), ...(dossierGlance?.identityGapLabels ?? [])];
      const ok = await confirm({
        title: `Move ${a.displayName} to ${assayerLifecycleLabel(to)}?`,
        message: gaps.length === 0
          ? 'Everything needed is on file.'
          : `Still missing: ${gaps.join(', ')}. The identity gate is set to warn, so activation will proceed — these gaps stay on their record.`,
        confirmLabel: `Move to ${assayerLifecycleLabel(to)}`,
      });
      if (!ok) return;
    }

    if (HARD_TO_REVERSE_STAGES.includes(to as AssayerLifecycleStatus)) {
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
      toast({ type: 'success', title: 'Status updated', message: `Moved to ${assayerLifecycleLabel(to)}.` });
      void invalidateLifecycleMutation(queryClient, assayerId);
      const fresh = await api.request<Assayer>(`/assayers/${assayerId}`);
      setA(fresh);
      setTarget(''); setReason('');
      setLoaded((p) => ({ ...p, history: undefined }));
      onChanged();
    } catch (e: any) {
      const msg = userMessage(e);
      // Invariant 9: Lifecycle Concurrency Recovery
      if (msg.includes('Illegal lifecycle transition') || e?.status === 409 || msg.includes('stale') || msg.includes('modified concurrently')) {
        setErr(`Conflict: The assayer record changed elsewhere. Stale transition aborted. Reloading fresh server truth...`);
        setTarget(''); setReason('');
        void invalidateLifecycleMutation(queryClient, assayerId);
        try {
          const fresh = await api.request<Assayer>(`/assayers/${assayerId}`);
          setA(fresh);
          const freshDossier = await api.request<AssayerDossier>(`/assayers/${assayerId}/dossier`);
          setDossier(freshDossier);
        } catch { /* ignore reload error */ }
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  // Account access actions
  const issueAppAccess = async () => {
    setIssuing('invite'); setErr(null);
    try {
      const res = await api.request<{ username: string; temporaryPassword?: string; canSignInNow?: boolean; accessScope?: string }>(
        `/assayers/${assayerId}/app-access`,
        { method: 'POST' },
      );
      setCredential({ username: res.username, password: res.temporaryPassword, canSignInNow: res.canSignInNow, accessScope: res.accessScope });
      onChanged();
    } catch (e) { setErr(userMessage(e)); }
    finally { setIssuing(null); }
  };

  const resetPassword = async () => {
    if (!a) return;
    const ok = await confirm({
      title: `Reset password for ${a.displayName}?`,
      message: 'Their current password stops working immediately. A temporary password will be shown for you to read to them.',
      confirmLabel: 'Reset password',
      tone: 'danger',
    });
    if (!ok) return;
    setIssuing('reset'); setErr(null);
    try {
      const res = await api.request<{ username: string; temporaryPassword?: string; canSignInNow?: boolean; accessScope?: string }>(
        `/assayers/${assayerId}/reset-password`,
        { method: 'POST' },
      );
      setCredential({ username: res.username, password: res.temporaryPassword, canSignInNow: res.canSignInNow, accessScope: res.accessScope });
      onChanged();
    } catch (e) { setErr(userMessage(e)); }
    finally { setIssuing(null); }
  };

  /**
   * Streams the templated ID card PDF and saves it — same pattern the roster's template
   * download uses (`downloadTemplate` in AssayerRoster.tsx): fetch through `api.request` with
   * `raw: true` so the auth header rides along (a plain `<a href>` to this route cannot carry
   * the bearer token), turn the blob into an object URL, and click a throwaway anchor. The
   * route has no JSON envelope at all — it answers the raw PDF bytes — so this is the one place
   * on the record that talks to it as a file rather than as data.
   */
  const downloadIdCard = async () => {
    if (!a) return;
    setIdCardBusy(true);
    setErr(null);
    try {
      const blob = await api.request<Blob>(`/assayers/${assayerId}/id-card`, { raw: true } as any);
      const url = URL.createObjectURL(blob as any);
      const el = document.createElement('a');
      el.href = url;
      el.download = `${a.assayerCode}-id-card.pdf`;
      document.body.appendChild(el);
      el.click();
      el.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(`Could not download the ID card. ${userMessage(e)}`);
    } finally {
      setIdCardBusy(false);
    }
  };

  if (!a) {
    /**
     * Three different answers, and the screen has to say which one it is.
     *
     * The route above renders the application's own not-found page for `absent` (see
     * AssayerRecordPage), so reaching this branch means either nobody is listening for it or the
     * component is mounted outside a route — in which case saying so here still beats skeletons.
     */
    if (profileLoad === 'absent') {
      return (
        <div data-testid="assayer-record-missing" style={{ padding: '24px', background: 'var(--bg-card)', borderRadius: '12px', color: 'var(--text-secondary)', fontSize: '13.5px' }}>
          <strong style={{ display: 'block', marginBottom: '6px', color: 'var(--text-primary)', fontSize: '15px' }}>No such person</strong>
          There is no record on this roster with that reference. It may have been removed, or the
          link may have been mistyped or gone stale.
        </div>
      );
    }
    /**
     * A failure is not an absence and must not be rendered as one — the record may be perfectly
     * intact behind a server that is having a bad minute. So this says the load failed, keeps the
     * server's own sentence, and offers the one action that can actually help.
     */
    if (profileLoad === 'failed') {
      return (
        <div data-testid="assayer-record-failed" style={{ padding: '24px', background: 'var(--bg-card)', borderRadius: '12px' }}>
          <AlertBanner
            type="error"
            message={err ?? 'This record could not be loaded.'}
          />
          <button
            type="button"
            onClick={() => { setErr(null); setAttempt((n) => n + 1); }}
            style={{
              marginTop: '12px', padding: '7px 14px', fontSize: '13px', cursor: 'pointer',
              background: 'var(--bg-secondary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: '7px',
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <div data-testid="assayer-record-loading" style={{ padding: '24px', background: 'var(--bg-card)', borderRadius: '12px' }}>
        <SkeletonList rows={5} height={40} />
      </div>
    );
  }

  const missing = missingCriticalFields(a);
  const criticalKeys = new Set(missing.map((f) => f.key));
  const alsoIncomplete = ASSAYER_RECORD_FIELDS.filter((f) => {
    if (criticalKeys.has(f.key as any)) return false;
    const v = (a as any)[f.key];
    return v === null || v === undefined || v === '';
  });

  const sensitiveContext = { assayerId, canReveal: canManage };
  const commercialRows = loaded.commercial;
  const bankMissing = !a.bankAccountNumber || !a.ifscCode;

  return (
    <SensitiveCtx.Provider value={sensitiveContext}>
      <div
        data-testid="assayer-record"
        style={{
          background: 'var(--bg-card)',
          borderRadius: '12px',
          border: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: '600px',
        }}
      >
        {/* Profile Header */}
        <header style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {a.displayName}
                </h2>
                <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--text-muted)' }}>
                  {a.assayerCode}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: '999px',
                    background: 'var(--bg-surface-2)',
                    color: STATUS_COLORS[a.lifecycleStatus] ?? 'inherit',
                  }}
                >
                  {assayerLifecycleLabel(a.lifecycleStatus)}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px', fontSize: '12.5px', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                {a.city && <span>{a.city}, {a.state}</span>}
                {a.phone && <span>{a.phone}</span>}
                {a.email && <span>{a.email}</span>}
              </div>
              {onboardingNextStep(a) && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Next: they are {onboardingNextStep(a)}.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
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
              {canDelete && !editing && (
                <button
                  onClick={() => setDeleteModalOpen(true)}
                  className="btn btn-secondary"
                  title="Delete assayer profile"
                  style={{ fontSize: '12px', padding: '6px 10px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <Trash2 size={12} /> Delete
                </button>
              )}
              {canManage && !editing && (
                <button
                  onClick={downloadIdCard}
                  disabled={idCardBusy}
                  className="btn btn-secondary"
                  title="Download a templated ID card as a PDF"
                  style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <Download size={12} /> {idCardBusy ? 'Preparing…' : 'Download ID Card'}
                </button>
              )}
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
          </div>
        </header>

        {/* Tab Navigation */}
        <nav style={{ display: 'flex', gap: '2px', padding: '0 12px', borderBottom: '1px solid var(--border-color)', overflowX: 'auto', background: 'var(--bg-surface-2)' }}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px', padding: '10px 12px',
                  fontSize: '12px', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                  whiteSpace: 'nowrap', flexShrink: 0,
                  color: on ? 'var(--accent-primary)' : 'var(--text-muted)',
                  borderBottom: `2px solid ${on ? 'var(--accent-primary)' : 'transparent'}`,
                }}
              >
                <Icon size={12} /> {t.label}
              </button>
            );
          })}
        </nav>

        {/* Tab Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          <AlertBanner type="error" message={err} onClose={() => setErr(null)} style={{ marginBottom: '14px' }} />

          {/*
            One line per part of the record that is missing because it could not be read, rather
            than because there is nothing there. Not dismissible: the panels underneath go on
            showing their empty states for as long as the load is failing, so the sentence that
            corrects them has to stay up as long as they do. `attempt` is the same counter the
            main profile's "Try again" uses, so Retry re-runs every one of these together.
          */}
          {Object.keys(sideLoadErrors).length > 0 && (
            <LoadFailure
              style={{ marginBottom: '14px' }}
              loads={Object.entries(sideLoadErrors).map(([label, error]) => ({
                label,
                query: caughtLoad(error, () => setAttempt((n) => n + 1)),
              }))}
            />
          )}

          {tab === 'summary' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Warnings & Gaps */}
              {a.workDoneBySomeoneElse && (
                <div style={{ padding: '11px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--danger)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--danger)', fontWeight: 700, fontSize: '12.5px' }}>
                    <AlertTriangle size={14} /> Their work is being done by somebody else
                  </div>
                  <div style={{ margin: '7px 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    The roster records that audits under this code are attended by a member of staff, a relative or a friend — not by the person empanelled here. Resolve this before planning any further work on this code.
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
                  {alsoIncomplete.length > 0 && (
                    <div style={{ marginTop: '7px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {counted(alsoIncomplete.length, 'other field is', 'other fields are')} also empty — {alsoIncomplete.map((f) => f.label.toLowerCase()).join(', ')}. Nothing is blocked by them.
                    </div>
                  )}
                  {canManage && !editing && (
                    <button onClick={startEdit} className="btn btn-secondary" style={{ fontSize: '12px', padding: '5px 10px', marginTop: '9px' }}>
                      Fill them in
                    </button>
                  )}
                </div>
              )}

              {/* READ MODE: The Decision-Oriented Command Center (Six Operator Questions) */}
              {!editing && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* Q3 & Q4: Can they currently be deployed? Why blocked? */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '14px', alignItems: 'start' }}>
                    <DeploymentReadinessCard
                      assayer={a}
                      dossier={dossier}
                      onInspectDocuments={() => setTab('documents')}
                      onInspectVetting={() => setTab('vetting')}
                    />
                    <KycReadinessCard
                      dossier={dossier}
                      assayerStatus={a.lifecycleStatus}
                      onReviewDocuments={() => setTab('documents')}
                    />
                  </div>

                  {/* Q5 & Q6: Can they currently be paid? What bank destination for approved payables? */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '14px', alignItems: 'start' }}>
                    <BankProfileCard
                      assayer={a}
                      canManage={canManage}
                      onEditBank={() => { startEdit(); setFlashGroup('financial'); }}
                    />
                    <FrozenPayoutDestinationCard
                      payables={frozenPayables}
                    />
                  </div>

                  {/* Q7: What are they doing now? Client standings with hard blocks */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '14px', alignItems: 'start' }}>
                    <CurrentAssignmentsCard
                      assayerId={a.id}
                      assignments={activeAssignments}
                    />
                    <EmpanelmentStandingCard
                      empanelments={dossier?.empanelments || []}
                      onManageVetting={() => setTab('vetting')}
                    />
                  </div>

                  {/* Backward-compatible Dossier Strip */}
                  {dossierGlance && (
                    <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px 16px' }}>
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
                                {STANDING_LABELS[e.status] ?? humanizeEnum(e.status)}
                              </span>
                            </span>
                          );
                        })}
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

                  {/* Confirmed Activity & Audit Events */}
                  <RecentTimelineCard
                    events={timelineEvents}
                    onViewAll={() => setTab('history')}
                  />
                </div>
              )}

              {/* Lifecycle Actions */}
              {canManage && transitions.length > 0 && (
                <section>
                  <div style={{ ...label, marginBottom: '7px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <ArrowRightLeft size={11} /> What happens next
                  </div>
                  {onboardingNextStep(a) && (
                    <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
                      Onboarding is not finished — they are {onboardingNextStep(a)}.
                    </div>
                  )}

                  {forwardStep && (
                    <StageStep
                      to={forwardStep}
                      primary
                      rehire={isRehireMove(a.lifecycleStatus, forwardStep)}
                      busy={busy}
                      asking={target === forwardStep}
                      reason={reason}
                      onReason={setReason}
                      onPress={() => startMove(forwardStep)}
                      onConfirm={() => void move(forwardStep, reason)}
                      onCancel={() => { setTarget(''); setReason(''); }}
                    />
                  )}

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
                            rehire={isRehireMove(a.lifecycleStatus, t)}
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

              {/* Account Access */}
              {canManage && (
                <section>
                  <div style={{ ...label, marginBottom: '7px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <KeyRound size={11} /> Account access
                  </div>
                  {credential ? (
                    <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--status-active-bg)', border: '1px solid var(--success)' }}>
                      {credential.username && (
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                          They sign in as <code style={{ fontWeight: 700, userSelect: 'all' }}>{credential.username}</code>
                        </div>
                      )}
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                        Temporary password — read it to the assayer now, it will not be shown again:
                      </div>
                      <code style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em', color: 'var(--success)', userSelect: 'all' }}>{credential.password}</code>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '5px' }}>
                        They will be asked to choose their own at next sign-in.
                      </div>
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
                            They can sign in with this straight away, but only to finish their own registration — uploading their papers and their own details. The rest of the app opens once their joining checks are signed off.
                          </span>
                        </div>
                      )}
                      <button onClick={() => setCredential(null)} className="btn btn-secondary" style={{ fontSize: '12px', padding: '5px 10px', marginTop: '9px' }}>
                        I have read it out
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <button onClick={issueAppAccess} disabled={!!issuing} className="btn btn-secondary" style={{ fontSize: '12px', padding: '7px 13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <KeyRound size={13} /> {issuing === 'invite' ? 'Creating…' : 'Give them app access'}
                      </button>
                      <button onClick={resetPassword} disabled={!!issuing} className="btn btn-secondary" style={{ fontSize: '12px', padding: '7px 13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <KeyRound size={13} /> {issuing === 'reset' ? 'Resetting…' : 'Reset password'}
                      </button>
                    </div>
                  )}
                </section>
              )}

              {/* Fact Groups (Shown both in Edit Mode and Read Mode) */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: '12px' }}>
                <FactGroup edit={editCtx} anchor="contact" flash={flashGroup} title="How to reach them" rows={[
                  ['Phone', a.phone, 'phone'],
                  ['Alternate phone', a.alternatePhone, 'alternatePhone'],
                  ['Email', a.email, 'email'],
                  ['Emergency contact', a.emergencyContactName, 'emergencyContactName'],
                  ['Emergency phone', a.emergencyContactPhone, 'emergencyContactPhone'],
                  ['Emergency relation', a.emergencyContactRelation, 'emergencyContactRelation'],
                ]} />

                <FactGroup
                  edit={editCtx}
                  anchor="location"
                  flash={flashGroup}
                  title="Where they are"
                  rows={[
                    ['Address', a.address, 'address'],
                    ['City or town', a.city, 'city'],
                    ['District', a.district, 'district'],
                    ['State', a.state, 'state'],
                    ['Pincode', a.pincode, 'pincode'],
                    ['Region', a.region],
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
                    <>
                      {geoNeedsFixing(a.geoSource) && (
                        <div style={{ fontSize: '12px', color: 'var(--warning)', lineHeight: 1.5 }}>
                          {coordinates(a)
                            ? 'This pin is a stand-in, not their home — it can be tens of kilometres out, so distance filtering and travel costs based on it will be wrong.'
                            : 'No home location has been recorded, so this person is left out of every distance-based search.'}
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

                <FactGroup edit={editCtx} anchor="job" flash={flashGroup} title="Their job" rows={[
                  ['Employment', employmentTypeLabel(a.employmentType), 'employmentType'],
                  ['Employee ID', a.employeeId, 'employeeId'],
                  ['Department', a.department, 'department'],
                  ['Joined', fmtDate(a.joiningDate), 'joiningDate'],
                  ...(a.exitDate ? ([['Left', fmtDate(a.exitDate)]] as [string, any][]) : []),
                  ['Experience', `${a.experienceYears ?? 0} years`, 'experienceYears'],
                  ['Engaged as', a.engagementType ? (ENGAGEMENT_LABELS[a.engagementType] ?? a.engagementType) : null, 'engagementType'],
                  ['Availability', a.unavailableReason ? (UNAVAILABLE_LABELS[a.unavailableReason] ?? a.unavailableReason) : 'Available for work', 'unavailableReason'],
                  ['Reporting manager', managerDisplay, 'managerId'],
                  ['HR owner', a.hrOwnerName, 'hrOwnerName'],
                  ['Performance rating',
                    a.performanceRating
                      ? (PERFORMANCE_RATINGS.find((r) => r.value === String(a.performanceRating))?.label ?? `${a.performanceRating}`)
                      : <span style={{ color: 'var(--text-muted)' }}>Not rated yet</span>,
                    'performanceRating'],
                ]} />

                <FactGroup
                  edit={editCtx}
                  anchor="identity"
                  flash={flashGroup}
                  title="Who they are"
                  footer={(
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      Aadhaar and PAN are kept in full and encrypted. Screens show the last few digits only; showing the whole number is a deliberate click, and each one goes into the audit log with your name and the time.
                    </div>
                  )}
                  rows={[
                    ['Date of birth', fmtDate(a.dateOfBirth), 'dateOfBirth'],
                    ['Qualification', a.qualification, 'qualification'],
                    ['Aadhaar', maskedIdentifier(a.aadhaarNumber), 'aadhaarNumber'],
                    ['PAN', maskedIdentifier(a.panNumber), 'panNumber'],
                    ['Vault system code', a.vstsCode, 'vstsCode'],
                    ['Documents folder', a.documentsLink ? <a href={a.documentsLink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>Open folder</a> : null],
                  ]}
                />

                <FactGroup edit={editCtx} anchor="financial" flash={flashGroup} title="How they are paid" rows={[
                  ['Bank', a.bankName, 'bankName'],
                  ['Account', maskedIdentifier(a.bankAccountNumber), 'bankAccountNumber'],
                  ['IFSC', a.ifscCode, 'ifscCode'],
                ]} />

                <FactGroup edit={editCtx} anchor="workload" flash={flashGroup} title="How much work they can take" rows={[
                  ['Most jobs in a day', a.maxDailyWorkload, 'maxDailyWorkload'],
                  ['Most jobs in a week', a.maxWeeklyWorkload, 'maxWeeklyWorkload'],
                ]} />
              </div>
            </div>
          )}

          {tab === 'commercial' && (
            <div>
              {bankMissing ? (
                <div style={{
                  padding: '11px 13px', borderRadius: '8px', marginBottom: '12px',
                  background: 'var(--status-pending-bg)',
                  border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 700, fontSize: '12.5px', color: 'var(--warning)' }}>
                    <AlertTriangle size={14} /> No bank details — cannot be paid
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    The rates below decide what this assayer earns; the account they are paid into is on their record, under Financial.
                  </div>
                  {canManage && (
                    <button onClick={() => { startEdit(); setFlashGroup('financial'); }} className="btn btn-secondary" style={{ fontSize: '12px', padding: '5px 10px', marginTop: '9px' }}>
                      Add bank details
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                  Paid into account {maskedIdentifier(a.bankAccountNumber)} · IFSC {a.ifscCode}
                </div>
              )}
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

          {tab === 'vetting' && (
            <AssayerVettingTab
              assayerId={assayerId}
              canManage={canManage}
              section="checks"
              lifecycleStatus={a.lifecycleStatus}
              onGoToDocuments={() => setTab('documents')}
            />
          )}

          {tab === 'documents' && (
            <AssayerVettingTab assayerId={assayerId} canManage={canManage} section="documents" lifecycleStatus={a.lifecycleStatus} />
          )}

          {tab === 'qualification' && (
            <AssayerQualificationTab assayerId={assayerId} canManage={canManage} />
          )}

          {tab === 'remarks' && (
            <AssayerRemarks assayerId={assayerId} />
          )}

          {tab === 'history' && (
            <List
              rows={loaded.history}
              empty="Nothing recorded for this assayer yet. Status changes, assignments and HR updates will be listed here."
              render={(h: any) => (
                <div key={h.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-hair)' }}>
                  <div style={{ fontSize: '12.5px' }}>
                    {activityEventLabel(h.eventType)}
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

        {/* Commercial Profile Modal */}
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

        {/* Delete Assayer Modal */}
        <DeleteAssayerModal
          open={deleteModalOpen}
          onClose={() => setDeleteModalOpen(false)}
          assayerId={assayerId}
          assayerName={a.displayName}
          onDeleted={() => {
            setDeleteModalOpen(false);
            toast({ type: 'success', title: 'Deleted', message: `${a.displayName} has been soft-deleted.` });
            onClose();
          }}
        />
        {confirmDialog}
      </div>
    </SensitiveCtx.Provider>
  );
};

const AssayerService_LIFECYCLE_MOVES_NEEDING_A_REASON = new Set([
  AssayerLifecycleStatus.ON_LEAVE,
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.INACTIVE,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
]);

const StageStep: React.FC<{
  to: string;
  primary?: boolean;
  rehire?: boolean;
  busy: boolean;
  asking: boolean;
  reason: string;
  onReason: (v: string) => void;
  onPress: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ to, primary, rehire, busy, asking, reason, onReason, onPress, onConfirm, onCancel }) => {
  const stage = assayerLifecycleLabel(to);
  const buttonLabel = rehire ? 'Rehire — start onboarding again' : `Move to ${stage}`;
  const explainer = rehire
    ? 'They rejoin at the start: documents, background check and training are done again before they can work.'
    : (STAGE_CONSEQUENCE[to] ?? `They are moved to ${stage}.`);
  const [other, setOther] = useState(false);
  useEffect(() => { if (!asking) setOther(false); }, [asking]);

  const reasonChoices = rehire
    ? [{ value: REHIRE_REASON, label: REHIRE_REASON }]
    : LIFECYCLE_MOVE_REASONS.map((r) => ({ value: r, label: r }));

  return (
    <div
      style={{
        padding: primary ? '12px 14px' : '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${primary ? 'var(--accent-primary)' : 'var(--border-color)'}`,
        background: primary ? 'color-mix(in srgb, var(--accent-primary) 7%, transparent)' : 'var(--bg-surface-2)',
      }}
    >
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={asking ? onConfirm : onPress}
          disabled={busy || (asking && !reason.trim())}
          className={primary ? 'btn btn-primary' : 'btn btn-secondary'}
          style={{ fontSize: '12px', padding: primary ? '8px 14px' : '6px 12px', whiteSpace: 'nowrap' }}
        >
          {busy ? 'Moving…' : buttonLabel}
        </button>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, flex: '1 1 220px' }}>
          {explainer}
        </span>
      </div>
      {asking && (
        <div style={{ marginTop: '9px' }}>
          <label style={{ ...label, display: 'block', marginBottom: '4px' }} htmlFor={`reason-${to}`}>
            Why? This is kept on their employment record
          </label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 220px' }}>
              <Select
                id={`reason-${to}`}
                value={other ? OTHER_LIFECYCLE_REASON : reason}
                onChange={(v) => {
                  if (v === OTHER_LIFECYCLE_REASON) { setOther(true); onReason(''); } else { setOther(false); onReason(String(v)); }
                }}
                options={[
                  { value: '', label: 'Choose a reason…' },
                  ...reasonChoices,
                  { value: OTHER_LIFECYCLE_REASON, label: 'Other (type it in)' },
                ]}
                error={!reason.trim()}
              />
              {other && (
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => onReason(e.target.value)}
                  placeholder="e.g. no longer available for work in their area"
                  aria-label="Reason, in your own words"
                  style={{
                    padding: '7px 10px', fontSize: '12px', borderRadius: '6px',
                    background: 'var(--bg-page)', color: 'inherit',
                    border: `1px solid ${reason.trim() ? 'var(--border-color)' : 'var(--warning)'}`,
                  }}
                />
              )}
            </div>
            <button onClick={onCancel} disabled={busy} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const EDIT_FIELD_BY_KEY = new Map<string, FieldDef>(EDIT_FIELDS.map((f) => [f.key, f]));

const SUMMARY_EDIT_KEYS = [
  'phone', 'alternatePhone', 'email', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'address', 'city', 'district', 'state', 'pincode',
  'employmentType', 'employeeId', 'department', 'joiningDate', 'managerId', 'engagementType', 'unavailableReason', 'hrOwnerName',
  'dateOfBirth', 'qualification', 'aadhaarNumber', 'panNumber', 'vstsCode',
  'bankName', 'bankAccountNumber', 'ifscCode',
  'maxDailyWorkload', 'maxWeeklyWorkload', 'experienceYears', 'performanceRating',
];

interface EditCtx {
  form: Record<string, string>;
  set: (key: string, val: string) => void;
  setMany: (next: Record<string, string>) => void;
  reveal: (key: string, full: string) => void;
  managers: { id: string; name: string }[] | null;
  hrOwners: string[] | null;
}

const inlineControl: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: '12.5px', boxSizing: 'border-box',
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: '6px', outline: 'none',
};

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
  if (def.hrOwnerPicker) {
    const known = (ctx.hrOwners ?? []).includes(val);
    return (
      <select style={inlineControl} value={val} onChange={(e) => onChange(e.target.value)}>
        <option value="">{ctx.hrOwners === null ? 'Loading…' : '— none —'}</option>
        {val && !known && <option value={val}>{val} (recorded earlier)</option>}
        {(ctx.hrOwners ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    );
  }
  if (def.options) {
    const known = def.options.some((o) => o.value === val);
    const opts = val && !known ? [...def.options, { value: val, label: `${val} — as recorded` }] : def.options;
    return (
      <select style={inlineControl} value={val} onChange={(e) => onChange(e.target.value)}>
        <option value="">— choose —</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (GEO_AUTO_FIELDS.has(fieldKey)) {
    return (
      <Autocomplete
        value={val}
        onChange={onChange}
        onSelect={(place) => applyPlace(fieldKey, place, ctx.form, ctx.setMany)}
        placeholder={fieldKey === 'pincode' ? 'Search pincode…' : `Type to search ${def.label.toLowerCase()}…`}
        filterType={(r) => (fieldKey === 'pincode' ? !!r.pincode : true)}
      />
    );
  }
  if (fieldKey === 'ifscCode') {
    return <IfscInlineControl val={val} onChange={onChange} ctx={ctx} />;
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

const IfscInlineControl: React.FC<{ val: string; onChange: (v: string) => void; ctx: EditCtx }> = ({
  val, onChange, ctx,
}) => {
  const [info, setInfo] = useState<IfscInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const handleBlur = async () => {
    if (!isValidIfsc(val)) { setInfo(null); return; }
    setBusy(true);
    const result = await resolveIfsc(val);
    setBusy(false);
    setInfo(result);
    if (result) ctx.set('bankName', result.bankName);
  };
  return (
    <>
      <input
        type="text"
        style={{ ...inlineControl, fontFamily: 'monospace', textTransform: 'uppercase' }}
        value={val}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { void handleBlur(); }}
      />
      {busy && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Looking up…</div>}
      {!busy && info && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {info.bankName}
          {info.branchName ? ` — ${info.branchName}` : ''}
          {info.city ? `, ${info.city}` : ''}
          {info.state ? `, ${info.state}` : ''}
        </div>
      )}
    </>
  );
};

const FIELD_MONO_KEYS = new Set(['panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'employeeId']);

type Fact = [label: string, value: any, recordKey?: string];

const FactGroup: React.FC<{
  title: string; rows: Fact[]; edit?: EditCtx; footer?: React.ReactNode;
  anchor?: SummaryGroupKey; flash?: SummaryGroupKey | null;
}> = ({
  title, rows, edit, footer, anchor, flash,
}) => {
  const ringed = !!anchor && flash === anchor;
  return (
    <section
      id={anchor ? `record-group-${anchor}` : undefined}
      style={{
        background: 'var(--bg-card)', border: `1px solid ${ringed ? 'var(--accent)' : 'var(--border-color)'}`,
        boxShadow: ringed ? '0 0 0 2px var(--accent)' : 'none',
        transition: 'border-color 0.6s ease, box-shadow 0.6s ease',
        borderRadius: '10px', padding: '14px 16px', minWidth: 0,
      }}
    >
      <div style={{ ...label, marginBottom: '10px' }}>{title}</div>
      <Facts rows={rows} edit={edit} />
      {footer && <div style={{ marginTop: '10px' }}>{footer}</div>}
    </section>
  );
};

const Facts: React.FC<{ rows: Fact[]; edit?: EditCtx }> = ({ rows, edit }) => {
  const sensitive = React.useContext(SensitiveCtx);
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '11px', margin: 0 }}>
      {rows.map(([k, v, recordKey]) => {
        const editable = !!(edit && recordKey && EDIT_FIELD_BY_KEY.has(recordKey));
        const blank = v === null || v === undefined || v === '';
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
                v
              ) : String(v)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
};

const List: React.FC<{ rows: any[] | undefined; empty: string; render: (r: any) => React.ReactNode }> = ({
  rows, empty, render,
}) => {
  if (rows === undefined) return <SkeletonList rows={3} height={52} />;
  if (rows.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', padding: '18px 0' }}>{empty}</div>;
  return <>{rows.map(render)}</>;
};

export default AssayerRecord;
