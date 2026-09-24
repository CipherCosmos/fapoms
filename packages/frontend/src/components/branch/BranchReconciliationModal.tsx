import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  CheckCircle2, AlertTriangle, AlertCircle, Database,
  MapPin, Check, Loader2, Sparkles, Trash2, Zap,
} from 'lucide-react';
import {
  branchGeographyUnresolved,
  diffBranchDecisions,
  isBranchRowCommittable,
  summariseBranchReview,
  withBranchReviewStatus,
  type BranchImportDecisions,
  type BranchReviewReport,
  type BranchReviewRow,
} from '@fapoms/shared';
import { Modal } from '../ui/Modal';
import { GeoPrecisionBadge } from '../GeoPrecisionBadge';
import { CoordinatePinModal } from '../geo/CoordinatePinModal';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';

/**
 * The review of a branch-import rehearsal: every row of the uploaded list, what the server made of
 * it, and the chance to fix, pin or remove rows before anything is written.
 *
 * The rows come from the rehearsal the SERVER stored (`branch-review.json` on the job); what goes
 * back on Commit is only the person's decisions — removed rows, typed-over fields, hand-placed pins
 * and the commit mode (`diffBranchDecisions`). The readiness rule is the shared one the commit job
 * applies, so the counts here are the rows the commit will write.
 */

/**
 * How many rows the table draws at once. A 5,000-row list drawn whole is 35,000 live inputs and a
 * modal that takes seconds to open and lags on every keystroke; a page of 100 is instant. Every row
 * is still held in state — an edit on page 3 is kept while the person works on page 40, and all of
 * them go with Commit.
 */
export const REVIEW_PAGE_SIZE = 100;

export type BranchReconciliationRow = BranchReviewRow;
export type BranchReconciliationReport = BranchReviewReport;

export interface BranchReconciliationModalProps {
  open: boolean;
  onClose: () => void;
  report: BranchReviewReport | null;
  title?: string;
  /**
   * Start the commit with these decisions. Resolves true once the server has accepted it (the
   * writing then happens in the background); false to keep the review open.
   */
  onCommit: (decisions: BranchImportDecisions) => Promise<boolean>;
}

