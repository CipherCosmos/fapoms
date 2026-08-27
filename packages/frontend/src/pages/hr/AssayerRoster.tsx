import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, X, ChevronUp, ChevronDown, ExternalLink, Edit2, Trash2,
  AlertTriangle, Download, ArrowRightLeft, MapPin, CheckCircle2, Users, SlidersHorizontal, FileSpreadsheet,
} from 'lucide-react';
import { AssayerLifecycleStatus, assayerLifecyclePath, assayerLifecycleLabel, daysUntilExpiry } from '@fapoms/shared';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { connectSocket } from '../../services/socket';
import { Select, UploadExcelControls, useConfirm } from '../../components/ui';
import { ImportIssuesPanel } from './ImportIssuesPanel';
import { visibleSelection, hiddenSelectionNote } from '../../utils/selection';
import { useSearchParams } from 'react-router-dom';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { useExcelExport } from '../../hooks/useExcelExport';
import { CreateAssayerModal, EditAssayerModal } from './AssayerForms';
import type { Assayer } from './assayer-shared';
import { STATUS_COLORS, missingCriticalFields } from './assayer-shared';
import { AssayerDetailDrawer, STAGE_CONSEQUENCE, HARD_TO_REVERSE_STAGES } from './AssayerDetailDrawer';
import { fmtDate } from '../../utils/dates';
import { queryKeys } from '../../hooks/queryKeys';
import { counted } from '../../utils/plural';

/**
 * The workforce roster.
 *
 * Rebuilt from a 380px card list beside a detail panel, which showed about eight
 * people at a time and hid the facts HR actually act on. A roster is a table: you
 * scan it, sort it, filter it, and act on many rows at once. Detail moved to a
 * drawer so opening someone doesn't cost you your place in the list.
 *
 * The columns are chosen from what the HR console flags — record completeness,
 * lifecycle stage, tenure — so the thing the dashboard tells you to fix is the
 * thing you can see and fix here.
 */

/**
 * Which gaps stop a payout, as opposed to merely leaving the record untidy.
 *
 * The roster's "Record" column used to say only "3 missing", which reads as paperwork. It is
 * not: with no bank account, IFSC or PAN, that person cannot be paid at all, and today every
 * single assayer on the books is in exactly that state while showing a green ACTIVE stage. HR
 * had no way to see from this screen that a fully "Active" roster is a roster nobody can pay,
 * so the column now names the consequence and a segment collects the people it applies to.
 */
const PAYOUT_BLOCKING_KEYS: (keyof Assayer)[] = ['bankAccountNumber', 'ifscCode', 'panNumber'];

/** The payout-blocking gaps on one record, by their shared human labels. */
function payoutBlockers(a: Assayer): string[] {
  return missingCriticalFields(a)
    .filter((f) => PAYOUT_BLOCKING_KEYS.includes(f.key))
    .map((f) => f.label);
}

/** Stages that mean the person has left, whatever the date fields say. */
const EXITED_STAGES: string[] = [
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
];

const ONBOARDING_STAGES: string[] = [
  AssayerLifecycleStatus.INVITED,
  AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
  AssayerLifecycleStatus.TRAINING,
];

/** Legal next steps per stage, mirroring the backend state machine. */

/** Ordered path from `from` to `target` walking only legal transitions; [] if
 *  already there, null if unreachable. Mirrors the backend state machine so the
 *  roster can offer the same destinations the API will accept. */

/** One-click views onto the questions HR ask most. */
const SEGMENTS: { key: string; label: string; match: (a: Assayer) => boolean }[] = [
  { key: 'all', label: 'Everyone', match: () => true },
  { key: 'active', label: 'Active', match: (a) => a.lifecycleStatus === AssayerLifecycleStatus.ACTIVE },
  { key: 'onboarding', label: 'Onboarding', match: (a) => ONBOARDING_STAGES.includes(a.lifecycleStatus) },
  { key: 'incomplete', label: 'Incomplete record', match: (a) => missingFields(a).length > 0 },
  { key: 'unpayable', label: 'Cannot be paid', match: (a) => payoutBlockers(a).length > 0 },
  { key: 'unprofiled', label: 'No skills', match: (a) => !a.skills || a.skills.length === 0 },
  // Lifecycle status first, dates second — matching the server's headcount. Someone shown as
  // RESIGNED on the row itself has to appear under "Exited", whether or not a date was captured.
  {
    key: 'exited',
    label: 'Exited',
    match: (a) => EXITED_STAGES.includes(a.lifecycleStatus) || !!a.exitDate || !!a.terminationDate,
  },
  // 21 people on the roster have audits attended by a member of staff, a relative or a friend
  // rather than by the person empanelled. The drawer says so once the record is open; without a
  // chip there is no way to ask who they all are, and that is the only question worth asking
  // about a compliance flag.
  {
    key: 'someone-else',
    label: 'Work done by somebody else',
    match: (a) => a.workDoneBySomeoneElse === true,
  },
  // An expired certificate is refused by the eligibility gate, so the person is quietly
  // unassignable. This was the one question the retired compliance page answered that nothing
  // else did — "who has lapsed" — and it belongs with the other "who needs something" chips.
  {
    key: 'lapsed',
    label: 'Certificate lapsed',
    match: (a) => (a.certifications ?? []).some(
      (c) => c.expiryDate && (daysUntilExpiry(c.expiryDate) ?? 1) < 0,
    ),
  },
];

type SortKey = 'displayName' | 'assayerCode' | 'lifecycleStatus' | 'state' | 'experienceYears' | 'completeness' | 'joiningDate';

