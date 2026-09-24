import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { assayerLifecycleLabel, isBackgroundJobInFlight, type BackgroundJobScope } from '@fapoms/shared';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { useConfirm, AlertBanner, Modal } from '../../components/ui';
import { UploadExcelControls } from '../../components/ui';
import { ImportIssuesPanel } from './ImportIssuesPanel';
import { visibleSelection, hiddenSelectionNote } from '../../utils/selection';
import { useCurrentRoles, canManageAssayers, canCreateAssayers } from '../../hooks/useCurrentRoles';
import { useQueuedExcelExport } from '../../hooks/useQueuedExcelExport';
import { waitForQueuedJob, type EnqueuedJob } from '../../services/queued-job';
import { DeliveryBatchNote } from '../../components/DeliveryNote';
import {
  type RosterPerson,
} from './roster-filters';
import { RosterFilterPanel, AppliedFilterBar } from './RosterFilterPanel';
import { RosterExportDialog } from './RosterExportDialog';
import { RECORD_LINK_PARAMS } from './record-sections';
import { counted } from '../../utils/plural';
import { useBackgroundJob } from '../../hooks/useBackgroundJob';
import { BackgroundJobPanel } from '../../components/jobs/BackgroundJobPanel';
import { RosterImportReview, RosterImportOutcome, rosterImportDetails } from './roster/RosterImportJobViews';

// Modular Roster Subcomponents
import { useRosterQuery } from './roster/useRosterQuery';
import { RosterHeader } from './roster/RosterHeader';
import { RosterSegmentTabs } from './roster/RosterSegmentTabs';
import { RosterTable } from './roster/RosterTable';
import { RosterBulkToolbar } from './roster/RosterBulkToolbar';
import { LifecycleTransitionModal } from './roster/LifecycleTransitionModal';

/**
 * The roster import runs as a background job (`ROSTER_IMPORT`) on the one national roster — every
 * roster upload shares this scope, so the page finds its rehearsal or import after a refresh.
 */
const ROSTER_IMPORT_SCOPE: BackgroundJobScope = { type: 'ROSTER', id: null };

/** How a summary is said on screen: a tone, a sentence, and one line per extra fact. */
export interface ImportSummary {
  tone: 'success' | 'warning' | 'error';
  text: string;
  notes?: string[];
}