export const BranchReconciliationModal: React.FC<BranchReconciliationModalProps> = ({
  open,
  onClose,
  report,
  title = 'Branch Upload Preflight & Reconciliation',
  onCommit,
}) => {
  const [rows, setRows] = useState<BranchReviewRow[]>([]);
  const [activeTab, setActiveTabState] = useState<'all' | 'needs_details' | 'ready' | 'mismatch'>('all');
  const [page, setPage] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);
  /** A new filter starts at its first page. */
  const setActiveTab = (tab: typeof activeTab) => {
    setActiveTabState(tab);
    setPage(0);
  };
  const [pinModalIndex, setPinModalIndex] = useState<number | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isBulkResolving, setIsBulkResolving] = useState(false);
  const [lookupLoadingIndex, setLookupLoadingIndex] = useState<number | null>(null);
  const [statusNotification, setStatusNotification] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);

  // Sync rows from report on open
  useEffect(() => {
    if (report?.rows) {
      setRows(report.rows.map((r) => ({ ...r })));
      const hasMismatches = report.rows.some((r) => !!r.clientMismatch);
      if (hasMismatches) {
        setActiveTabState('mismatch');
      } else {
        const hasNeedsDetails = report.rows.some((r) => r.status === 'needs_details');
        setActiveTabState(hasNeedsDetails ? 'needs_details' : 'all');
      }
      setPage(0);
    } else {
      setRows([]);
    }
    setStatusNotification(null);
  }, [report, open]);

  // Recalculate summary metrics dynamically as rows get edited or pinned
  const summary = useMemo(() => {
    const s = summariseBranchReview(rows);
    return {
      total: s.totalRows,
      existingInMaster: s.existingInMaster,
      newBranches: s.newBranches,
      needsDetailsCount: s.needsDetailsCount,
      readyCount: s.readyCount,
      coarseCount: s.coarseCount,
      clientMismatchCount: s.clientMismatchCount,
      criticalMismatchCount: rows.filter((r) => r.clientMismatch?.severity === 'critical').length,
    };
  }, [rows]);

  // Rows are keyed by their spreadsheet row number; a map keeps a 5,000-row table from searching
  // the whole list for every row it draws.
  const indexByRowNumber = useMemo(() => new Map(rows.map((r, i) => [r.rowNumber, i])), [rows]);

  // Filter rows by tab
  const filteredRows = useMemo(() => {
    switch (activeTab) {
      case 'mismatch':
        return rows.filter((r) => !!r.clientMismatch);
      case 'needs_details':
        return rows.filter((r) => r.status === 'needs_details');
      case 'ready':
        return rows.filter((r) => r.status === 'ready' || r.status === 'coarse');
      default:
        return rows;
    }
  }, [rows, activeTab]);

  // The page on show. Removing rows, or fixing the last rows of a "Needs Attention" page, can leave
  // the page past the end; it then shows the last page there is, rather than an empty table.
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / REVIEW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => filteredRows.slice(currentPage * REVIEW_PAGE_SIZE, (currentPage + 1) * REVIEW_PAGE_SIZE),
    [filteredRows, currentPage],
  );
  const goToPage = (next: number) => {
    setPage(Math.max(0, Math.min(next, pageCount - 1)));
    tableRef.current?.scrollTo?.({ top: 0 });
  };

  /** Replace one row with a changed copy, its readiness recomputed by the shared rule. */
  const updateRow = (index: number, change: (row: BranchReviewRow) => BranchReviewRow) => {
    setRows((prev) => {
      const updated = [...prev];
      updated[index] = withBranchReviewStatus(change({ ...updated[index] }));
      return updated;
    });
  };

  // Remove a single row
  const handleRemoveRow = (originalIndex: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== originalIndex));
  };

  // Remove all mismatched rows in 1 click
  const handleRemoveAllMismatches = () => {
    const count = summary.clientMismatchCount;
    setRows((prev) => prev.filter((r) => !r.clientMismatch));
    setActiveTab('all');
    setStatusNotification({ type: 'info', text: `Removed ${count} mismatched branch(es) from upload.` });
  };

  // Update a field on a row
  const handleRowChange = (index: number, field: keyof BranchReviewRow, value: any) => {
    updateRow(index, (row) => ({ ...row, [field]: value }));
  };

  // 1-Click Instant IFSC Lookup for a single row (No prompt modal!)
  const handleIfscLookup = async (index: number) => {
    const row = rows[index];
    const candidateIfsc = (row.solId || '').trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(candidateIfsc)) {
      setStatusNotification({
        type: 'error',
        text: `Row #${row.rowNumber}: SOL ID "${row.solId || ''}" is not a standard 11-digit IFSC code (e.g. SBIN0001234).`,
      });
      return;
    }

    setLookupLoadingIndex(index);
    setStatusNotification(null);
    try {
      const data = await api.get<any>(`/geo/ifsc/${encodeURIComponent(candidateIfsc)}`);
      if (data) {
        updateRow(index, (cur) => ({
          ...cur,
          state: data.state || cur.state,
          district: data.district || cur.district,
          address: data.address || cur.address,
          pincode: data.pincode || cur.pincode,
        }));
        setStatusNotification({ type: 'success', text: `Auto-filled details for IFSC ${candidateIfsc}.` });
      } else {
        setStatusNotification({ type: 'error', text: `No branch found in directory for IFSC ${candidateIfsc}.` });
      }
    } catch (err) {
      setStatusNotification({ type: 'error', text: `IFSC lookup error: ${userMessage(err)}` });
    } finally {
      setLookupLoadingIndex(null);
    }
  };

  // 1-Click Instant Pincode Lookup (No alert modal!)
  const handlePincodeLookup = async (index: number) => {
    const row = rows[index];
    const pin = row.pincode?.trim();
    if (!pin || !/^[1-9][0-9]{5}$/.test(pin)) {
      setStatusNotification({
        type: 'error',
        text: `Row #${row.rowNumber}: Please enter a valid 6-digit Indian pincode in the row first.`,
      });
      return;
    }

    setLookupLoadingIndex(index);
    setStatusNotification(null);
    try {
      const data = await api.get<any>(`/geo/pincode/${pin}`);
      if (data) {
        updateRow(index, (cur) => ({
          ...cur,
          state: cur.state || data.state,
          district: cur.district || data.district,
        }));
        setStatusNotification({ type: 'success', text: `Pincode ${pin} resolved to ${data.district || ''}, ${data.state || ''}.` });
      } else {
        setStatusNotification({ type: 'error', text: `No postal records found for pincode ${pin}.` });
      }
    } catch (err) {
      setStatusNotification({ type: 'error', text: `Pincode lookup error: ${userMessage(err)}` });
    } finally {
      setLookupLoadingIndex(null);
    }
  };

  // ⚡ Bulk Auto-Resolve All Rows with IFSC / Suggestions
  const handleBulkAutoFill = async () => {
    setIsBulkResolving(true);
    setStatusNotification(null);
    try {
      const updatedRows = [...rows];
      let filledCount = 0;

      for (let i = 0; i < updatedRows.length; i++) {
        const r = updatedRows[i];
        if (!r.solId) continue;
        const candidateIfsc = r.solId.trim().toUpperCase();

        // Check if row has missing state/district/address and has an IFSC code
        if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(candidateIfsc) && (!r.state || !r.district || !r.address)) {
          try {
            const data = await api.get<any>(`/geo/ifsc/${candidateIfsc}`);
            if (data) {
              updatedRows[i] = withBranchReviewStatus({
                ...r,
                state: data.state || r.state,
                district: data.district || r.district,
                address: data.address || r.address,
                pincode: r.pincode || data.pincode || undefined,
              });
              filledCount++;
            }
          } catch {
            // Ignore single failures and continue
          }
        }
      }
      setRows(updatedRows);
      setStatusNotification({
        type: filledCount > 0 ? 'success' : 'info',
        text: filledCount > 0
          ? `Auto-resolved details for ${filledCount} branch(es) from national IFSC registry.`
          : 'All eligible branches already have complete details.',
      });
    } finally {
      setIsBulkResolving(false);
    }
  };

  // When exact pin is confirmed from modal
  const handlePinConfirmed = (lat: number, lng: number) => {
    if (pinModalIndex === null) return;
    updateRow(pinModalIndex, (cur) => ({ ...cur, latitude: lat, longitude: lng, geoSource: 'manual', geoAccuracyMeters: 5 }));
    setPinModalIndex(null);
  };

  // Commit: the decisions go to the server, which applies them to the review it stored.
  const handleCommit = async (readyOnly = false) => {
    const mode = readyOnly ? 'ready_only' : 'all_valid';
    const committable = rows.filter((r) => isBranchRowCommittable(r, mode)).length;

    if (committable === 0) {
      setStatusNotification({
        type: 'error',
        text: summary.clientMismatchCount > 0
          ? 'All remaining branches have client/bank mismatches or missing required fields. Please review or remove them before committing.'
          : 'No valid branches available to commit. Please resolve missing details first.',
      });
      return;
    }
    if (!report) return;

    setIsCommitting(true);
    setStatusNotification(null);
    try {
      const accepted = await onCommit(diffBranchDecisions(report.rows, rows, mode));
      if (accepted) onClose();
    } catch (err) {
      setStatusNotification({ type: 'error', text: userMessage(err) });
    } finally {
      setIsCommitting(false);
    }
  };

  const activePinRow = pinModalIndex !== null ? rows[pinModalIndex] : null;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sparkles size={18} style={{ color: 'var(--accent-primary)' }} />
            <span>{title}</span>
          </div>
        }
        width="1140px"
        dismissOnBackdrop={false}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {summary.clientMismatchCount > 0 ? (
                <span style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={14} /> {summary.clientMismatchCount} client mismatch(es) will be skipped
                </span>
              ) : summary.needsDetailsCount > 0 ? (
                <span style={{ color: 'var(--danger)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <AlertCircle size={14} /> {summary.needsDetailsCount} row(s) missing required fields
                </span>
              ) : (
                <span style={{ color: 'var(--success)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <CheckCircle2 size={14} /> All {summary.total} branches verified and ready
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={isCommitting}>
                Cancel
              </button>
              {summary.needsDetailsCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleCommit(true)}
                  disabled={isCommitting || summary.readyCount === 0}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  Commit Ready Only ({summary.readyCount})
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleCommit(false)}
                disabled={isCommitting || (summary.readyCount + summary.coarseCount === 0)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                {isCommitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {summary.clientMismatchCount > 0
                  ? `Commit Valid Only (Exclude ${summary.clientMismatchCount} Mismatch${summary.clientMismatchCount > 1 ? 'es' : ''})`
                  : `Commit & Link All Valid (${summary.readyCount + summary.coarseCount})`}
              </button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Notification Banner */}
          {statusNotification && (
            <div
              style={{
                padding: '8px 12px',
                background: statusNotification.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : statusNotification.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'var(--bg-surface-2)',
                border: `1px solid ${statusNotification.type === 'error' ? 'var(--danger)' : statusNotification.type === 'success' ? 'var(--success)' : 'var(--border-color)'}`,
                borderRadius: 'var(--radius-sm)',
                color: statusNotification.type === 'error' ? 'var(--danger)' : statusNotification.type === 'success' ? 'var(--success)' : 'var(--text-primary)',
                fontSize: 'var(--text-xs)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              {statusNotification.type === 'error' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
              <span style={{ flex: 1 }}>{statusNotification.text}</span>
              <button
                type="button"
                onClick={() => setStatusNotification(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}
              >
                ✕
              </button>
            </div>
          )}

          {/* What the rehearsal set aside, and columns it could not read — facts about the FILE. */}
          {report && (report.skipped?.length > 0 || report.notes?.length > 0) && (
            <div
              data-testid="review-file-notes"
              style={{ padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'grid', gap: 4 }}
            >
              {report.skipped?.length > 0 && (
                <div>
                  <strong>{report.skipped.length} row(s) left out of this review: </strong>
                  {report.skipped.slice(0, 5).map((r) => `row ${r.row}: ${r.reason}`).join(' · ')}
                  {report.skipped.length > 5 ? ` · and ${report.skipped.length - 5} more` : ''}
                </div>
              )}
              {report.notes?.map((note) => <div key={note}>{note}</div>)}
            </div>
          )}

          {/* Streamlined KPI & Action Toolbar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              background: 'var(--bg-surface-2)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-color)',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            {/* Quick Metrics */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Upload</span>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>{summary.total}</div>
              </div>
              <div style={{ width: '1px', height: '24px', background: 'var(--border-color)' }} />
              <div>
                <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--success)', textTransform: 'uppercase' }}>In Master DB</span>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--success)' }}>{summary.existingInMaster}</div>
              </div>
              <div style={{ width: '1px', height: '24px', background: 'var(--border-color)' }} />
              <div>
                <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--accent-primary)', textTransform: 'uppercase' }}>New Branches</span>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--accent-primary)' }}>{summary.newBranches}</div>
              </div>
              <div style={{ width: '1px', height: '24px', background: 'var(--border-color)' }} />
              <div>
                <span style={{ fontSize: 'var(--text-3xs)', color: summary.needsDetailsCount > 0 ? 'var(--danger)' : 'var(--text-muted)', textTransform: 'uppercase' }}>Needs Attention</span>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: summary.needsDetailsCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{summary.needsDetailsCount}</div>
              </div>
              {summary.clientMismatchCount > 0 && (
                <>
                  <div style={{ width: '1px', height: '24px', background: 'var(--border-color)' }} />
                  <div>
                    <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--danger)', textTransform: 'uppercase' }}>Mismatches</span>
                    <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--danger)' }}>{summary.clientMismatchCount}</div>
                  </div>
                </>
              )}
            </div>

            {/* Quick Operator Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {summary.needsDetailsCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleBulkAutoFill}
                  disabled={isBulkResolving}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-xs)', padding: '5px 10px' }}
                  title="Auto-fill state, district and address for branches using their IFSC codes"
                >
                  {isBulkResolving ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} style={{ color: 'var(--warning)' }} />}
                  Auto-Resolve All from IFSC
                </button>
              )}

              {summary.clientMismatchCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleRemoveAllMismatches}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-xs)', padding: '5px 10px', color: 'var(--danger)' }}
                  title="Remove all rows that belong to a different bank or client in 1 click"
                >
                  <Trash2 size={13} />
                  Remove All Mismatched ({summary.clientMismatchCount})
                </button>
              )}
            </div>
          </div>

          {/* Streamlined Filter Tabs */}
          <div style={{ display: 'flex', gap: '6px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
            <button
              type="button"
              className={`btn ${activeTab === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
              onClick={() => setActiveTab('all')}
            >
              All Branches ({summary.total})
            </button>
            <button
              type="button"
              className={`btn ${activeTab === 'needs_details' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: 'var(--text-xs)', padding: '4px 10px', color: summary.needsDetailsCount > 0 ? 'var(--danger)' : undefined }}
              onClick={() => setActiveTab('needs_details')}
            >
              Needs Attention ({summary.needsDetailsCount})
            </button>
            <button
              type="button"
              className={`btn ${activeTab === 'ready' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
              onClick={() => setActiveTab('ready')}
            >
              Ready ({summary.readyCount + summary.coarseCount})
            </button>
            {summary.clientMismatchCount > 0 && (
              <button
                type="button"
                className={`btn ${activeTab === 'mismatch' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: 'var(--text-xs)', padding: '4px 10px', color: 'var(--danger)', fontWeight: 600 }}
                onClick={() => setActiveTab('mismatch')}
              >
                ⚠️ Mismatches ({summary.clientMismatchCount})
              </button>
            )}
          </div>

          {/* Interactive Fast Editable Table */}
          <div ref={tableRef} style={{ maxHeight: '420px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface-2)', zIndex: 10, borderBottom: '1px solid var(--border-color)' }}>
                <tr>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '45px' }}>#</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '85px' }}>Status</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '130px' }}>SOL / IFSC</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left' }}>Branch Name</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '130px' }}>State</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '120px' }}>District</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left' }}>Address</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '140px' }}>Pin / IFSC</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: '110px' }}>Geo / Map</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', width: '40px' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
                      No branches found in this view.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((row) => {
                    const originalIndex = indexByRowNumber.get(row.rowNumber) ?? -1;
                    const isMaster = row.existsInMaster;
                    // The rehearsal could not verify this new branch's state/district; typing over
                    // either clears it (the commit checks the new pair).
                    const placeProblem = branchGeographyUnresolved(row) ? row.geographyProblem!.reason : null;

                    return (
                      <tr
                        key={row.rowNumber}
                        style={{
                          borderBottom: '1px solid var(--border-color)',
                          background: row.clientMismatch
                            ? 'rgba(239, 68, 68, 0.05)'
                            : row.status === 'needs_details'
                            ? 'rgba(245, 158, 11, 0.04)'
                            : undefined,
                        }}
                      >
                        {/* Row # */}
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                          {row.rowNumber}
                        </td>

                        {/* Status */}
                        <td style={{ padding: '8px 10px' }}>
                          {row.clientMismatch ? (
                            <span
                              title={row.clientMismatch.reason}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                color: 'var(--danger)',
                                fontWeight: 600,
                                fontSize: 'var(--text-3xs)',
                                background: 'rgba(239, 68, 68, 0.1)',
                                padding: '2px 5px',
                                borderRadius: 'var(--radius-sm)',
                              }}
                            >
                              <AlertTriangle size={11} /> Mismatch
                            </span>
                          ) : row.status === 'ready' ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--success)', fontWeight: 500, fontSize: 'var(--text-3xs)' }}>
                              <CheckCircle2 size={11} /> Ready
                            </span>
                          ) : row.status === 'coarse' ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: '#3b82f6', fontWeight: 500, fontSize: 'var(--text-3xs)' }}>
                              <CheckCircle2 size={11} /> Coarse
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--danger)', fontWeight: 500, fontSize: 'var(--text-3xs)' }}>
                              <AlertCircle size={11} /> Incomplete
                            </span>
                          )}
                        </td>

                        {/* SOL ID / Code */}
                        <td style={{ padding: '8px 10px' }}>
                          <input
                            type="text"
                            value={row.solId}
                            onChange={(e) => handleRowChange(originalIndex, 'solId', e.target.value)}
                            style={{
                              width: '100%',
                              padding: '2px 4px',
                              background: 'transparent',
                              border: !row.solId ? '1px solid var(--danger)' : '1px solid transparent',
                              borderRadius: '3px',
                              fontWeight: 600,
                              fontFamily: 'monospace',
                            }}
                          />
                          {row.clientMismatch && (
                            <div
                              title={row.clientMismatch.reason}
                              style={{
                                marginTop: '2px',
                                padding: '2px 5px',
                                background: row.clientMismatch.severity === 'critical' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                border: row.clientMismatch.severity === 'critical' ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(245, 158, 11, 0.4)',
                                borderRadius: '3px',
                                fontSize: 'var(--text-3xs)',
                                color: row.clientMismatch.severity === 'critical' ? 'var(--danger)' : 'var(--warning)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                maxWidth: '100%',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              <AlertTriangle size={9} style={{ flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {row.clientMismatch.detectedBank ? `Bank: ${row.clientMismatch.detectedBank}` : 'Client Conflict'}
                              </span>
                            </div>
                          )}
                          {isMaster && !row.clientMismatch && (
                            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <Database size={9} /> Master DB
                            </div>
                          )}
                        </td>

                        {/* Name */}
                        <td style={{ padding: '8px 10px' }}>
                          <input
                            type="text"
                            value={row.name}
                            onChange={(e) => handleRowChange(originalIndex, 'name', e.target.value)}
                            style={{
                              width: '100%',
                              padding: '2px 4px',
                              background: 'transparent',
                              border: !row.name ? '1px solid var(--danger)' : '1px solid transparent',
                              borderRadius: '3px',
                            }}
                          />
                        </td>

                        {/* State */}
                        <td style={{ padding: '8px 10px' }}>
                          <input
                            type="text"
                            value={row.state || ''}
                            placeholder="Enter State"
                            aria-label={`State, row ${row.rowNumber}`}
                            aria-invalid={!row.state || !!placeProblem}
                            title={placeProblem ?? undefined}
                            onChange={(e) => handleRowChange(originalIndex, 'state', e.target.value)}
                            style={{
                              width: '100%',
                              padding: '2px 4px',
                              background: !row.state || placeProblem ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
                              border: !row.state || placeProblem ? '1px solid var(--danger)' : '1px solid var(--border-color)',
                              borderRadius: '3px',
                              fontSize: 'var(--text-xs)',
                            }}
                          />
                          {placeProblem && (
                            <div
                              data-testid={`place-problem-${row.rowNumber}`}
                              title={placeProblem}
                              style={{ marginTop: '2px', fontSize: 'var(--text-3xs)', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '3px' }}
                            >
                              <AlertCircle size={9} style={{ flexShrink: 0 }} /> Place not verified — correct the state or district
                            </div>
                          )}
                        </td>

                        {/* District */}
                        <td style={{ padding: '8px 10px' }}>
                          <input
                            type="text"
                            value={row.district || ''}
                            placeholder="District"
                            aria-label={`District, row ${row.rowNumber}`}
                            aria-invalid={!!placeProblem}
                            title={placeProblem ?? undefined}
                            onChange={(e) => handleRowChange(originalIndex, 'district', e.target.value)}
                            style={{
                              width: '100%',
                              padding: '2px 4px',
                              background: 'transparent',
                              border: placeProblem ? '1px solid var(--danger)' : '1px solid var(--border-color)',
                              borderRadius: '3px',
                              fontSize: 'var(--text-xs)',
                            }}
                          />
                        </td>

                        {/* Address */}
                        <td style={{ padding: '8px 10px' }}>
                          <input
                            type="text"
                            value={row.address || ''}
                            placeholder="Address"
                            onChange={(e) => handleRowChange(originalIndex, 'address', e.target.value)}
                            style={{
                              width: '100%',
                              padding: '2px 4px',
                              background: 'transparent',
                              border: '1px solid var(--border-color)',
                              borderRadius: '3px',
                              fontSize: 'var(--text-xs)',
                            }}
                          />
                        </td>

                        {/* Pincode & Quick Lookups */}
                        <td style={{ padding: '8px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input
                              type="text"
                              value={row.pincode || ''}
                              placeholder="PIN"
                              onChange={(e) => handleRowChange(originalIndex, 'pincode', e.target.value)}
                              style={{
                                width: '58px',
                                padding: '2px 4px',
                                background: 'transparent',
                                border: '1px solid var(--border-color)',
                                borderRadius: '3px',
                                fontSize: 'var(--text-xs)',
                                fontFamily: 'monospace',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handlePincodeLookup(originalIndex)}
                              title="Resolve state/district from pincode"
                              disabled={lookupLoadingIndex === originalIndex}
                              className="btn btn-secondary"
                              style={{
                                padding: '2px 5px',
                                fontSize: 'var(--text-2xs)',
                                borderRadius: '3px',
                              }}
                            >
                              PIN
                            </button>
                            <button
                              type="button"
                              onClick={() => handleIfscLookup(originalIndex)}
                              title="Auto-fill bank branch details from IFSC code"
                              disabled={lookupLoadingIndex === originalIndex}
                              className="btn btn-secondary"
                              style={{
                                padding: '2px 5px',
                                fontSize: 'var(--text-2xs)',
                                borderRadius: '3px',
                              }}
                            >
                              IFSC
                            </button>
                          </div>
                        </td>

                        {/* Precision badge and Pin button */}
                        <td style={{ padding: '8px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <GeoPrecisionBadge
                              source={(row.geoSource as any) || 'none'}
                              accuracyMeters={row.geoAccuracyMeters ?? 100000}
                            />
                            <button
                              type="button"
                              onClick={() => setPinModalIndex(originalIndex)}
                              title="Pin exact location on map"
                              className="btn btn-secondary"
                              style={{ padding: '2px 6px', fontSize: 'var(--text-2xs)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                            >
                              <MapPin size={11} style={{ color: 'var(--accent-primary)' }} />
                              Pin
                            </button>
                          </div>
                        </td>

                        {/* Remove row button */}
                        <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                          <button
                            type="button"
                            onClick={() => handleRemoveRow(originalIndex)}
                            title="Remove branch from import list"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              color: 'var(--text-muted)',
                              padding: '3px',
                              borderRadius: '3px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--danger)')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {filteredRows.length > REVIEW_PAGE_SIZE && (
            <nav
              aria-label="Review pages"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
            >
              <span data-testid="review-page-range" aria-live="polite">
                Rows {(currentPage * REVIEW_PAGE_SIZE + 1).toLocaleString('en-IN')}–
                {Math.min((currentPage + 1) * REVIEW_PAGE_SIZE, filteredRows.length).toLocaleString('en-IN')} of{' '}
                {filteredRows.length.toLocaleString('en-IN')} · page {currentPage + 1} of {pageCount}
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button type="button" className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
                  onClick={() => goToPage(0)} disabled={currentPage === 0} aria-label="First page">
                  First
                </button>
                <button type="button" className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
                  onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 0} aria-label="Previous page">
                  Previous
                </button>
                <button type="button" className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
                  onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount - 1} aria-label="Next page">
                  Next
                </button>
                <button type="button" className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
                  onClick={() => goToPage(pageCount - 1)} disabled={currentPage >= pageCount - 1} aria-label="Last page">
                  Last
                </button>
              </div>
            </nav>
          )}
        </div>
      </Modal>

      {/* Coordinate Pin Modal for interactive pin placement */}
      {activePinRow && (
        <CoordinatePinModal
          open={pinModalIndex !== null}
          onClose={() => setPinModalIndex(null)}
          target={activePinRow.masterBranchId ? 'branch' : undefined}
          id={activePinRow.masterBranchId}
          initialLat={activePinRow.latitude}
          initialLng={activePinRow.longitude}
          initialAccuracy={activePinRow.geoAccuracyMeters}
          title={`Pin Location: ${activePinRow.name} (${activePinRow.solId})`}
          subtitle={`State: ${activePinRow.state || 'Unknown'} | District: ${activePinRow.district || 'Unknown'} | Address: ${activePinRow.address || 'None'}`}
          onConfirmed={handlePinConfirmed}
        />
      )}
    </>
  );
};
