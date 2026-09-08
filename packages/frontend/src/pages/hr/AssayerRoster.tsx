import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { assayerLifecycleLabel } from '@fapoms/shared';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useConfirm, AlertBanner, Modal } from '../../components/ui';
import { UploadExcelControls } from '../../components/ui';
import { ImportIssuesPanel } from './ImportIssuesPanel';
import { visibleSelection, hiddenSelectionNote } from '../../utils/selection';
import { useCurrentRoles, canManageAssayers, canCreateAssayers } from '../../hooks/useCurrentRoles';
import { useQueuedExcelExport } from '../../hooks/useQueuedExcelExport';
import {
  type RosterPerson,
} from './roster-filters';
import { RosterFilterPanel, AppliedFilterBar } from './RosterFilterPanel';
import { RosterExportDialog } from './RosterExportDialog';
import { RECORD_LINK_PARAMS } from './record-sections';
import { counted } from '../../utils/plural';
import { useImportJob, type ImportSummary } from '../../components/import/useImportJob';
import { ImportProgressPanel } from '../../components/import/ImportProgressPanel';

// Modular Roster Subcomponents
import { useRosterQuery } from './roster/useRosterQuery';
import { RosterHeader } from './roster/RosterHeader';
import { RosterSegmentTabs } from './roster/RosterSegmentTabs';
import { RosterTable } from './roster/RosterTable';
import { RosterBulkToolbar } from './roster/RosterBulkToolbar';
import { LifecycleTransitionModal } from './roster/LifecycleTransitionModal';