/**
 * The gaps in one record, by label.
 *
 * This file used to carry its own second copy of the critical-field list, and the two had
 * already drifted: the shared one counts a missing phone number and calls the field "Bank
 * account", this one ignored phone entirely and called it "Bank a/c". So the drawer and the
 * roster row disagreed about whether the same person's record was complete, and the "Incomplete
 * record" segment under-counted. One list, in `assayer-shared`, used by both.
 */
function missingFields(a: Assayer): string[] {
  return missingCriticalFields(a).map((f) => f.label);
}

/** Tenure in whole months, or null when the joining date was never captured. */
function tenureMonths(a: Assayer): number | null {
  if (!a.joiningDate) return null;
  const start = new Date(a.joiningDate).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24 * 30.44)));
}

const cell: React.CSSProperties = { padding: '9px 12px', fontSize: '12.5px', verticalAlign: 'middle' };
const head: React.CSSProperties = {
  padding: '8px 12px', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em',   color: 'var(--text-muted)', textAlign: 'left',
  whiteSpace: 'nowrap', userSelect: 'none',
};

export const AssayerRoster: React.FC<{
  /**
   * True totals for segments whose count must not be the loaded window's.
   * Keyed by segment key; a segment with no entry counts what arrived, as before.
   */
  exactCounts?: Partial<Record<string, number | undefined>>;
}> = ({ exactCounts }) => {

  const navigate = useNavigate();
  const canManage = canManageAssayers(useCurrentRoles());
  const { confirm, confirmDialog } = useConfirm();

  const [assayers, setAssayers] = useState<Assayer[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * `warn` exists for the partial outcome a bulk import produces — some rows landed, some did
   * not. Reporting that as `ok` hides the failures; reporting it as `err` implies nothing was
   * saved, and sends someone re-uploading a file that has already half-imported.
   *
   * `details` carries the per-row reasons. They belong on screen, not in the network tab.
   */
  const [notice, setNotice] = useState<
    { tone: 'ok' | 'warn' | 'err'; text: string; details?: string[] } | null
  >(null);
  const [noticeExpanded, setNoticeExpanded] = useState(false);

  // Worklists elsewhere link straight to a segment (`/hr/roster?segment=someone-else`), so a
  // row that says "21 appraisers have work attended by somebody else" lands on those 21 rather
  // than on the roster with the reader left to find the chip.
  const [segment, setSegment] = useState(
    () => {
      const wanted = new URLSearchParams(window.location.search).get('segment');
      return wanted && SEGMENTS.some((s) => s.key === wanted) ? wanted : 'all';
    },
  );
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'displayName', dir: 'asc' });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /**
   * Opened from the list, or landed on directly.
   *
   * `?assayer=<id>` exists because global search and the planning screen's excluded-candidates
   * list used to link to a separate full-page assayer profile — a second implementation of this
   * same drawer. They now arrive here instead, and this is what makes that link land on the
   * person rather than the top of the roster.
   */
  const [searchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(searchParams.get('assayer'));
  /** Incremented by `refresh()`; the detail drawer re-reads the record when it changes. */
  const [detailVersion, setDetailVersion] = useState(0);
  const [editing, setEditing] = useState<Assayer | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkTarget, setBulkTarget] = useState('');
  const { download: downloadExcel, busy: exporting } = useExcelExport();
  const handleExportExcel = () => void downloadExcel('/reports/assayer-roster');
  const [busy, setBusy] = useState(false);
  /**
   * A roster import runs for as long as the server takes to read the sheet, and nothing on
   * screen said so — the file dialog simply closed. Operators picked the file again, and two
   * overlapping imports re-run every row against a roster the first is still writing.
   */
  const [uploading, setUploading] = useState(false);
  /**
   * The per-row outcome of the last bulk move. Names are captured *at send time*: the report is
   * read after `refresh()` has replaced the roster, and a row that was archived out of the
   * current view then had no name left to look up — the skipped list rendered as a bare stage
   * with no indication of who it was about, and failures as eight characters of a UUID.
   */
  const [bulkReport, setBulkReport] = useState<{
    target: string;
    succeeded: string[];
    skipped: { id: string; current: string; reason: string }[];
    failed: { id: string; reason: string }[];
    names: Record<string, string>;
  } | null>(null);
  const RENDER_CHUNK = 200;
  /** How many rows the roster asks for at once. The chips count what arrives. */
  const ROSTER_LIMIT = 1000;
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  /** How many the server holds, which is not always how many arrived. */
  const [rosterTotal, setRosterTotal] = useState(0);
  const queryClient = useQueryClient();

  /**
   * The roster, and how big the set it came from actually is.
   *
   * This asked for a thousand rows and then counted them for every filter chip, while the tab
   * badge above reads the server's own total. Past a thousand people the two silently describe
   * different things — "Everyone 1,000" under a badge saying 1,400 — and every other chip
   * counts an arbitrary window of the roster ordered by creation date. The account's region
   * scope narrows this list too, and does not narrow the badge.
   *
   * `meta.pagination.total` is the size of the set the server cut this page from, so the screen
   * can say plainly when it is showing part of the roster rather than implying it is all of it.
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request<{ data: Assayer[]; meta?: { pagination?: { total?: number } } }>(
        `/assayers?limit=${ROSTER_LIMIT}`,
        { withMeta: true },
      );
      const rows = Array.isArray(res?.data) ? res.data : [];
      setAssayers(rows);
      setRosterTotal(res?.meta?.pagination?.total ?? rows.length);
    } catch (e) {
      setNotice({ tone: 'err', text: `Could not load the roster. ${userMessage(e)}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Reload the roster *and* the shared workforce overview.
   *
   * The overview is fetched once by `HrLayout` and feeds the header counts and every tab badge.
   * Reloading only this list left the header asserting "26 active · 0 onboarding" — with a fresh
   * "updated 11:02 am" beside it — straight after someone had added an assayer who was sitting in
   * onboarding. Use this wherever the roster is changed; plain `load()` is for mount and for
   * socket events, which do not need to re-fetch a summary the server is already pushing.
   */
  const refresh = useCallback(() => {
    load();
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.workforce });
    // And the open record itself. The list reloading is not enough: the detail drawer holds its
    // own copy, fetched when it opened, and showed stale values behind every save until reload.
    setDetailVersion((v) => v + 1);
  }, [load, queryClient]);

  // Lifecycle changes can come from anywhere — a bulk action here, an admin
  // elsewhere, a backend job. Keep the roster live rather than stale until reload.
  useEffect(() => {
    const socket = connectSocket();
    // The backend publishes domain events under `event.constructor.name`, which carries an
    // `Event` suffix (see assayer.service.ts) — these listeners silently never fired without it.
    const events = [
      'AssayerActivatedEvent', 'AssayerSuspendedEvent', 'AssayerDeactivatedEvent', 'AssayerOnLeaveEvent',
      'AssayerResignedEvent', 'AssayerTerminatedEvent', 'AssayerArchivedEvent',
      'AssayerDocumentVerificationStartedEvent', 'AssayerBackgroundCheckInitiatedEvent', 'AssayerTrainingStartedEvent',
    ];
    events.forEach((e) => socket?.on(e, load));
    return () => { events.forEach((e) => socket?.off(e, load)); };
  }, [load]);

  const states = useMemo(
    () => [...new Set(assayers.map((a) => a.state).filter(Boolean))].sort(),
    [assayers],
  );
  // Sorted by the label the reader sees. Sorting by the stored value put "BACKGROUND_VERIFICATION"
  // before "DOCUMENT_VERIFICATION" before "INVITED" — an order with no meaning on a screen that
  // never shows those words.
  const statuses = useMemo(
    () => [...new Set(assayers.map((a) => a.lifecycleStatus).filter(Boolean))]
      .sort((a, b) => assayerLifecycleLabel(a).localeCompare(assayerLifecycleLabel(b))),
    [assayers],
  );

  /**
   * When the active segment's true total is bigger than what is listed, by how much.
   * Null when they agree, when there is no exact total, or when another filter is narrowing.
   */
  const segmentShortfall = useMemo(() => {
    const total = exactCounts?.[segment];
    if (total === undefined) return null;
    const shown = assayers.filter(SEGMENTS.find((s) => s.key === segment)!.match).length;
    return total > shown ? { total, shown } : null;
  }, [exactCounts, segment, assayers]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const seg = SEGMENTS.find((s) => s.key === segment) ?? SEGMENTS[0];
    const filtered = assayers.filter((a) => {
      if (!seg.match(a)) return false;
      if (stateFilter !== 'ALL' && a.state !== stateFilter) return false;
      if (statusFilter !== 'ALL' && a.lifecycleStatus !== statusFilter) return false;
      if (!q) return true;
      return `${a.displayName} ${a.assayerCode} ${a.city} ${a.district} ${a.state} ${a.phone} ${a.email ?? ''} ${(a.skills ?? []).join(' ')}`
        .toLowerCase().includes(q);
    });

    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((x, y) => {
      let a: any, b: any;
      if (sort.key === 'completeness') { a = missingFields(x).length; b = missingFields(y).length; }
      else if (sort.key === 'joiningDate') { a = x.joiningDate ?? ''; b = y.joiningDate ?? ''; }
      else { a = (x as any)[sort.key] ?? ''; b = (y as any)[sort.key] ?? ''; }
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    });
  }, [assayers, search, segment, stateFilter, statusFilter, sort]);

  useEffect(() => { setVisibleCount(RENDER_CHUNK); }, [assayers, search, segment, stateFilter, statusFilter, sort]);

  /** True when the server holds more people than this page asked for. */
  const truncated = rosterTotal > assayers.length;
  const allShownSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  /**
   * The bulk bar acts on the ticked rows that are *on screen*, never on ticks the current
   * segment, filter or "show more" cut-off is hiding.
   *
   * This used to intersect the ticked ids against the whole roster instead of against `rows`.
   * Tick ten people under "Onboarding", switch to "Active", press Apply, and all ten were sent
   * — the bar said ten, the screen showed different people, and the lifecycle change landed on
   * rows nobody had looked at. `visibleSelection` is the one rule for this across the app: the
   * count shown equals the count changed, and anything hidden is named rather than silently
   * included or silently dropped.
   */
  const { rows: selected, ids: selectedVisibleIds, hiddenCount } = useMemo(
    () => visibleSelection(selectedIds, rows, (r) => r.id),
    [selectedIds, rows],
  );
  const hiddenNote = hiddenSelectionNote(hiddenCount, 'assayer');

  /** Every criterion currently narrowing the list, in the words shown on the controls. */
  const activeCriteria = useMemo(() => {
    const out: string[] = [];
    const seg = SEGMENTS.find((s) => s.key === segment);
    if (seg && seg.key !== 'all') out.push(`"${seg.label}"`);
    if (statusFilter !== 'ALL') out.push(`stage "${assayerLifecycleLabel(statusFilter)}"`);
    if (stateFilter !== 'ALL') out.push(`state "${stateFilter}"`);
    if (search.trim()) out.push(`search "${search.trim()}"`);
    return out.length ? out : ['the current view'];
  }, [segment, statusFilter, stateFilter, search]);

  /** Every target stage reachable from *any* selected row (walking forward through
   *  the state machine). Unlike a strict intersection this works for mixed-stage
   *  batches — the backend skips rows that can't reach the chosen target. */
  const bulkOptions = useMemo(() => {
    if (selected.length === 0) return [];
    const reachable = new Set<string>();
    for (const a of selected) {
      for (const s of Object.values(AssayerLifecycleStatus)) {
        if (s === a.lifecycleStatus) continue;
        if (assayerLifecyclePath(a.lifecycleStatus, s) !== null) reachable.add(s);
      }
    }
    return Object.values(AssayerLifecycleStatus).filter((s) => reachable.has(s));
  }, [selected]);

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sortBy = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  /**
   * Moving a whole batch of people to another stage, asked about first.
   *
   * The bar said "12 selected" and offered an Apply button, and pressing it changed twelve
   * employment records with no further question — including moves like Terminated and Archived,
   * which the state machine will not run backwards. There is also nothing in the bar that names
   * *who* is in the batch, so a mis-click on the header tick box (which selects every row in the
   * current view, potentially hundreds) was indistinguishable from a deliberate selection of
   * twelve. The dialog now states the count, the destination, what it does to those people, and
   * lists the first few names so the batch can be recognised before it is committed.
   */
  const runBulkTransition = async () => {
    if (!bulkTarget || selected.length === 0) return;
    const names = selected.slice(0, 5).map((a) => `${a.displayName} (${a.assayerCode})`);
    const ok = await confirm({
      title: `Move ${selected.length} ${selected.length === 1 ? 'person' : 'people'} to ${assayerLifecycleLabel(bulkTarget)}?`,
      message: (
        <>
          {STAGE_CONSEQUENCE[bulkTarget] ?? `Everyone selected is moved to ${assayerLifecycleLabel(bulkTarget)}.`}
          {' '}Anyone who cannot legally reach that stage from where they are now is left alone, and
          you will get a list of who moved and who did not.
          <div style={{ marginTop: '8px', fontSize: '12px' }}>
            {names.join(', ')}
            {selected.length > names.length && ` and ${selected.length - names.length} more`}
          </div>
          {hiddenNote && <div style={{ marginTop: '6px', fontSize: '12px' }}>{hiddenNote}</div>}
        </>
      ),
      confirmLabel: `Move ${selected.length} to ${assayerLifecycleLabel(bulkTarget)}`,
      reversible: false,
      reversibleNote: 'The stages only run forwards, so this cannot be put back by choosing the old stage again.',
      tone: HARD_TO_REVERSE_STAGES.includes(bulkTarget) ? 'danger' : 'normal',
    });
    if (!ok) return;
    setBusy(true);
    setBulkReport(null);
    const ids = selectedVisibleIds;
    try {
      const res = await api.request<{ succeeded: { id: string; from: string; to: string }[]; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] }>(
        '/assayers/bulk/lifecycle',
        {
          method: 'POST',
          body: JSON.stringify({ ids, targetStatus: bulkTarget, reason: `Bulk transition to ${assayerLifecycleLabel(bulkTarget)}` }),
        },
      );
      const { succeeded, skipped, failed } = res ?? { succeeded: [], skipped: [], failed: [] };
      setBulkReport({
        target: bulkTarget,
        succeeded: succeeded.map((s) => s.id),
        skipped,
        failed,
        names: Object.fromEntries(selected.map((a) => [a.id, `${a.displayName} (${a.assayerCode})`])),
      });
      const moved = succeeded.length;
      setNotice(
        failed.length || skipped.length
          ? {
              tone: 'err',
              text: `${moved} moved to ${assayerLifecycleLabel(bulkTarget)}, ${skipped.length} skipped, ${failed.length} failed.`,
            }
          : { tone: 'ok', text: `${counted(moved, 'person', 'people')} moved to ${assayerLifecycleLabel(bulkTarget)}.` },
      );
    } catch (e) {
      // Raw server text ("API Endpoint /assayers/bulk/lifecycle returned status 500") tells an
      // HR officer nothing they can act on; `userMessage` is the one place that translation lives.
      setNotice({ tone: 'err', text: `Nobody was moved. ${userMessage(e)}` });
    } finally {
      setBusy(false);
      setBulkTarget('');
      setSelectedIds(new Set());
      refresh();
    }
  };

  const remove = async (a: Assayer) => {
    // Deleting a person's whole HR record. The assayer code is what uniquely identifies
    // them on a roster full of similar names, so that is what has to be typed — it also
    // makes it impossible to delete the wrong row by clicking the wrong line's bin icon.
    const ok = await confirm({
      title: `Delete ${a.displayName}?`,
      message: `The entire record for ${a.displayName} (${a.assayerCode}) is removed from the roster, including their details and documents.`,
      confirmLabel: 'Delete assayer',
      reversible: false,
      tone: 'danger',
      confirmPhrase: a.assayerCode,
    });
    if (!ok) return;
    try {
      await api.request(`/assayers/${a.id}`, { method: 'DELETE' });
      setNotice({ tone: 'ok', text: `${a.displayName} deleted.` });
      setOpenId(null);
      refresh();
    } catch (e) {
      setNotice({ tone: 'err', text: userMessage(e) });
    }
  };

  /** Exports exactly what is on screen — same filter, same sort, same order. */
  const exportCsv = () => {
    const cols = ['assayerCode', 'displayName', 'phone', 'email', 'city', 'district', 'state', 'lifecycleStatus', 'employmentType', 'joiningDate', 'experienceYears'];
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      [...cols, 'missingFields'].join(','),
      ...rows.map((r) => [...cols.map((c) => esc((r as any)[c])), esc(missingFields(r).join('; '))].join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = `workforce-roster-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
    URL.revokeObjectURL(url);
  };

  /**
   * A bulk import reports per-row outcomes in a successful response, not by throwing.
   *
   * This awaited the request, discarded the result and said "Roster imported." — so an upload
   * that imported nothing and returned 73 errors displayed as a green success. The only way to
   * discover the failure was the browser's network tab, which is not a place operators look.
   * The result is now read and shown: what landed, what did not, and why.
   */
  const handleUpload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      const result = await api.request<{
        importedCount: number;
        created?: number;
        updated?: number;
        totalRows?: number;
        sheetName?: string;
        needingPhone?: string[];
        errors?: string[];
      }>('/assayers/upload', { method: 'POST', body: fd });
      const imported = result?.importedCount ?? 0;
      const errors = result?.errors ?? [];
      const created = result?.created ?? 0;
      const updated = result?.updated ?? 0;
      const needingPhone = result?.needingPhone ?? [];

      /**
       * "Imported 25" hid the two things an operator most needs to know: whether those were new
       * people or an overwrite of the existing roster, and whether any of them can actually be
       * reached. A re-imported roster reports 25 either way.
       */
      const breakdown = created && updated
        ? `${created} new, ${updated} updated`
        : created
          ? `${created} new`
          : updated
            ? `${updated} updated`
            : `${imported}`;
      const sheetNote = result?.sheetName ? ` from sheet "${result.sheetName}"` : '';
      const phoneNote = needingPhone.length
        ? ` ${needingPhone.length} ha${needingPhone.length === 1 ? 's' : 've'} no phone number — they can be planned, but not called until one is added.`
        : '';

      if (errors.length === 0) {
        setNotice({
          tone: needingPhone.length ? 'warn' : 'ok',
          text: `Roster imported${sheetNote} — ${breakdown}.${phoneNote}`,
          details: needingPhone.length
            ? [`No phone number: ${needingPhone.join(', ')}`]
            : undefined,
        });
      } else {
        // Nothing imported means the file itself was wrong (wrong template, missing column), and
        // that message is one actionable sentence — show it whole. A partial import is a
        // per-row problem, so lead with the counts and list the first few rows.
        setNotice({
          tone: imported > 0 ? 'warn' : 'err',
          text: imported === 0 && errors.length === 1
            ? errors[0]
            : imported > 0
            // `breakdown` is phrased to follow "Roster imported — …", so dropping it straight
            // into "Imported … of 6" produced "Imported 4 updated of 6". Keep the count and the
            // make-up of it apart.
            ? `Imported ${imported} of ${imported + errors.length} rows${sheetNote} (${breakdown}). ${counted(errors.length, 'row')} could not be imported.${phoneNote}`
            : `Imported ${imported} of ${imported + errors.length}. ${counted(errors.length, 'row')} could not be imported.`,
          details: errors,
        });
      }
      refresh();
    } catch (e) {
      setNotice({ tone: 'err', text: userMessage(e) });
    } finally {
      // Cleared even on failure, so a rejected sheet can be corrected and re-uploaded.
      setUploading(false);
    }
  };

  /**
   * The blank sheet with the column headings the importer expects.
   *
   * This was unguarded: if the request failed the promise rejected into nowhere, so the click
   * produced no file and no message, and the next move was to upload a hand-made sheet that the
   * importer then rejected row by row. A failed template download has to say so.
   */
  const downloadTemplate = async () => {
    try {
      const blob = await api.request<Blob>('/assayers/template/download', { raw: true } as any);
      const url = URL.createObjectURL(blob as any);
      const el = document.createElement('a');
      el.href = url;
      el.download = 'assayer-template.xlsx';
      el.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setNotice({ tone: 'err', text: `Could not download the template. ${userMessage(e)}` });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {confirmDialog}
      {notice && (() => {
        const tones = {
          ok: { bg: 'var(--status-active-bg)', fg: 'var(--success)' },
          warn: { bg: 'var(--status-pending-bg)', fg: 'var(--warning)' },
          err: { bg: 'var(--status-cancelled-bg)', fg: 'var(--danger)' },
        }[notice.tone];
        const details = notice.details ?? [];
        // A handful of rows is worth showing outright; a wall of them needs a toggle, or the
        // message pushes the roster off the screen.
        const shown = noticeExpanded ? details : details.slice(0, 5);
        return (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
            background: tones.bg, color: tones.fg,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
              <span style={{ fontWeight: details.length ? 600 : 400 }}>{notice.text}</span>
              <button onClick={() => { setNotice(null); setNoticeExpanded(false); }}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', flexShrink: 0 }}>
                <X size={14} />
              </button>
            </div>
            {details.length > 0 && (
              <ul style={{ margin: '7px 0 0', paddingLeft: '18px', fontSize: '12px', lineHeight: 1.55, fontWeight: 400 }}>
                {shown.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
            {details.length > 5 && (
              <button
                onClick={() => setNoticeExpanded((v) => !v)}
                style={{ marginTop: '6px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '11.5px', fontWeight: 700, textDecoration: 'underline', padding: 0 }}
              >
                {noticeExpanded ? 'Show fewer' : `Show all ${details.length}`}
              </button>
            )}
          </div>
        );
      })()}

      {/*
        * Segments: the questions HR ask, as one click each.
        *
        * These count the rows that arrived, which is the whole roster until it passes
        * ROSTER_LIMIT. Past that the page says so rather than letting "Everyone 1,000" sit
        * under a tab badge reading 1,400 with nothing to explain the gap.
        */}
      {truncated && (
        <div style={{ fontSize: '11.5px', color: 'var(--warning)', lineHeight: 1.5 }}>
          Showing the {assayers.length} most recently added of {rosterTotal} people. The counts on
          these filters describe those {assayers.length}; search to find anyone not listed.
        </div>
      )}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        {SEGMENTS.map((s) => {
          const n = exactCounts?.[s.key] ?? assayers.filter(s.match).length;
          const on = segment === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSegment(s.key)}
              style={{
                padding: '5px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${on ? 'transparent' : 'var(--border-color)'}`,
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? 'var(--on-accent)' : 'var(--text-secondary)',
              }}
            >
              {s.label} <span style={{ opacity: 0.75 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/*
        A chip counting the whole roster above a list holding part of it.
        
        The banner higher up says the chips describe the loaded page, and for most of them it is
        true. A segment given an exact total is the exception, and leaving the two numbers to sit
        side by side unexplained is worse than either alone — the reader cannot tell whether six
        people are missing or the count is wrong. Said plainly, and only when they disagree.
      */}
      {segmentShortfall !== null && (
        <div style={{ fontSize: '12px', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AlertTriangle size={13} />
          Showing {segmentShortfall.shown} of {segmentShortfall.total}. The other{' '}
          {segmentShortfall.total - segmentShortfall.shown} are outside the {ROSTER_LIMIT} rows
          loaded here — search by name or code to reach them.
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: '220px' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, phone, city, skill…"
            style={{
              width: '100%', padding: '8px 10px 8px 30px', fontSize: '13px', borderRadius: '8px',
              border: '1px solid var(--border-color)', background: 'var(--bg-page)', color: 'inherit', outline: 'none',
            }}
          />
        </div>
        <button onClick={() => setShowFilters((v) => !v)} className="btn btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px' }}>
          <SlidersHorizontal size={13} /> Filters
        </button>
        {/*
          * TWO EXPORTS, AND THEY REALLY ARE TWO DIFFERENT THINGS.
          *
          * They read "Export 43" and "Excel", and the only statement of the difference was a
          * tooltip on one of them. Nothing on either face said which one honoured the filters
          * you had just set, and "Excel" versus a button whose CSV also opens in Excel is not a
          * distinction anybody can act on. What they actually produce:
          *
          *   This view (CSV)   — built here in the browser from `rows`: the exact rows listed
          *                       below, in the current filter/segment/search and sort order.
          *                       Eleven identity/contact/location columns plus the missing-field
          *                       list. Instant, because nothing is fetched.
          *   Full roster (XLSX)— GET /reports/assayer-roster. Ignores everything on this screen
          *                       and walks the whole workforce, returning two sheets: Roster
          *                       (adds region, exit date, assignment counts and average rating)
          *                       and the payroll rate card (base fee, daily/hourly rates,
          *                       allowances, effective dates). PII columns are scoped to the
          *                       caller's roles server-side.
          *
          * Neither is a subset of the other — the CSV has the missing-field audit the workbook
          * lacks, the workbook has pay rates and performance the CSV lacks — so folding them
          * into one control with a format toggle would have to drop columns to be honest. Both
          * are kept, and the difference is now on the buttons and in the hint line below the
          * toolbar rather than hidden in a title attribute.
          */}
        <button onClick={exportCsv} className="btn btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px' }}
          title={`Downloads the ${rows.length} ${rows.length === 1 ? 'person' : 'people'} listed below as a CSV, in this order, with contact and location details and what is missing from each file.`}>
          <Download size={13} /> Export this view ({rows.length})
        </button>
        {/* The payroll-rate-card sheet is assembled over the whole roster; until it lands
            nothing on screen moves, which is why this used to be clicked repeatedly. */}
        <button onClick={handleExportExcel} disabled={exporting} className="btn btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px', color: 'var(--success)' }}
          title="Downloads an Excel workbook covering everyone on the roster, whatever the filters above say: one sheet of roster details with assignment counts and ratings, one sheet of payroll rates and allowances. Built on the server, so it takes a few seconds.">
          <FileSpreadsheet size={13} /> {exporting ? 'Preparing…' : 'Full roster + pay rates (Excel)'}
        </button>
        {canManage && (
          <>
            <UploadExcelControls onUpload={handleUpload} onDownloadTemplate={downloadTemplate} accept=".xlsx,.xls" busy={uploading} busyLabel="Importing roster…" />
            <button onClick={() => setCreating(true)} className="btn btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '8px 14px' }}>
              <Plus size={14} /> Add assayer
            </button>
          </>
        )}
      </div>

      {/*
        * The difference between the two export buttons, said on the page.
        *
        * A tooltip is not an answer for someone deciding which button to press: it needs a
        * mouse, it needs a guess about which control to hover, and it vanishes. One quiet line
        * under the toolbar states both, so the choice can be made by reading.
        */}
      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '-2px' }}>
        <strong style={{ fontWeight: 600 }}>Export this view</strong> saves the {rows.length}{' '}
        {rows.length === 1 ? 'person' : 'people'} currently listed — contact and location details,
        plus what each file is missing — as a CSV.{' '}
        <strong style={{ fontWeight: 600 }}>Full roster + pay rates</strong> ignores the filters and
        covers everyone, adding assignment history and the payroll rate card, as an Excel workbook.
      </div>

      {/* Directly under the import controls, because that is what puts entries in it. */}
      <ImportIssuesPanel canManage={canManage} onResolved={load} />

      {showFilters && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
          {/*
            "State" and "Status" sat side by side as two five-letter words, one meaning the part of
            India someone lives in and the other meaning where they have got to with HR — and the
            column they each narrow is headed "Location" and "Stage". Someone hunting for everyone
            in Kerala read "Status" first as often as not. Both now say which question they answer,
            and the "All" option names what it is all of.
          */}
          <RosterFilterSelect label="State they live in" value={stateFilter} onChange={setStateFilter} options={states} allLabel="All states" />
          <RosterFilterSelect label="Stage with HR" value={statusFilter} onChange={setStatusFilter} options={statuses} formatOption={assayerLifecycleLabel} allLabel="All stages" />
          {(stateFilter !== 'ALL' || statusFilter !== 'ALL' || search) && (
            <button
              onClick={() => { setStateFilter('ALL'); setStatusFilter('ALL'); setSearch(''); }}
              className="btn btn-secondary" style={{ fontSize: '11px', padding: '6px 10px', alignSelf: 'flex-end' }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Bulk bar — only present when a selection exists, so it never adds noise. */}
      {canManage && selected.length > 0 && (
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px',
          background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.3)',
        }}>
          <strong style={{ fontSize: '13px' }}>{selected.length} selected</strong>
          {hiddenNote && (
            <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{hiddenNote}</span>
          )}
          <ArrowRightLeft size={13} style={{ color: 'var(--text-muted)' }} />
          {bulkOptions.length > 0 ? (
            <Select
              value={bulkTarget}
              onChange={setBulkTarget}
              options={bulkOptions.map((t) => ({ value: t, label: assayerLifecycleLabel(t) }))}
              placeholder="Move all to…"
              compact
            />
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              No stage is reachable from the selected rows.
            </span>
          )}
          <button onClick={runBulkTransition} disabled={!bulkTarget || busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px', marginLeft: 'auto' }}>
            Clear selection
          </button>
          {/* What the chosen stage does to these people, before Apply is pressed. The dropdown
              named a stage and the button said "Apply"; between the two, nothing said that
              "Archived" takes everyone selected off the working roster. */}
          {bulkTarget && STAGE_CONSEQUENCE[bulkTarget] && (
            <div style={{ flexBasis: '100%', fontSize: '11.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {STAGE_CONSEQUENCE[bulkTarget]} Anyone who cannot reach that stage from where they are
              now is left alone, and you get a list of who moved and who did not.
            </div>
          )}
        </div>
      )}

      {/* Bulk result report — what actually moved, and which rows could not reach
          the target, with per-row reasons. */}
      {bulkReport && (
        <div style={{
          marginTop: '10px', padding: '12px 14px', borderRadius: '8px', fontSize: '12px',
          background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)',
        }}>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: 600, marginBottom: '8px' }}>
            <span style={{ color: 'var(--status-active-text)' }}>{bulkReport.succeeded.length} moved</span>
            <span style={{ color: 'var(--text-muted)' }}>{bulkReport.skipped.length} skipped</span>
            {bulkReport.failed.length > 0 && <span style={{ color: 'var(--status-danger-text)' }}>{bulkReport.failed.length} failed</span>}
            <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
          </div>
          {bulkReport.skipped.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Could not reach {assayerLifecycleLabel(bulkReport.target)}:</div>
              {bulkReport.skipped.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ color: 'inherit' }}>{bulkReport.names[s.id] ?? 'This assayer'} — {assayerLifecycleLabel(s.current)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {s.reason}</span>
                </div>
              ))}
            </div>
          )}
          {bulkReport.failed.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Failed:</div>
              {bulkReport.failed.map((f) => (
                <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ color: 'inherit' }}>{bulkReport.names[f.id] ?? 'This assayer'}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {f.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Roster */}
      <div style={{ border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden', background: 'var(--bg-card)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--bg-surface-2)' }}>
              <tr>
                {canManage && (
                  <th style={{ ...head, width: '36px' }}>
                    <input
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={() => setSelectedIds(allShownSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                      style={{ cursor: 'pointer' }}
                    />
                  </th>
                )}
                <Th label="Assayer" k="displayName" sort={sort} onSort={sortBy} />
                <Th label="Code" k="assayerCode" sort={sort} onSort={sortBy} />
                <Th label="Stage" k="lifecycleStatus" sort={sort} onSort={sortBy} />
                <Th label="Location" k="state" sort={sort} onSort={sortBy} />
                <Th label="Record" k="completeness" sort={sort} onSort={sortBy} />
                <Th label="Joined" k="joiningDate" sort={sort} onSort={sortBy} />
                {/* "Exp" could as easily have been an expiry date. It is years of experience. */}
                <Th label="Experience" k="experienceYears" sort={sort} onSort={sortBy} />
                <th style={{ ...head, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} style={{ ...cell, textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading roster…</td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ ...cell, textAlign: 'center', padding: '48px' }}>
                    <Users size={26} style={{ opacity: 0.35 }} />
                    <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '10px' }}>Nobody matches this view</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      {/* "Try a different segment or clear the filters" makes the reader hunt for
                          which of four controls is responsible — and the segment pill and the
                          Status dropdown can contradict each other outright (Active + Resigned
                          can never match anybody) while the Filters panel is collapsed and shows
                          nothing. Name the criteria actually in force. */}
                      {assayers.length === 0
                        ? 'The roster is empty — import a workforce file or add someone.'
                        : `No one matches ${activeCriteria.join(' + ')}.`}
                    </div>
                    {assayers.length > 0 && (
                      <button
                        onClick={() => { setSegment('all'); setStateFilter('ALL'); setStatusFilter('ALL'); setSearch(''); }}
                        className="btn btn-secondary"
                        style={{ marginTop: '10px', fontSize: '11.5px', padding: '5px 12px' }}
                      >
                        Show everyone
                      </button>
                    )}
                  </td>
                </tr>
              ) : rows.slice(0, visibleCount).map((a) => {
                const missing = missingFields(a);
                const blockers = payoutBlockers(a);
                const tone = STATUS_COLORS[a.lifecycleStatus] ?? 'var(--text-muted)';
                const months = tenureMonths(a);
                return (
                  <tr
                    key={a.id}
                    onClick={() => setOpenId(a.id)}
                    style={{
                      borderTop: '1px solid var(--border-hair)', cursor: 'pointer',
                      background: selectedIds.has(a.id) ? 'rgba(216,174,71,0.12)' : undefined,
                    }}
                  >
                    {canManage && (
                      <td style={cell} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggle(a.id)} style={{ cursor: 'pointer' }} />
                      </td>
                    )}
                    <td style={cell}>
                      <div style={{ fontWeight: 600 }}>{a.displayName}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.phone}</div>
                    </td>
                    <td style={{ ...cell, fontFamily: 'monospace', fontSize: '11px' }}>{a.assayerCode}</td>
                    <td style={cell}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', fontWeight: 600, color: tone }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: tone }} />
                        {assayerLifecycleLabel(a.lifecycleStatus)}
                      </span>
                    </td>
                    <td style={cell}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <MapPin size={11} style={{ color: 'var(--text-muted)' }} />
                        {[a.city, a.state].filter(Boolean).join(', ') || '—'}
                      </span>
                    </td>
                    <td style={cell}>
                      {missing.length === 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--success)', fontSize: '11.5px' }}>
                          <CheckCircle2 size={12} /> Complete
                        </span>
                      ) : (
                        <span
                          title={`Missing: ${missing.join(', ')}`}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', fontWeight: 600,
                            color: blockers.length ? 'var(--danger)' : 'var(--warning)',
                          }}
                        >
                          <AlertTriangle size={12} />
                          {/* "3 missing" reads as tidying-up. "Cannot be paid" is what it actually
                              means, and it is the difference between a gap someone gets to next
                              month and one that stops a payout run. */}
                          {blockers.length
                            ? `Cannot be paid · ${missing.length} missing`
                            : `${missing.length} missing`}
                        </span>
                      )}
                    </td>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                      {fmtDate(a.joiningDate)}
                      {months !== null && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}> · {months}m</span>}
                    </td>
                    <td style={cell}>{a.experienceYears ?? 0}y</td>
                    <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <IconBtn title="Open full profile" onClick={() => navigate(`/assayers/${a.id}`)}><ExternalLink size={13} /></IconBtn>
                      {canManage && <IconBtn title="Edit" onClick={() => setEditing(a)}><Edit2 size={13} /></IconBtn>}
                      {canManage && <IconBtn title="Delete" tone="var(--danger)" onClick={() => remove(a)}><Trash2 size={13} /></IconBtn>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && rows.length > 0 && (
          <div style={{ padding: '8px 12px', fontSize: '11.5px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <span>
              Showing {Math.min(visibleCount, rows.length)} of {rows.length}
              {rows.filter((r) => missingFields(r).length > 0).length > 0 &&
                ` · ${rows.filter((r) => missingFields(r).length > 0).length} with an incomplete record`}
              {/* Stated separately from "incomplete", because a roster where everyone is Active
                  and nobody has bank details looks entirely healthy until this sentence. */}
              {rows.filter((r) => payoutBlockers(r).length > 0).length > 0 &&
                ` · ${rows.filter((r) => payoutBlockers(r).length > 0).length} cannot be paid yet`}
            </span>
            {rows.length > visibleCount && (
              <button onClick={() => setVisibleCount((c) => c + RENDER_CHUNK)} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '11.5px' }}>
                Show more ({rows.length - visibleCount} more)
              </button>
            )}
          </div>
        )}
      </div>

      {openId && (
        <AssayerDetailDrawer
          assayerId={openId}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onEdit={(a) => setEditing(a)}
          onChanged={refresh}
          reloadKey={detailVersion}
        />
      )}
      {creating && (
        <CreateAssayerModal
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
        />
      )}
      {editing && (
        <EditAssayerModal
          assayer={editing}
          onClose={() => setEditing(null)}
          onUpdated={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
};

const Th: React.FC<{ label: string; k: SortKey; sort: { key: SortKey; dir: string }; onSort: (k: SortKey) => void }> = ({
  label, k, sort, onSort,
}) => (
  <th style={{ ...head, cursor: 'pointer' }} onClick={() => onSort(k)}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      {label}
      {sort.key === k && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </span>
  </th>
);

const IconBtn: React.FC<{ title: string; onClick: () => void; tone?: string; children: React.ReactNode }> = ({
  title, onClick, tone, children,
}) => (
  <button
    title={title}
    onClick={onClick}
    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 5px', color: tone ?? 'var(--text-muted)' }}
  >
    {children}
  </button>
);

const RosterFilterSelect: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  /** Turns a stored option value into the words shown. Defaults to the value itself. */
  formatOption?: (value: string) => string;
  /** Wording for "no filter" — say what it is all of, not just "All". */
  allLabel?: string;
}> = ({
  label, value, onChange, options, formatOption = (v) => v, allLabel = 'All',
}) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
    <span style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</span>
    <Select
      value={value}
      onChange={onChange}
      options={[{ value: 'ALL', label: allLabel }, ...options.map((o) => ({ value: o, label: formatOption(o) }))]}
      compact
      style={{ minWidth: '150px' }}
    />
  </label>
);

export default AssayerRoster;
