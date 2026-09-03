import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  useNavigate } from 'react-router-dom'; import { useQueryClient } from '@tanstack/react-query'; import { Plus, Search, Edit2, Trash2, AlertTriangle, Download, ArrowRightLeft, MapPin, CheckCircle2, Users, SlidersHorizontal, Upload, FileSpreadsheet, PlayCircle } from 'lucide-react'; import { AssayerLifecycleStatus, assayerLifecyclePath, assayerLifecycleLabel, isOnboardingStage,
} from '@fapoms/shared';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { connectSocket } from '../../services/socket';
import { Select, UploadExcelControls, useConfirm, AlertBanner, DataTable } from '../../components/ui';
import { listPhase } from '../../components/ui/list-phase';
import { ImportIssuesPanel } from './ImportIssuesPanel';
import { visibleSelection, hiddenSelectionNote } from '../../utils/selection';
import { useSearchParams } from 'react-router-dom';
import { useCurrentRoles, canManageAssayers, canCreateAssayers } from '../../hooks/useCurrentRoles';
import { useExcelExport } from '../../hooks/useExcelExport';
import { RegistrationWizard } from './registration/RegistrationWizard';
import {
  STATUS_COLORS, onboardingNextStep, stillWorkable, isRecordedDeceased,
} from './assayer-shared';
import {
  ROSTER_SEGMENTS, EMPTY_FILTERS, applyRosterFilters, activeFilterCount, describeFilters,
  missingFields, payoutBlockers, tenureMonths, parseFilters, writeFilters, segmentFor,
  type RosterFilterState, type RosterPerson,
} from './roster-filters';
import { RosterFilterPanel, AppliedFilterBar } from './RosterFilterPanel';
import { RosterExportDialog } from './RosterExportDialog';
import { ToolbarMenu, MenuAction } from './ToolbarMenu';
import { STAGE_CONSEQUENCE, HARD_TO_REVERSE_STAGES } from './AssayerRecord';
import { fmtDate } from '../../utils/dates';
import { queryKeys } from '../../hooks/queryKeys';
import { counted } from '../../utils/plural';
import { useImportJob, ImportSummary } from '../../components/import/useImportJob';
import { ImportProgressPanel } from '../../components/import/ImportProgressPanel';