/** What `/assayers/roster/import` returns */
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
    isError,
    error,
    refresh,
  } = useRosterQuery();

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

  // Excel export & import hooks
  const { download: downloadExcel, busy: exporting } = useQueuedExcelExport();
  const handleExportExcel = () => void downloadExcel('/reports/assayer-roster/jobs');
  const [uploading, setUploading] = useState(false);
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);
  const rosterImport = useImportJob<RosterImportSummary>();

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
    navigate(`/hr/roster/${encodeURIComponent(wanted)}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [searchParams, navigate]);

  useEffect(() => {
    const id = searchParams.get('register');
    if (id) navigate(`/hr/register/${encodeURIComponent(id)}`, { replace: true });
  }, [searchParams, navigate]);

  // Import finish synchronization
  const refreshedForImport = useRef<string | null>(null);
  useEffect(() => {
    if (rosterImport.state.phase !== 'done') {
      if (rosterImport.state.phase === 'idle') refreshedForImport.current = null;
      return;
    }
    const key = rosterImport.state.fileName;
    if (refreshedForImport.current === key) return;
    refreshedForImport.current = key;
    refresh();
  }, [rosterImport.state, refresh]);

  useEffect(() => {
    if (isError) {
      setNotice({ tone: 'err', text: `Could not load the roster. ${userMessage(error)}` });
    }
  }, [isError, error]);

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
      const res = await api.request<{
        succeeded: { id: string; from: string; to: string }[];
        skipped: { id: string; current: string; reason: string }[];
        failed: { id: string; reason: string }[];
      }>('/assayers/bulk/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ ids, targetStatus, reason }),
      });

      const { succeeded = [], skipped = [], failed = [] } = res ?? {};
      const moved = succeeded.length;
      const details = [
        ...skipped.map(
          (s) =>
            `${nameById[s.id] ?? 'This assayer'} (is ${assayerLifecycleLabel(s.current)}): ${s.reason}`,
        ),
        ...failed.map((f) => `${nameById[f.id] ?? 'This assayer'}: ${f.reason}`),
      ];

      setNotice(
        failed.length || skipped.length
          ? {
              tone: 'err',
              text: `${moved} moved to ${assayerLifecycleLabel(targetStatus)}, ${skipped.length} skipped, ${failed.length} failed.`,
              details,
            }
          : {
              tone: 'ok',
              text: `${counted(moved, 'person', 'people')} moved to ${assayerLifecycleLabel(targetStatus)}.`,
            },
      );
    } catch (e) {
      setNotice({ tone: 'err', text: `Nobody was moved. ${userMessage(e)}` });
    } finally {
      setBulkBusy(false);
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
          <div style={{ marginTop: '8px', fontSize: '12px' }}>
            {names.join(', ')}
            {selectedRows.length > names.length && ` and ${selectedRows.length - names.length} more`}
          </div>
          {hiddenNote && <div style={{ marginTop: '6px', fontSize: '12px' }}>{hiddenNote}</div>}
        </>
      ),
      confirmLabel: `Issue access to ${selectedRows.length}`,
      reversible: false,
    });
    if (!ok) return;

    setAppAccessBusy(true);
    const ids = selectedVisibleIds;
    try {
      const res = await api.request<{
        succeeded: { id: string; channels: ('EMAIL' | 'SMS')[] }[];
        skipped: { id: string; reason: string }[];
        failed: { id: string; reason: string }[];
      }>('/assayers/app-access/bulk', { method: 'POST', body: JSON.stringify({ ids }) });
      const { succeeded = [], skipped = [], failed = [] } = res ?? {};
      const byEmail = succeeded.filter((s) => s.channels.includes('EMAIL')).length;
      const bySms = succeeded.filter((s) => s.channels.includes('SMS')).length;

      setNotice(
        failed.length || skipped.length
          ? {
              tone: 'err',
              text: `Issued credentials to ${succeeded.length} (${byEmail} by email, ${bySms} by SMS), ${skipped.length} skipped, ${failed.length} failed.`,
              details: [
                ...skipped.map((s) => `${s.id}: ${s.reason}`),
                ...failed.map((f) => `${f.id}: ${f.reason}`),
              ],
            }
          : {
              tone: 'ok',
              text: `Issued app access to ${counted(succeeded.length, 'person', 'people')} (${byEmail} by email, ${bySms} by SMS).`,
            },
      );
    } catch (e) {
      setNotice({ tone: 'err', text: `Failed to issue app access. ${userMessage(e)}` });
    } finally {
      setAppAccessBusy(false);
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
  const rehearseRoster = async (file: File, overwrite: boolean): Promise<RosterImportSummary> => {
    const form = new FormData();
    form.append('file', file);
    return api.request<RosterImportSummary>(
      `/assayers/roster/import?dryRun=true&overwrite=${overwrite}`,
      { method: 'POST', body: form },
    );
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const dry = await rehearseRoster(file, overwriteConflicts);
      const proceed = await confirm({
        title: `Import ${dry.rowsRead.toLocaleString('en-IN')} appraisers from this workbook?`,
        message: (
          <div>
            This will add <strong>{dry.created.toLocaleString('en-IN')}</strong> and update{' '}
            <strong>{dry.updated.toLocaleString('en-IN')}</strong> appraisers.
            {dry.skipped > 0 && (
              <div style={{ marginTop: '6px', fontSize: '12px' }}>
                {dry.skipped} row(s) without appraiser code will be skipped.
              </div>
            )}
          </div>
        ),
        confirmLabel: `Import ${dry.rowsRead.toLocaleString('en-IN')} appraisers`,
      });
      if (!proceed) {
        setUploading(false);
        return;
      }
      await rosterImport.start('/assayers/roster/import', file, {
        overwrite: String(overwriteConflicts),
      });
    } catch (e) {
      setNotice({ tone: 'err', text: userMessage(e) });
    } finally {
      setUploading(false);
    }
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

      <ImportProgressPanel
        state={rosterImport.state}
        onDismiss={rosterImport.reset}
        summarise={summariseRosterImport}
      />

      {/* Alert Notices */}
      {notice && (
        <AlertBanner
          type={notice.tone === 'ok' ? 'success' : 'error'}
          onClose={() => {
            setNotice(null);
            setNoticeExpanded(false);
          }}
          style={{ alignItems: 'flex-start', fontSize: '13px' }}
        >
          <span style={{ fontWeight: (notice.details ?? []).length ? 600 : 400 }}>
            {notice.text}
          </span>
          {(notice.details ?? []).length > 0 && (
            <ul
              style={{
                margin: '6px 0 0',
                paddingLeft: '18px',
                fontSize: '12.5px',
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
              style={{
                marginTop: '6px',
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '12px',
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
          busy={bulkBusy}
          appAccessBusy={appAccessBusy}
        />
      )}

      {/* Core Roster Table */}
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
        onResumeRegistration={(id) => navigate(`/hr/register/${id}`)}
        onStartTransition={(person, targetStatus) =>
          setTransitionTarget({ person, targetStatus })
        }
        onDelete={handleDeleteAssayer}
        onShowMore={() => setVisibleCount((c) => c + 200)}
        activeCriteria={activeCriteria}
        onClearFilters={clearFilters}
      />

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
            style={{ fontSize: '12px', padding: '8px 14px' }}
          >
            Close
          </button>
        }
      >
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          Bring in a client's appraiser workbook. Every import is rehearsed first and shows what it
          would change before anything is written.
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            fontSize: '13px',
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
            style={{ marginTop: '3px' }}
          />
          <span>
            Sheet wins conflicts
            <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '12px' }}>
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