/** What a roster import (or its rehearsal) reports — the job's `result.details`. */
export interface RosterImportSummary {
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

export const AssayerRoster: React.FC<{
  exactCounts?: Partial<Record<string, number | undefined>>;
}> = ({ exactCounts }) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);
  const canCreate = canCreateAssayers(roles);
  const { confirm, confirmDialog } = useConfirm();

  // Roster Query Hook
  const {
    filters,
    setFilters,
    clearFilters,
    sort,
    sortBy,
    filterDefs,
    appliedCount,
    activeCriteria,
    allAssayers,
    sortedRows,
    totalCount,
    truncated,
    loading,
    query: rosterLoad,
    refresh,
  } = useRosterQuery();
  const rosterFailed = loadFailed(rosterLoad);

  const [notice, setNotice] = useState<{
    tone: 'ok' | 'err';
    text: string;
    details?: string[];
  } | null>(null);
  const [noticeExpanded, setNoticeExpanded] = useState(false);

  const [showFilters, setShowFilters] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(200);

  // Single-person lifecycle transition modal state
  const [transitionTarget, setTransitionTarget] = useState<{
    person: RosterPerson;
    targetStatus: string;
  } | null>(null);
  const [transitionBusy, setTransitionBusy] = useState(false);

  // Bulk operation states
  const [bulkBusy, setBulkBusy] = useState(false);
  const [appAccessBusy, setAppAccessBusy] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(false);
  /**
   * A bulk run's progress line. The runs happen on the server in the background now — a 540-person
   * credential run used to hold one request for about half an hour and time out in the browser at
   * 30 s while the server carried on — so the page shows where the run has got to instead.
   */
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  /** The emails a finished bulk run queued, followed until they have gone. */
  const [bulkEmails, setBulkEmails] = useState<{ ids: string[]; what: string } | null>(null);
  /** The texts a finished credential run queued, followed the same way beside the emails. */
  const [bulkTexts, setBulkTexts] = useState<{ ids: string[]; what: string } | null>(null);

  // Excel export & import hooks
  const { download: downloadExcel, busy: exporting } = useQueuedExcelExport();
  const handleExportExcel = () => void downloadExcel('/reports/assayer-roster/jobs');
  // Same queue, same poll-and-save flow — only the renderer on the server differs, and the hook
  // saves whatever filename the job reports, so nothing here needs to know it is a PDF.
  const { download: downloadPdf, busy: exportingPdf } = useQueuedExcelExport();
  const handleExportPdf = () => void downloadPdf('/reports/assayer-roster-pdf/jobs');
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);
  /**
   * The roster rehearsal and import, as the server has them. Read from `GET /jobs` on mount, so a
   * refresh — or a hard refresh — mid-run shows the same run, and a rehearsal still waiting for its
   * answer is offered again. Updated live by the socket.
   */
  const rosterJob = useBackgroundJob('ROSTER_IMPORT', ROSTER_IMPORT_SCOPE, { endpoint: '/assayers/roster/import' });
  const rosterJobNow = rosterJob.job;
  const uploading = rosterJob.upload.phase === 'uploading'
    || (!!rosterJobNow && isBackgroundJobInFlight(rosterJobNow.status));
  /** A finished run the operator closed; the next run shows again. */
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  /** The roster list is re-read once when a real import lands — not on every render after. */
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!rosterJobNow || rosterJobNow.status !== 'SUCCEEDED') return;
    if (rosterImportDetails(rosterJobNow)?.dryRun !== false) return;
    if (refreshedFor.current === rosterJobNow.id) return;
    refreshedFor.current = rosterJobNow.id;
    refresh();
  }, [rosterJobNow, refresh]);

  // Deep-link query param routing
  useEffect(() => {
    const wanted = searchParams.get('assayer');
    if (!wanted) return;
    const forwarded = new URLSearchParams();
    for (const key of RECORD_LINK_PARAMS) {
      const value = searchParams.get(key);
      if (value !== null) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    void navigate(`/hr/roster/${encodeURIComponent(wanted)}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [searchParams, navigate]);

  /**
   * `?register=<id>` used to open the wizard on an existing person — a second editor for a record
   * the record page already edits, and the only thing it added was a list of gaps that page has
   * shown at the top since before the wizard existed. It now lands where every other edit lands.
   *
   * The parameter is still honoured rather than dropped: it is in links the backend worklist hands
   * out and in whatever somebody bookmarked.
   */
  useEffect(() => {
    const id = searchParams.get('register');
    if (id) void navigate(`/hr/roster/${encodeURIComponent(id)}?edit=1`, { replace: true });
  }, [searchParams, navigate]);

  useEffect(() => {
    setVisibleCount(200);
  }, [filters, sort]);

  // Selection semantics: Visible rows vs total
  const { rows: selectedRows, ids: selectedVisibleIds, hiddenCount } = useMemo(
    () => visibleSelection(selectedIds, sortedRows, (r) => r.id),
    [selectedIds, sortedRows],
  );
  const hiddenNote = hiddenSelectionNote(hiddenCount, 'assayer');

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(sortedRows.map((r) => r.id)) : new Set());
  };

  // Lifecycle transition executions
  const handleSingleTransitionConfirm = async (targetStatus: string, reason: string) => {
    if (!transitionTarget) return;
    setTransitionBusy(true);
    try {
      await api.request(`/assayers/${transitionTarget.person.id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, reason }),
      });
      setNotice({
        tone: 'ok',
        text: `${transitionTarget.person.displayName} transitioned to ${assayerLifecycleLabel(targetStatus)}.`,
      });
      setTransitionTarget(null);
      refresh();
    } catch (err) {
      throw new Error(userMessage(err));
    } finally {
      setTransitionBusy(false);
    }
  };

  const handleBulkTransition = async (targetStatus: string, reason: string) => {
    if (selectedRows.length === 0) return;
    setBulkBusy(true);
    const ids = selectedVisibleIds;
    const nameById = Object.fromEntries(
      selectedRows.map((a) => [a.id, `${a.displayName} (${a.assayerCode})`]),
    );

    try {
      // Accepted, then walked on the server: a select-all walk took 50–120 s, past this client's 30 s.
      const { jobId } = await api.request<EnqueuedJob>('/assayers/bulk/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ ids, targetStatus, reason }),
      });
      setBulkProgress(`Moving ${counted(ids.length, 'person', 'people')} to ${assayerLifecycleLabel(targetStatus)}…`);
      const res = await waitForQueuedJob<{
        succeeded: { id: string; from: string; to: string }[];
        skipped: { id: string; current: string; reason: string }[];
        failed: { id: string; reason: string }[];
        /** Moved, but not all the way — stopped part-way along a multi-hop walk. */
        partial: { id: string; from: string; reached: string; target: string; reason: string }[];
      }>(`/assayers/bulk-jobs/${jobId}`, { onProgress: (p) => setBulkProgress(`${p.stage}…`) });

      /**
       * `partial` is a fourth outcome and has to be said out loud.
       *
       * A multi-hop walk that stops part-way leaves the person somewhere real but not where the
       * operator asked. Destructuring only the other three dropped it silently: the row counted
       * as neither moved nor skipped nor failed, so a partial result rendered as
       * "0 moved, 0 skipped, 0 failed" in the success tone — the operator would read that as
       * nothing having happened, on the one outcome where something did.
       */
      const { succeeded = [], skipped = [], failed = [], partial = [] } = res ?? {};
      const moved = succeeded.length;
      const details = [
        ...partial.map(
          (p) =>
            `${nameById[p.id] ?? 'This assayer'} got as far as ${assayerLifecycleLabel(p.reached)} `
            + `on the way to ${assayerLifecycleLabel(p.target)}, and stopped there: ${p.reason}`,
        ),
        ...skipped.map(
          (s) =>
            `${nameById[s.id] ?? 'This assayer'} (is ${assayerLifecycleLabel(s.current)}): ${s.reason}`,
        ),
        ...failed.map((f) => `${nameById[f.id] ?? 'This assayer'}: ${f.reason}`),
      ];

      setNotice(
        failed.length || skipped.length || partial.length
          ? {
              tone: 'err',
              text: `${moved} moved to ${assayerLifecycleLabel(targetStatus)}`
                + `${partial.length ? `, ${partial.length} part-way` : ''}`
                + `, ${skipped.length} skipped, ${failed.length} failed.`,
              details,
            }
          : {
              tone: 'ok',
              text: `${counted(moved, 'person', 'people')} moved to ${assayerLifecycleLabel(targetStatus)}.`,
            },
      );
    } catch (e) {
      // "Nobody was moved" is only certain when the request itself was refused; a run that failed
      // or is still going may have moved some people, which the refreshed list shows.
      setNotice({ tone: 'err', text: `The move did not finish. ${userMessage(e)} Check the list — it has been refreshed.` });
    } finally {
      setBulkBusy(false);
      setBulkProgress(null);
      setSelectedIds(new Set());
      refresh();
    }
  };

  const handleBulkIssueAppAccess = async () => {
    if (selectedRows.length === 0) return;
    const names = selectedRows.slice(0, 5).map((a) => `${a.displayName} (${a.assayerCode})`);
    const ok = await confirm({
      title: `Issue app access to ${counted(selectedRows.length, 'person', 'people')}?`,
      message: (
        <>
          Each person receives new credentials delivered by email and SMS according to their record.
          <div style={{ marginTop: '8px', fontSize: 'var(--text-xs)' }}>
            {names.join(', ')}
            {selectedRows.length > names.length && ` and ${selectedRows.length - names.length} more`}
          </div>
          {hiddenNote && <div style={{ marginTop: '6px', fontSize: 'var(--text-xs)' }}>{hiddenNote}</div>}
        </>
      ),
      confirmLabel: `Issue access to ${selectedRows.length}`,
      reversible: false,
    });
    if (!ok) return;

    setAppAccessBusy(true);
    setBulkEmails(null);
    setBulkTexts(null);
    const ids = selectedVisibleIds;
    try {
      const { jobId } = await api.request<EnqueuedJob>('/assayers/app-access/bulk', { method: 'POST', body: JSON.stringify({ ids }) });
      setBulkProgress(`Issuing app access to ${counted(ids.length, 'person', 'people')}…`);
      const res = await waitForQueuedJob<{
        /** `EMAIL`/`SMS` mean queued, not delivered; `emailId`/`smsId` are the receipts to follow. */
        succeeded: { id: string; channels: ('EMAIL' | 'SMS')[]; emailId?: string; smsId?: string }[];
        skipped: { id: string; reason: string }[];
        failed: { id: string; reason: string }[];
      }>(`/assayers/bulk-jobs/${jobId}`, { onProgress: (p) => setBulkProgress(`${p.stage}…`) });
      const { succeeded = [], skipped = [], failed = [] } = res ?? {};
      const byEmail = succeeded.filter((s) => s.channels.includes('EMAIL')).length;
      const bySms = succeeded.filter((s) => s.channels.includes('SMS')).length;
      setBulkEmails({ ids: succeeded.flatMap((s) => (s.emailId ? [s.emailId] : [])), what: 'credential emails' });
      setBulkTexts({ ids: succeeded.flatMap((s) => (s.smsId ? [s.smsId] : [])), what: 'credential texts' });

      setNotice(
        failed.length || skipped.length
          ? {
              tone: 'err',
              text: `Issued credentials to ${succeeded.length} (${byEmail} emails queued, ${bySms} texts queued), ${skipped.length} skipped, ${failed.length} failed.`,
              details: [
                ...skipped.map((s) => `${s.id}: ${s.reason}`),
                ...failed.map((f) => `${f.id}: ${f.reason}`),
              ],
            }
          : {
              tone: 'ok',
              text: `Issued app access to ${counted(succeeded.length, 'person', 'people')} (${byEmail} emails queued, ${bySms} texts queued).`,
            },
      );
    } catch (e) {
      setNotice({ tone: 'err', text: `Failed to issue app access. ${userMessage(e)}` });
    } finally {
      setAppAccessBusy(false);
      setBulkProgress(null);
      setSelectedIds(new Set());
    }
  };

  /**
   * Same shape as `handleBulkIssueAppAccess` above: one POST, three buckets back, one notice.
   * The dialog itself (`RosterNotifyDialog`) is the confirmation step here — there is nothing
   * further to ask once a clerk has typed a subject and a message and can see who it goes to.
   */
  const handleBulkNotify = async (subject: string, body: string, sendEmail: boolean) => {
    if (selectedRows.length === 0) return;
    const nameById = Object.fromEntries(
      selectedRows.map((a) => [a.id, `${a.displayName} (${a.assayerCode})`]),
    );

    setNotifyBusy(true);
    setBulkEmails(null);
    setBulkTexts(null);
    const ids = selectedVisibleIds;
    try {
      const { jobId } = await api.request<EnqueuedJob>('/assayers/bulk/notify', {
        method: 'POST',
        body: JSON.stringify({ ids, subject, body, sendEmail }),
      });
      setBulkProgress(`Sending the message to ${counted(ids.length, 'person', 'people')}…`);
      const res = await waitForQueuedJob<{
        succeeded: { id: string; channels: ('IN_APP' | 'EMAIL')[]; emailId?: string }[];
        skipped: { id: string; reason: string }[];
        failed: { id: string; reason: string }[];
      }>(`/assayers/bulk-jobs/${jobId}`, { onProgress: (p) => setBulkProgress(`${p.stage}…`) });
      const { succeeded = [], skipped = [], failed = [] } = res ?? {};
      const byInApp = succeeded.filter((s) => s.channels.includes('IN_APP')).length;
      const byEmail = succeeded.filter((s) => s.channels.includes('EMAIL')).length;
      setBulkEmails({ ids: succeeded.flatMap((s) => (s.emailId ? [s.emailId] : [])), what: 'messages' });

      setNotice(
        failed.length || skipped.length
          ? {
              tone: 'err',
              text: `Notified ${succeeded.length} (${byInApp} in-app, ${byEmail} emails queued), ${skipped.length} skipped, ${failed.length} failed.`,
              details: [
                ...skipped.map((s) => `${nameById[s.id] ?? s.id}: ${s.reason}`),
                ...failed.map((f) => `${nameById[f.id] ?? f.id}: ${f.reason}`),
              ],
            }
          : {
              tone: 'ok',
              text: `Notified ${counted(succeeded.length, 'person', 'people')} (${byInApp} in-app, ${byEmail} emails queued).`,
            },
      );
    } catch (e) {
      setNotice({ tone: 'err', text: `Failed to notify. ${userMessage(e)}` });
    } finally {
      setNotifyBusy(false);
      setBulkProgress(null);
      setSelectedIds(new Set());
    }
  };

  const handleDeleteAssayer = async (a: RosterPerson) => {
    const ok = await confirm({
      title: `Delete ${a.displayName}?`,
      message: `The entire record for ${a.displayName} (${a.assayerCode}) will be soft-deleted, including documents and commercial profiles.`,
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

  // Rehearsal & real import
  /**
   * Upload the workbook for a rehearsal. The server stores it and answers at once; the rehearsal
   * (the whole import, rolled back) runs in the background and ends waiting for review, where
   * `RosterImportReview` shows what it would do and offers the real import.
   *
   * The flags travel in the job's `params`, which the route reads — never in the URL, where an old
   * page once put them and the "rehearsal" was run as a real import.
   */
  const handleUpload = async (file: File) => {
    setDismissedJobId(null);
    await rosterJob.start(file, { dryRun: true, overwrite: overwriteConflicts });
  };

  /**
   * Import what the rehearsal checked: the same confirmation as before, then the reviewed rehearsal
   * is committed on the server, which runs the real import over the same stored file.
   */
  const handleConfirmImport = async (dry: RosterImportSummary, jobId: string) => {
    const proceed = await confirm({
      title: `Import ${dry.rowsRead.toLocaleString('en-IN')} appraisers from this workbook?`,
      message: (
        <div>
          This will add <strong>{dry.created.toLocaleString('en-IN')}</strong> and update{' '}
          <strong>{dry.updated.toLocaleString('en-IN')}</strong> appraisers.
          {dry.skipped > 0 && (
            <div style={{ marginTop: '6px', fontSize: 'var(--text-xs)' }}>
              {dry.skipped} row(s) without appraiser code will be skipped.
            </div>
          )}
        </div>
      ),
      confirmLabel: `Import ${dry.rowsRead.toLocaleString('en-IN')} appraisers`,
    });
    if (!proceed) return;
    await rosterJob.commit({ dryRun: false }, jobId);
  };

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
      setNotice({ tone: 'err', text: `Could not download template. ${userMessage(e)}` });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {confirmDialog}

      {/*
        The roster run, as the server has it — the same after a refresh. Uploading, queued and
        running show the shared job card (progress, "you can leave this page", cancel); a rehearsal
        waiting for review shows what it would do and offers the import; a finished import says
        what it did. A finished rehearsal (reviewed or discarded) needs nothing more said.
      */}
      {rosterJob.upload.phase !== 'idle' ? (
        // Bytes still travelling (or refused on the way): only this tab has them.
        <BackgroundJobPanel handle={rosterJob} />
      ) : rosterJobNow?.status === 'AWAITING_REVIEW' ? (
        <RosterImportReview
          job={rosterJobNow}
          onImport={(dry) => void handleConfirmImport(dry, rosterJobNow.id)}
          onDiscard={() => void rosterJob.cancel(rosterJobNow.id)}
        />
      ) : rosterJobNow?.status === 'SUCCEEDED' && rosterImportDetails(rosterJobNow)?.dryRun === false ? (
        rosterJobNow.id !== dismissedJobId && (
          <RosterImportOutcome
            job={rosterJobNow}
            summarise={summariseRosterImport}
            onDismiss={() => setDismissedJobId(rosterJobNow.id)}
          />
        )
      ) : rosterJobNow && (isBackgroundJobInFlight(rosterJobNow.status) || rosterJobNow.status === 'FAILED') ? (
        <BackgroundJobPanel handle={rosterJob} />
      ) : null}

      {/* Alert Notices */}
      {bulkProgress && (
        <div role="status" data-testid="bulk-progress" style={{
          padding: '8px 16px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
        }}>
          {bulkProgress} It runs on the server, so it carries on if you leave this page.
        </div>
      )}
      {bulkEmails && bulkEmails.ids.length > 0 && <DeliveryBatchNote ids={bulkEmails.ids} what={bulkEmails.what} />}
      {bulkTexts && bulkTexts.ids.length > 0 && <DeliveryBatchNote ids={bulkTexts.ids} what={bulkTexts.what} channel="SMS" />}
      {notice && (
        <AlertBanner
          type={notice.tone === 'ok' ? 'success' : 'error'}
          onClose={() => {
            setNotice(null);
            setNoticeExpanded(false);
          }}
          style={{ alignItems: 'flex-start', fontSize: 'var(--text-sm)' }}
        >
          <span style={{ fontWeight: (notice.details ?? []).length ? 600 : 400 }}>
            {notice.text}
          </span>
          {(notice.details ?? []).length > 0 && (
            <ul
              style={{
                margin: '6px 0 0',
                paddingLeft: '18px',
                fontSize: 'var(--text-xs)',
                lineHeight: 1.5,
              }}
            >
              {(noticeExpanded ? notice.details! : notice.details!.slice(0, 5)).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {(notice.details ?? []).length > 5 && (
            <button
              type="button"
              onClick={() => setNoticeExpanded((v) => !v)}
              title={noticeExpanded ? 'Collapse the import summary' : `Expand to see all ${notice.details!.length} import details`}
              style={{
                marginTop: '6px',
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 'var(--text-xs)',
                fontWeight: 700,
                textDecoration: 'underline',
                padding: 0,
              }}
            >
              {noticeExpanded ? 'Show fewer' : `Show all ${notice.details!.length}`}
            </button>
          )}
        </AlertBanner>
      )}

      {truncated && (
        <AlertBanner type="error">
          Showing {allAssayers.length.toLocaleString('en-IN')} of{' '}
          {totalCount.toLocaleString('en-IN')} people — narrow filters to reach additional records.
        </AlertBanner>
      )}

      {/* Roster Header */}
      <RosterHeader
        totalCount={totalCount}
        filteredCount={sortedRows.length}
        appliedCount={appliedCount}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters((v) => !v)}
        onOpenExport={() => setShowExport(true)}
        onOpenImport={() => setShowImport(true)}
        canCreate={canCreate}
        canManage={canManage}
        onExportExcel={handleExportExcel}
        exportingExcel={exporting}
      />

      {/* Segment Tabs */}
      <RosterSegmentTabs
        currentSegmentKey={filters.segment}
        onSelectSegment={(seg) => setFilters({ ...filters, segment: seg })}
        rows={allAssayers}
        exactCounts={exactCounts}
      />

      {/* Filter Panels */}
      {showFilters && (
        <RosterFilterPanel
          rows={allAssayers}
          state={filters}
          onChange={setFilters}
          onClearAll={clearFilters}
          defs={filterDefs}
        />
      )}

      <AppliedFilterBar
        state={filters}
        shown={sortedRows.length}
        total={allAssayers.length}
        onChange={setFilters}
        onClearAll={clearFilters}
        defs={filterDefs}
      />

      <ImportIssuesPanel canManage={canManage} onResolved={refresh} />

      {/* Bulk Operations Toolbar */}
      {canManage && (
        <RosterBulkToolbar
          selectedRows={selectedRows}
          selectedVisibleIds={selectedVisibleIds}
          hiddenCount={hiddenCount}
          hiddenNote={hiddenNote}
          onClearSelection={() => setSelectedIds(new Set())}
          onBulkTransition={handleBulkTransition}
          onBulkIssueAppAccess={handleBulkIssueAppAccess}
          onBulkNotify={handleBulkNotify}
          busy={bulkBusy}
          appAccessBusy={appAccessBusy}
          notifyBusy={notifyBusy}
        />
      )}

      {/* Core Roster Table */}
      {/*
        A roster that could not be read is not a roster with nobody in it.

        This used to push a DISMISSIBLE notice ("Could not load the roster. …") and then render
        the table anyway, which drew `EmptyState title="Workforce roster is empty"` over 1,155
        people — and once the notice was closed, or once the query failed and PAUSED (which
        `isError` never reported at all), the screen said only that. The banner is now permanent
        for as long as the load is failing, and the table is not drawn beside it to contradict it.
      */}
      {rosterFailed ? (
        <LoadFailure loads={[{ label: 'the workforce roster', query: rosterLoad }]} />
      ) : (
      <RosterTable
        rows={sortedRows}
        totalLoaded={allAssayers.length}
        visibleCount={visibleCount}
        loading={loading}
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={sortBy}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onSelectAll={selectAll}
        canManage={canManage}
        canCreate={canCreate}
        onRowClick={(id) => navigate(`/hr/roster/${id}`)}
        onEdit={(id) => navigate(`/hr/roster/${id}?edit=1`)}
        // One editor. "Finish registration" opens the record with its gap list, not a second form.
        onResumeRegistration={(id) => navigate(`/hr/roster/${id}?edit=1`)}
        onStartTransition={(person, targetStatus) =>
          setTransitionTarget({ person, targetStatus })
        }
        onDelete={handleDeleteAssayer}
        onShowMore={() => setVisibleCount((c) => c + 200)}
        activeCriteria={activeCriteria}
        onClearFilters={clearFilters}
      />
      )}

      {/* Single Person Lifecycle Modal */}
      {transitionTarget && (
        <LifecycleTransitionModal
          open={Boolean(transitionTarget)}
          onClose={() => setTransitionTarget(null)}
          assayerName={transitionTarget.person.displayName}
          assayerCode={transitionTarget.person.assayerCode}
          currentStatus={transitionTarget.person.lifecycleStatus}
          targetStatus={transitionTarget.targetStatus}
          onConfirm={handleSingleTransitionConfirm}
          busy={transitionBusy}
        />
      )}

      {/* Export Dialog */}
      <RosterExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        filtered={sortedRows}
        all={allAssayers}
        truncated={truncated}
        rosterTotal={totalCount}
        filterSummary={
          appliedCount === 0
            ? 'Everyone currently listed — no filter is applied.'
            : `Matching ${activeCriteria.join(' + ')}.`
        }
        onExcelExport={handleExportExcel}
        excelBusy={exporting}
        onPdfExport={handleExportPdf}
        pdfBusy={exportingPdf}
      />

      {/* Import Modal */}
      <Modal
        open={showImport}
        onClose={() => setShowImport(false)}
        title="Import the roster from a workbook"
        width="460px"
        footer={
          <button
            type="button"
            onClick={() => setShowImport(false)}
            className="btn btn-secondary"
            title="Close the import dialog without uploading"
            style={{ fontSize: 'var(--text-xs)', padding: '8px 14px' }}
          >
            Close
          </button>
        }
      >
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          Bring in a client's appraiser workbook. Every import is rehearsed first and shows what it
          would change before anything is written.
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            lineHeight: 1.45,
            marginTop: '10px',
          }}
        >
          <input
            type="checkbox"
            checked={overwriteConflicts}
            onChange={(e) => setOverwriteConflicts(e.target.checked)}
            title="When on, values in the sheet overwrite existing records; when off, conflicts are filed for review"
            style={{ marginTop: '3px' }}
          />
          <span>
            Sheet wins conflicts
            <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
              Off: a disagreeing value is left alone and filed for review. On: the sheet replaces it.
            </span>
          </span>
        </label>
        <UploadExcelControls
          onUpload={(file) => {
            setShowImport(false);
            void handleUpload(file);
          }}
          onDownloadTemplate={() => {
            setShowImport(false);
            void downloadTemplate();
          }}
          accept=".xlsx,.xls"
          busy={uploading}
          busyLabel="Importing roster…"
          uploadLabel="Upload a filled workbook"
          templateLabel="Download the blank template"
        />
      </Modal>
    </div>
  );
};

export default AssayerRoster;

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
      ? `${counted(r.issues, 'cell')} couldn't be read — open "Import issues" to review them.`
      : '',
    r.skipped > 0 ? `${counted(r.skipped, 'row')} skipped (no appraiser code).` : '',
  ].filter(Boolean);

  if (r.created === 0 && r.updated === 0) {
    return {
      tone: 'error',
      text: `Nothing was imported. ${r.rowsRead.toLocaleString('en-IN')} row(s) were read but no appraiser could be built.`,
      notes: notes.length ? notes : undefined,
    };
  }

  return {
    tone: r.issues > 0 || r.skipped > 0 ? 'warning' : 'success',
    text: `Roster imported — ${r.created.toLocaleString('en-IN')} new, ${r.updated.toLocaleString('en-IN')} updated${
      extras.length ? ` (plus ${extras.join(', ')})` : ''
    }.`,
    notes: notes.length ? notes : undefined,
  };
}