/** What `/assayers/roster/import` returns (also for its dryRun rehearsal). */
interface RosterImportSummary {
  rowsRead: number;
  created: number;
  updated: number;
  skipped: number;
  references: number;
  onboardingDocuments: number;
  backgroundChecks: number;
  empanelments: number;
  issues: number;
  notes?: string[];
  dryRun: boolean;
  sheetName?: string | null;
}

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
 * WHAT NARROWS THIS LIST NO LONGER LIVES HERE.
 *
 * The segments, the payout-blocking rule, the missing-field list and the tenure sum moved to
 * `roster-filters.ts`, beside the nineteen other axes this roster can now be cut by. They moved
 * for one reason: a segment chip and a filter option that ask the same question ("cannot be
 * paid") must be the same function, or the chip and the panel will eventually disagree in front
 * of a clerk. Everything about narrowing is in one file; what stays here is the screen.
 */

type SortKey = 'displayName' | 'assayerCode' | 'lifecycleStatus' | 'state' | 'experienceYears' | 'completeness' | 'joiningDate';


export const AssayerRoster: React.FC<{
  /**
   * True totals for segments whose count must not be the loaded window's.
   * Keyed by segment key; a segment with no entry counts what arrived, as before.
   */
  exactCounts?: Partial<Record<string, number | undefined>>;
}> = ({ exactCounts }) => {

  const navigate = useNavigate();
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);
  // Creating is a different grant from editing, and this screen offers both. A role holding
  // ASSAYER:EDIT but not ASSAYER:CREATE gets the bulk actions and not the Add button.
  const canCreate = canCreateAssayers(roles);
  const { confirm, confirmDialog } = useConfirm();

  const [assayers, setAssayers] = useState<RosterPerson[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * The one place this screen reports an outcome that needs a decision.
   *
   * It used to be a hand-rolled banner with its own three-tone palette, sitting alongside
   * `toast()` in five sibling files and `setErr()` in four more — four ways of saying "that
   * didn't work" across one section, so a clerk had to learn which corner of which screen each
   * kind of failure appears in. It is now `AlertBanner`, the component thirteen non-HR pages
   * already use and no HR page did. Toasts keep the transient successes; anything the reader
   * has to act on stays on the page until they dismiss it.
   *
   * The third tone went with it: `warn` was declared for the half-imported case and never once
   * set — the partial-outcome path below reports `err` and lists what failed, which is the
   * honest reading anyway ("some rows did not land" is a failure you must act on, not a shade
   * of success).
   *
   * `details` carries the per-row reasons. They belong on screen, not in the network tab.
   */
  const [notice, setNotice] = useState<
    { tone: 'ok' | 'err'; text: string; details?: string[] } | null
  >(null);
  const [noticeExpanded, setNoticeExpanded] = useState(false);

  const [showFilters, setShowFilters] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'displayName', dir: 'asc' });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Every criterion narrowing this list, held in the query string.
   *
   * Worklists elsewhere already linked straight to a segment (`/hr/roster?segment=someone-else`),
   * so a row saying "21 appraisers have work attended by somebody else" lands on those 21. The
   * rest of the filtering now lives in the URL for the same reason and one more: "the 47 people
   * in Kerala who cannot be paid" becomes a link a clerk can bookmark or send to a colleague,
   * instead of a thing the next person re-derives by hand. The back button undoes a filter,
   * which is the cheapest "reversible" there is.
   *
   * Parsed on every render rather than mirrored into state, because two copies of the applied
   * filters is exactly how a screen ends up showing one thing and filtering by another.
   */
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const setFilters = useCallback(
    (next: RosterFilterState) => setSearchParams(writeFilters(searchParams, next), { replace: true }),
    [searchParams, setSearchParams],
  );
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);
  /**
   * Opening somebody is navigation, not a panel.
   *
   * `?assayer=<id>` is still honoured because it is in bookmarks, in notification payloads, and
   * in links from global search and the planning screen's excluded-candidates list. It now
   * forwards to the record's own URL rather than opening a drawer over the list.
   */
  const openRecord = useCallback(
    (id: string) => navigate(`/hr/roster/${id}`),
    [navigate],
  );

  useEffect(() => {
    const wanted = searchParams.get('assayer');
    if (wanted) navigate(`/hr/roster/${wanted}`, { replace: true });
  }, [searchParams, navigate]);
  const [creating, setCreating] = useState(false);
  /**
   * `?register=<id>` reopens the registration flow on somebody already on the roster.
   *
   * Held in the URL rather than in state so the link survives being bookmarked, pasted to a
   * colleague, or reached after the tab was closed mid-registration. Closing the flow clears both
   * halves, and `?view=` with it — that is the flow's own step, and leaving it behind would make
   * the next Add button land on whichever page the last registration stopped on.
   */
  const resumeRegistrationId = searchParams.get('register');
  const closeRegistration = () => {
    setCreating(false);
    if (resumeRegistrationId || searchParams.get('view')) {
      const next = new URLSearchParams(searchParams);
      next.delete('register');
      next.delete('view');
      setSearchParams(next, { replace: true });
    }
  };
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
   * The real roster import's lifetime — the same hook the branch importers use, so the three
   * upload screens cannot drift into three different ideas of what "finished" means.
   */
  const rosterImport = useImportJob<RosterImportSummary>();
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
      const res = await api.request<{ data: RosterPerson[]; meta?: { pagination?: { total?: number } } }>(
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
    // The record is its own page now and re-reads itself on entry, so there is nothing open
    // behind this list holding a stale copy.
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
      /**
       * Ordinary edits, which is what actually moves the "Incomplete record" column.
       *
       * The list above is lifecycle-only, so a detail corrected on the phone — a phone number, an
       * emergency contact, a confirmed map pin — changed nothing on an open roster until someone
       * reloaded. That is the same symptom as a stale cache and was routinely mistaken for one.
       * Emitted verbatim (not `…Event`) because the gateway forwards this one under its own
       * domain-event name; see events.gateway.ts.
       */
      'assayer:updated', 'assayer:created', 'assayer:deleted',
    ];
    events.forEach((e) => socket?.on(e, load));
    return () => { events.forEach((e) => socket?.off(e, load)); };
  }, [load]);

  /**
   * When the active segment's true total is bigger than what is listed, by how much.
   * Null when they agree, when there is no exact total, or when another filter is narrowing.
   */
  const selectedSegment = useMemo(() => segmentFor(filters.segment), [filters.segment]);

  const segmentShortfall = useMemo(() => {
    const total = exactCounts?.[filters.segment];
    if (total === undefined) return null;
    const shown = assayers.filter(selectedSegment.match).length;
    return total > shown ? { total, shown } : null;
  }, [exactCounts, filters.segment, selectedSegment, assayers]);

  /** Everyone the filters leave, before the sort — what the export's "on screen" scope means. */
  const filtered = useMemo(() => applyRosterFilters(assayers, filters), [assayers, filters]);

  const rows = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((x, y) => {
      let a: any, b: any;
      if (sort.key === 'completeness') { a = missingFields(x).length; b = missingFields(y).length; }
      else if (sort.key === 'joiningDate') { a = x.joiningDate ?? ''; b = y.joiningDate ?? ''; }
      else { a = (x as any)[sort.key] ?? ''; b = (y as any)[sort.key] ?? ''; }
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    });
  }, [filtered, sort]);

  useEffect(() => { setVisibleCount(RENDER_CHUNK); }, [assayers, filters, sort]);

  /** Which of the four list states this table is in — see components/ui/list-phase.ts. */
  const phase = listPhase({ loading, rowCount: rows.length });

  /** True when the server holds more people than this page asked for. */
  const truncated = rosterTotal > assayers.length;
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

  /**
   * Every criterion currently narrowing the list, in the words shown on the controls.
   *
   * One list, used by the empty state ("no one matches X + Y") and by the export dialog, so the
   * file a clerk downloads is described by the same sentence that explains an empty table.
   */
  const activeCriteria = useMemo(() => {
    const applied = describeFilters(filters).map((f) => `"${f.label}"`);
    return applied.length ? applied : ['the current view'];
  }, [filters]);

  /** How many separate criteria are in force — the number beside the Filters button. */
  const appliedCount = useMemo(() => activeFilterCount(filters), [filters]);

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

  const remove = async (a: RosterPerson) => {
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
      refresh();
    } catch (e) {
      setNotice({ tone: 'err', text: userMessage(e) });
    }
  };

  /*
   * THE CSV THAT USED TO BE BUILT HERE IS GONE, AND SO IS ITS ESCAPING.
   *
   * It wrote eleven fixed columns with a hand-rolled `'"' + v.replace(...) + '"'`, which is the
   * duplicate `utils/csv.ts` exists to stop — that one escapes quotes, prefixes a leading `=`
   * so a spreadsheet cannot read a name as a formula, and writes the BOM without which Excel
   * renders Indian names as mojibake. Choosing the columns lives in `RosterExportDialog`, and
   * the file itself is written by `downloadCsv`, like every other export in the app.
   */

  /**
   * A bulk import reports per-row outcomes in a successful response, not by throwing.
   *
   * This awaited the request, discarded the result and said "Roster imported." — so an upload
   * that imported nothing and returned 73 errors displayed as a green success. The only way to
   * discover the failure was the browser's network tab, which is not a place operators look.
   * The result is now read and shown: what landed, what did not, and why.
   */
  /**
   * Import the FULL appraiser roster workbook via `/assayers/roster/import`.
   *
   * This used to POST `/assayers/upload`, the simple ~40-field template importer. Fed a real
   * client roster — several sheets, "Appraiser code"/"Appraiser Name" headers, 70-odd columns of
   * HR/KYC/banking/compliance — that importer scored the branch-audit sheet higher than the
   * roster sheet, read the wrong sheet entirely (an assayer code repeats per branch there), and
   * called distinct people "duplicates", so most of the file never landed. The full importer
   * reads the Assayers sheet, recognises the Appraiser headers, and spreads every column across
   * the tables that hold them (references, background checks, documents, empanelments).
   *
   * It always rehearses first (dryRun) and shows exactly what would happen, because nobody should
   * discover what importing a thousand people does by running it.
   */
  /**
   * Rehearse the workbook. Writes nothing; the operator is waiting on its answer, so it stays a
   * plain request.
   */
  const rehearseRoster = (file: File): Promise<RosterImportSummary> => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('dryRun', 'true');
    return api.request<RosterImportSummary>('/assayers/roster/import', { method: 'POST', body: fd });
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      // Rehearse — writes nothing, tells us what the file holds.
      const dry = await rehearseRoster(file);
      const extras = [
        dry.references ? `${dry.references.toLocaleString('en-IN')} references` : '',
        dry.backgroundChecks ? `${dry.backgroundChecks.toLocaleString('en-IN')} background checks` : '',
        dry.empanelments ? `${dry.empanelments.toLocaleString('en-IN')} bank empanelments` : '',
        dry.onboardingDocuments ? `${dry.onboardingDocuments.toLocaleString('en-IN')} document records` : '',
      ].filter(Boolean);

      const proceed = await confirm({
        title: `Import ${dry.rowsRead.toLocaleString('en-IN')} appraisers from this workbook?`,
        message: (
          <>
            This will <strong>add {dry.created.toLocaleString('en-IN')}</strong> and{' '}
            <strong>update {dry.updated.toLocaleString('en-IN')}</strong> appraisers
            {extras.length > 0 && <>, and bring in {extras.join(', ')}</>}.
            {dry.skipped > 0 && (
              <div style={{ marginTop: '8px', fontSize: '12px' }}>
                {counted(dry.skipped, 'row')} will be skipped (no appraiser code).
              </div>
            )}
            {dry.issues > 0 && (
              <div style={{ marginTop: '8px', fontSize: '12px' }}>
                {counted(dry.issues, 'cell')} couldn't be read and will be listed for review — those
                rows still import, just with that one detail left blank.
              </div>
            )}
            {(dry.notes ?? []).slice(0, 4).map((n: string, i: number) => (
              <div key={i} style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>{n}</div>
            ))}
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Re-importing the same appraiser code updates that person — it never creates a duplicate.
            </div>
          </>
        ),
        confirmLabel: `Import ${dry.rowsRead.toLocaleString('en-IN')} appraisers`,
      });
      if (!proceed) { setUploading(false); return; }

      /**
       * The real import runs on the server's queue.
       *
       * It used to run inside the upload request, with a **fifteen-minute** client timeout to
       * accommodate a full roster — a page the operator was told to stay on for a quarter of an
       * hour, with nothing to look at and no way to tell a slow import from a dead one. The panel
       * below follows the job the server returns, and the page can be left.
       */
      await rosterImport.start('/assayers/roster/import', file);
    } catch (e) {
      setNotice({ tone: 'err', text: userMessage(e) });
    } finally {
      // Cleared even on failure, so a rejected workbook can be corrected and re-uploaded.
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
      {/* What the queued roster import is doing, and what it did. */}
      <ImportProgressPanel
        state={rosterImport.state}
        onDismiss={rosterImport.reset}
        summarise={summariseRosterImport}
      />

      {notice && (() => {
        const details = notice.details ?? [];
        // A handful of rows is worth showing outright; a wall of them needs a toggle, or the
        // message pushes the roster off the screen.
        const shown = noticeExpanded ? details : details.slice(0, 5);
        return (
          <AlertBanner
            type={notice.tone === 'ok' ? 'success' : 'error'}
            onClose={() => { setNotice(null); setNoticeExpanded(false); }}
            style={{ alignItems: 'flex-start', fontSize: '13px' }}
          >
            <span style={{ fontWeight: details.length ? 600 : 400 }}>{notice.text}</span>
            {details.length > 0 && (
              <ul style={{ margin: '7px 0 0', paddingLeft: '18px', fontSize: '12.5px', lineHeight: 1.55, fontWeight: 400 }}>
                {shown.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
            {details.length > 5 && (
              <button
                onClick={() => setNoticeExpanded((v) => !v)}
                style={{ marginTop: '6px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '12px', fontWeight: 700, textDecoration: 'underline', padding: 0 }}
              >
                {noticeExpanded ? 'Show fewer' : `Show all ${details.length}`}
              </button>
            )}
          </AlertBanner>
        );
      })()}

      {/*
        * The chips below — and every option count in the Filters panel — describe the rows that
        * arrived, which is the whole roster until it passes ROSTER_LIMIT. Past that the page says
        * so rather than letting "Everyone 1,000" sit under a tab badge reading 1,400 with nothing
        * to explain the gap.
        */}
      {truncated && (
        <div style={{ fontSize: '12px', color: 'var(--warning)', lineHeight: 1.5 }}>
          Showing the {assayers.length} most recently added of {rosterTotal} people. The counts on
          these filters describe those {assayers.length}; search to find anyone not listed.
        </div>
      )}
      {/*
        TWO ROWS, BECAUSE THESE CHIPS WERE DOING TWO JOBS AT ONCE.

        Twelve pills in one undifferentiated line: four of them answer "who am I looking at" and
        the other eight are worklists — people somebody has to ring up today. Read as one row
        they look like twelve ways to slice a list, and the queues, which are the reason the row
        exists, are the hardest thing in it to find. Same chips, same keys, same deep links; a
        heading each and a rule about what may be hidden.

        A queue with nobody in it is not shown. "Certificate lapsed 0" is a question already
        answered, and eight of those are the clutter this row was accused of. The selected one is
        always shown, so `?segment=lapsed` still lands somewhere that explains itself.
      */}
      {([
        { key: 'who', label: 'Who to show', chips: ROSTER_SEGMENTS.filter((s) => !s.queue) },
        { key: 'chase', label: 'Needs chasing', chips: ROSTER_SEGMENTS.filter((s) => s.queue) },
      ] as const).map((row) => {
        const chips = row.chips
          .map((s) => ({ s, n: exactCounts?.[s.key] ?? assayers.filter(s.match).length }))
          .filter(({ s, n }) => !s.queue || n > 0 || filters.segment === s.key);
        if (chips.length === 0) return null;
        return (
          <div key={row.key} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }} role="tablist">
            <span style={{
              fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
              color: 'var(--text-muted)', marginRight: '2px',
            }}>
              {row.label}
            </span>
            {chips.map(({ s, n }) => {
              const on = filters.segment === s.key;
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFilters({ ...filters, segment: s.key })}
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
        );
      })}

      {/*
        What the selected queue is, and what to do with the people in it.

        A chip reading "Documents to check 34" says a number and a noun. It does not say that
        these 34 are waiting on somebody in this office, what "check" means here (enter the
        number, confirm it against the paper original), or where that is done. One sentence,
        under the chips, in the words the record page's own buttons use.
      */}
      {selectedSegment?.hint && (
        <div style={{
          fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.55,
          padding: '9px 12px', borderRadius: '8px',
          background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)',
        }}>
          {selectedSegment.hint}
        </div>
      )}

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

      {/*
        THE TOOLBAR: ONE PRIMARY ACTION, AND TWO DOORS.

        This row held six controls — Filters, "Export this view", "Full roster + pay rates
        (Excel)", "Upload Excel", "Download Template" and Add — none of them visibly more
        important than the others, and a paragraph underneath explaining the difference between
        two of them. A clerk arriving to add somebody had to read all six.

        Now: search, one Filters button carrying the count of what is applied, an Export menu
        (which is where the choice between the browser CSV and the server workbook is made, with
        the difference explained where the choice happens), an Import menu, and the one thing
        that is genuinely primary — Add assayer.
      */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: '220px' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            placeholder="Search name, code, phone, city, skill…"
            aria-label="Search the roster"
            style={{
              width: '100%', padding: '8px 10px 8px 30px', fontSize: '13px', borderRadius: '8px',
              border: '1px solid var(--border-color)', background: 'var(--bg-page)', color: 'inherit', outline: 'none',
            }}
          />
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="btn btn-secondary"
          aria-expanded={showFilters}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px' }}
        >
          <SlidersHorizontal size={13} /> Filters
          {appliedCount > 0 && (
            <span style={{
              fontSize: '12px', fontWeight: 700, padding: '0 6px', borderRadius: '9px',
              background: 'var(--accent)', color: 'var(--on-accent)',
            }}>
              {appliedCount}
            </span>
          )}
        </button>
        <ToolbarMenu label="Export" icon={<Download size={13} />} panelWidth={280}>
          {(close) => (
            <>
              <MenuAction
                label={`Choose columns — ${counted(rows.length, 'person', 'people')} in this view`}
                hint="Pick exactly the columns you need, for these rows or for everyone. Opens in Excel."
                icon={<Download size={13} />}
                onClick={() => { close(); setShowExport(true); }}
              />
              {/* The payroll-rate-card sheet is assembled over the whole roster; until it lands
                  nothing on screen moves, which is why this used to be clicked repeatedly. */}
              <MenuAction
                label={exporting ? 'Preparing the workbook…' : 'Full roster + pay rates (Excel)'}
                hint="Everyone, ignoring the filters, with the payroll rate card and assignment counts the roster screen never receives. Built on the server."
                icon={<FileSpreadsheet size={13} />}
                tone="var(--success)"
                disabled={exporting}
                onClick={() => { close(); handleExportExcel(); }}
              />
            </>
          )}
        </ToolbarMenu>
        {canCreate && (
          <>
            <ToolbarMenu label="Import" icon={<Upload size={13} />} panelWidth={260}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Bring in a client's appraiser workbook. Every import is rehearsed first and shows
                what it would change before anything is written.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                <UploadExcelControls
                  onUpload={handleUpload}
                  onDownloadTemplate={downloadTemplate}
                  accept=".xlsx,.xls"
                  busy={uploading}
                  busyLabel="Importing roster…"
                  uploadLabel="Upload a filled workbook"
                  templateLabel="Download the blank template"
                />
              </div>
            </ToolbarMenu>
            <button onClick={() => setCreating(true)} className="btn btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '8px 14px' }}>
              <Plus size={14} /> Add assayer
            </button>
          </>
        )}
      </div>

      {/*
        The panel that used to hold two dropdowns — "State they live in" and "Stage with HR" —
        and nothing else, on a screen whose owner asked to be able to "filter by anything we
        require". Nineteen axes now, grouped and counted; see roster-filters.ts for the list and
        RosterFilterPanel.tsx for why it is tick boxes rather than a query builder.
      */}
      {showFilters && (
        <RosterFilterPanel
          rows={assayers}
          state={filters}
          onChange={setFilters}
          onClearAll={clearFilters}
        />
      )}

      {/*
        What is narrowing the list right now, and how to take any one of it off.

        Four controls could be in force at once — a chip, two dropdowns behind a collapsed panel,
        and the search box — so an empty table had no visible cause. Every criterion is a pill,
        each pill comes off on its own, and one link clears the lot.
      */}
      <AppliedFilterBar
        state={filters}
        shown={rows.length}
        total={assayers.length}
        onChange={setFilters}
        onClearAll={clearFilters}
      />

      {/*
        The review queue for cells an import could not read. It kept its place near the top
        because that is where the import that fills it is started from — and it has its own page
        (`/hr/issues`, badged in the tab strip), because a collapsed panel below a thousand-row
        table is not somewhere a queue can be found on purpose.
      */}
      <ImportIssuesPanel canManage={canManage} onResolved={load} />

      {/* Bulk bar — only present when a selection exists, so it never adds noise. */}
      {canManage && selected.length > 0 && (
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px',
          background: 'var(--status-pending-bg)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
        }}>
          <strong style={{ fontSize: '13px' }}>{selected.length} selected</strong>
          {hiddenNote && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{hiddenNote}</span>
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
            <div style={{ flexBasis: '100%', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
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
            <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: '12px', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
          </div>
          {bulkReport.skipped.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Could not reach {assayerLifecycleLabel(bulkReport.target)}:</div>
              {bulkReport.skipped.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ color: 'inherit' }}>{bulkReport.names[s.id] ?? 'This assayer'} — {assayerLifecycleLabel(s.current)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>— {s.reason}</span>
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
                  <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>— {f.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        Roster.

        This was hand-written `<table>` markup with its own `Th`, its own head and cell styles, its
        own skeleton and its own selection column — the third table primitive in a section that
        already had two. It is `DataTable` now, which is where the sortable header, the row keying,
        the per-page select-all and the empty state come from; what stays here is only what is
        actually about assayers.
      */}
      <div style={{ border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden', background: 'var(--bg-card)' }}>
        <DataTable<RosterPerson>
          density="compact"
          rows={phase === 'skeleton' ? [] : rows.slice(0, visibleCount)}
          rowKey={(a) => a.id}
          onRowClick={(a) => openRecord(a.id)}
          /*
            The shape of the table, not the words "Loading roster…". A bare string replaced the
            entire table on every load, so arriving at the roster went blank → one line of text →
            200 rows, and the page jumped as they landed.
          */
          loading={phase === 'skeleton'}
          loadingRows={8}
          sortKey={sort.key}
          sortOrder={sort.dir}
          onSort={(k) => sortBy(k as SortKey)}
          selectable={canManage}
          selected={selectedIds}
          onToggleSelect={toggle}
          onSelectAll={(checked) => setSelectedIds(checked ? new Set(rows.map((r) => r.id)) : new Set())}
          // The roster's own tint for a ticked row, rather than DataTable's default: the bulk bar
          // above it is already keyed to the accent, and the two have to read as one selection.
          rowStyle={(a) => (selectedIds.has(a.id)
            ? { background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }
            : undefined)}
          emptyState={(
            <>
              <Users size={26} style={{ opacity: 0.35 }} />
              <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '10px' }}>Nobody matches this view</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                {/* "Try a different segment or clear the filters" makes the reader hunt for which
                    of four controls is responsible — and the segment pill and the Status dropdown
                    can contradict each other outright (Active + Resigned can never match anybody)
                    while the Filters panel is collapsed and shows nothing. Name the criteria
                    actually in force. */}
                {assayers.length === 0
                  ? 'The roster is empty — import a workforce file or add someone.'
                  : `No one matches ${activeCriteria.join(' + ')}.`}
              </div>
              {assayers.length > 0 && (
                <button
                  onClick={clearFilters}
                  className="btn btn-secondary"
                  style={{ marginTop: '10px', fontSize: '12px', padding: '5px 12px' }}
                >
                  Show everyone
                </button>
              )}
            </>
          )}
          columns={[
            {
              key: 'displayName',
              header: 'Assayer',
              sortable: true,
              render: (a) => (
                <>
                  <div style={{ fontWeight: 600 }}>{a.displayName}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{a.phone}</div>
                </>
              ),
            },
            {
              key: 'assayerCode',
              header: 'Code',
              sortable: true,
              render: (a) => <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{a.assayerCode}</span>,
            },
            {
              key: 'lifecycleStatus',
              header: 'Stage',
              sortable: true,
              /*
                Mid-joining stages carry what has to happen next, in the planner's own words
                (`ONBOARDING_NEXT_STEP`, one map in @fapoms/shared). A coordinator who is told on
                the planning screen that somebody is "in training — mark training complete on the
                HR roster to activate" arrives here and finds the same sentence on the row.
              */
              render: (a) => {
                const tone = STATUS_COLORS[a.lifecycleStatus] ?? 'var(--text-muted)';
                return (
                  <span
                    title={onboardingNextStep(a) ? `Onboarding not finished: ${onboardingNextStep(a)}.` : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 600, color: tone }}
                  >
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: tone }} />
                    {assayerLifecycleLabel(a.lifecycleStatus)}
                  </span>
                );
              },
            },
            {
              key: 'state',
              header: 'Location',
              sortable: true,
              render: (a) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <MapPin size={11} style={{ color: 'var(--text-muted)' }} />
                  {[a.city, a.state].filter(Boolean).join(', ') || '—'}
                </span>
              ),
            },
            {
              key: 'completeness',
              header: 'Record',
              sortable: true,
              render: (a) => <RecordGaps a={a} />,
            },
            {
              key: 'joiningDate',
              header: 'Joined',
              sortable: true,
              render: (a) => {
                const months = tenureMonths(a);
                return (
                  <>
                    {fmtDate(a.joiningDate)}
                    {months !== null && <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}> · {months}m</span>}
                  </>
                );
              },
            },
            {
              // "Exp" could as easily have been an expiry date. It is years of experience.
              key: 'experienceYears',
              header: 'Experience',
              sortable: true,
              render: (a) => <>{a.experienceYears ?? 0}y</>,
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'right',
              render: (a) => (
                // Named per row, not generically: "Edit" beside 1,163 identical pencils tells a
                // screen-reader user which control they are on and nothing about whose record it
                // opens.
                <span onClick={(e) => e.stopPropagation()}>
                  {/*
                    The way back into an unfinished registration.

                    The wizard writes to the person's own row as the clerk goes — there is no draft
                    store, deliberately — so closing it half-way leaves a real, findable record
                    rather than losing the typing. Resuming it, though, was reachable only by
                    typing `?register=<id>` into the address bar: nothing in the application set
                    that parameter. So a clerk who stopped at step three had no route back, and
                    "Add assayer" started a second record for the same person. On this roster 80
                    people sit in a joining stage with no document and no client standing.

                    Offered only while they are still joining, because that is exactly when the
                    wizard has anything left to ask.
                  */}
                  {canCreate && isOnboardingStage(a.lifecycleStatus) && (
                    <IconBtn
                      label={`Finish registering ${a.displayName}`}
                      onClick={() => setSearchParams((prev) => {
                        const next = new URLSearchParams(prev);
                        next.set('register', a.id);
                        return next;
                      })}
                    >
                      <PlayCircle size={13} />
                    </IconBtn>
                  )}
                  {canManage && <IconBtn label={`Edit ${a.displayName}`} onClick={() => navigate(`/hr/roster/${a.id}?edit=1`)}><Edit2 size={13} /></IconBtn>}
                  {canManage && <IconBtn label={`Delete ${a.displayName}`} tone="var(--danger)" onClick={() => remove(a)}><Trash2 size={13} /></IconBtn>}
                </span>
              ),
            },
          ]}
        />
        {!loading && rows.length > 0 && (
          <div style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
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
              <button onClick={() => setVisibleCount((c) => c + RENDER_CHUNK)} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '12px' }}>
                Show more ({rows.length - visibleCount} more)
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        * Opened either by the Add button or by `?register=<id>`, which is what makes an
        * interrupted registration resumable: every step of the flow writes to the person's real
        * record, so there is no draft to reopen — only the person, and a link that reopens the
        * flow on them at the first thing still missing. Without the URL half, a clerk whose
        * browser closed on step 4 would have to finish the person field by field on the record
        * page, which is the screen the flow exists to spare them.
        */}
      {(creating || resumeRegistrationId) && (
        <RegistrationWizard
          resumeAssayerId={resumeRegistrationId ?? undefined}
          onClose={closeRegistration}
          onCreated={() => { closeRegistration(); refresh(); }}
        />
      )}

      {/*
        Choosing what leaves the building. Handed `filtered` rather than `rows` because the sort
        is the screen's, not the file's — the dialog orders columns by the catalogue and rows by
        whatever the table is showing, so two exports of the same selection line up.
      */}
      <RosterExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        filtered={rows}
        all={assayers}
        truncated={truncated}
        rosterTotal={rosterTotal}
        filterSummary={
          appliedCount === 0
            ? 'Everyone currently listed — no filter is applied.'
            : `Matching ${activeCriteria.join(' + ')}.`
        }
        onExcelExport={handleExportExcel}
        excelBusy={exporting}
      />
    </div>
  );
};

/**
 * What is missing from one person's record, and whether anybody is expected to do something.
 *
 * A record belonging to somebody who has left is stated, not demanded. The gap chips above count
 * only people who can still be given work, and this cell used to shout "Cannot be paid" in red at
 * the same terminated records the chips had just excluded — so the list and its own filters
 * disagreed on screen. The gaps are still shown, because a past payment may yet need settling;
 * they are simply not an outstanding task.
 */
const RecordGaps: React.FC<{ a: RosterPerson }> = ({ a }) => {
  const missing = missingFields(a);
  const blockers = payoutBlockers(a);

  if (missing.length > 0 && !stillWorkable(a)) {
    return (
      <span
        title={`Missing: ${missing.join(', ')}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-muted)' }}
      >
        {/* "left" covers resigning, dismissal and archiving; it does not cover dying, and this
            cell only started reaching those records once the gap chips learned to exclude them.
            The backend says "no longer with us" for the same reason and in the same words. */}
        {counted(missing.length, 'gap')} · {isRecordedDeceased(a) ? 'no longer with us' : 'left'}
      </span>
    );
  }
  if (missing.length === 0) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--success)', fontSize: '12px' }}>
        <CheckCircle2 size={12} /> Complete
      </span>
    );
  }
  return (
    <span
      title={`Missing: ${missing.join(', ')}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 600,
        color: blockers.length ? 'var(--danger)' : 'var(--warning)',
      }}
    >
      <AlertTriangle size={12} />
      {/* "3 missing" reads as tidying-up. "Cannot be paid" is what it actually means, and it is
          the difference between a gap someone gets to next month and one that stops a payout run. */}
      {blockers.length ? `Cannot be paid · ${missing.length} missing` : `${missing.length} missing`}
    </span>
  );
};

/**
 * A button that is nothing but a picture, forced to say what it is.
 *
 * `label` is required and becomes BOTH the accessible name and the hover text. It used to be
 * `title` alone: a title attribute is invisible to a screen reader's button list, never appears
 * on a touch screen, and needs a mouse to hover for it — so a pencil and a bin beside each other
 * on every one of 1,163 rows were, to anyone not using a mouse, two unnamed buttons, one of
 * which deletes a person's entire record.
 *
 * Making it required rather than optional is the point. Two icon-only buttons in this section
 * had no accessible name at all, and both had been added by copying a neighbouring one; a prop
 * the compiler insists on is the only version of this rule that survives the next copy-paste.
 */
const IconBtn: React.FC<{ label: string; onClick: () => void; tone?: string; children: React.ReactNode }> = ({
  label: text, onClick, tone, children,
}) => (
  <button
    aria-label={text}
    title={text}
    onClick={onClick}
    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 5px', color: tone ?? 'var(--text-muted)' }}
  >
    {children}
  </button>
);

/*
  `RosterFilterSelect` is gone with the two-dropdown panel it existed for. Its replacement is
  `RosterFilterPanel`, which renders every axis in `ROSTER_FILTERS` from one definition instead
  of one bespoke control per question — the shape that kept this screen at two filters.
*/

export default AssayerRoster;

/**
 * What a finished roster import did, in the operator's terms.
 *
 * The roster reports different things from a branch sheet — references, background checks, bank
 * empanelments, and cells that could not be read — so it describes itself rather than being forced
 * through the branch summary. Written to the same contract, so the shared panel renders it.
 */
export function summariseRosterImport(r: RosterImportSummary): ImportSummary {
  const extras = [
    r.references ? `${r.references.toLocaleString('en-IN')} references` : '',
    r.backgroundChecks ? `${r.backgroundChecks.toLocaleString('en-IN')} background checks` : '',
    r.empanelments ? `${r.empanelments.toLocaleString('en-IN')} empanelments` : '',
    r.onboardingDocuments ? `${r.onboardingDocuments.toLocaleString('en-IN')} document records` : '',
  ].filter(Boolean);

  const notes = [
    ...(r.notes ?? []),
    r.issues > 0
      ? `${counted(r.issues, 'cell')} couldn't be read — open "Import issues" to review them. Those rows still imported, just with that one detail left blank.`
      : '',
    r.skipped > 0 ? `${counted(r.skipped, 'row')} skipped (no appraiser code).` : '',
  ].filter(Boolean);

  if (r.created === 0 && r.updated === 0) {
    return {
      tone: 'error',
      text:
        `Nothing was imported. ${r.rowsRead.toLocaleString('en-IN')} row(s) were read but no appraiser `
        + 'could be built from them — check that the workbook has an "Appraiser code" column.',
      notes: notes.length ? notes : undefined,
    };
  }

  return {
    tone: r.issues > 0 || r.skipped > 0 ? 'warning' : 'success',
    text:
      `Roster imported — ${r.created.toLocaleString('en-IN')} new, ${r.updated.toLocaleString('en-IN')} updated`
      + (extras.length ? ` (plus ${extras.join(', ')})` : '') + '.',
    notes: notes.length ? notes : undefined,
  };
}
