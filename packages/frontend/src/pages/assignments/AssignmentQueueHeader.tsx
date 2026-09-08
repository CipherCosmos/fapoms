import React from 'react';
import {
  ClipboardList,
  RefreshCw,
  FileSpreadsheet,
  AlertTriangle,
  XCircle,
  Flame,
  CheckCircle,
} from 'lucide-react';
import { PageHeader, AlertBanner, SearchInput } from '../../components/ui';
import { branchStatusLabel } from '../../utils/statusLabels';
import {
  STAGE3_STATUSES,
  ACTIVE_STATUSES,
  ESCALATED_FILTER,
  TERMINAL_FILTER,
} from './useAssignmentQueue';
import type { FieldIssue } from './types';

export interface AssignmentQueueHeaderProps {
  totalCount: number;
  activeCount: number;
  pendingCount: number;
  rejectedCount: number;
  escalatedCount: number;
  closedCount: number;
  cancelledCount: number;
  branchStatusCounts: Record<string, number>;
  statusFilter: string;
  applyFilter: (filter: string) => void;
  showStageDrilldown: boolean;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  currentViewLabel: string;
  exporting: boolean;
  handleExport: () => void;
  onRefresh: () => void;
  isError: boolean;
  refetchList: () => void;
  groupedIssues: Array<{ latest: FieldIssue; count: number }>;
  handledIssues: FieldIssue[];
  openIssues: FieldIssue[];
  showHandledIssues: boolean;
  setShowHandledIssues: (setter: (v: boolean) => boolean) => void;
  onSelectAssignment: (id: string) => void;
}

export const AssignmentQueueHeader: React.FC<AssignmentQueueHeaderProps> = ({
  totalCount,
  activeCount,
  pendingCount,
  rejectedCount,
  escalatedCount,
  closedCount,
  cancelledCount,
  branchStatusCounts,
  statusFilter,
  applyFilter,
  showStageDrilldown,
  searchTerm,
  setSearchTerm,
  currentViewLabel,
  exporting,
  handleExport,
  onRefresh,
  isError,
  refetchList,
  groupedIssues,
  handledIssues,
  openIssues,
  showHandledIssues,
  setShowHandledIssues,
  onSelectAssignment,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <PageHeader
        icon={<ClipboardList size={20} />}
        title="Field Execution Workspace"
        subtitle="Track and manage live field audits from acceptance through check-in, submission, and closure."
        actions={
          <>
            <button
              onClick={onRefresh}
              className="btn btn-secondary"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              <RefreshCw size={16} /> Refresh
            </button>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="btn btn-secondary"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--success)',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              <FileSpreadsheet size={16} /> {exporting ? 'Preparing…' : 'Export'}
            </button>
          </>
        }
      />

      {isError && (
        <AlertBanner type="error">
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            Could not load assignments. Check your connection and try again.
            <button
              onClick={refetchList}
              className="btn btn-secondary"
              style={{ padding: '3px 10px', fontSize: '11px' }}
            >
              Retry
            </button>
          </span>
        </AlertBanner>
      )}

      {/* Triage count chips bar */}
      <div
        className="glass-card"
        style={{
          padding: '8px 12px',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {[
          { label: 'All', value: totalCount, icon: ClipboardList, color: 'var(--accent)', filter: 'ALL' },
          { label: 'Active', value: activeCount, icon: RefreshCw, color: 'var(--status-active-fg)', filter: ACTIVE_STATUSES },
          { label: 'Awaiting response', value: pendingCount, icon: AlertTriangle, color: 'var(--warning)', filter: 'PENDING' },
          { label: 'Declined — replace', value: rejectedCount, icon: XCircle, color: 'var(--danger)', filter: 'REJECTED' },
          { label: 'Escalated', value: escalatedCount, icon: Flame, color: 'var(--danger)', filter: ESCALATED_FILTER },
          { label: 'Closed', value: closedCount, icon: CheckCircle, color: 'var(--success)', filter: 'CLOSED' },
          { label: 'Cancelled / Rejected', value: cancelledCount, icon: XCircle, color: 'var(--danger)', filter: TERMINAL_FILTER },
        ].map((chip) => {
          const Icon = chip.icon;
          const isActive = statusFilter === chip.filter;
          return (
            <button
              key={chip.label}
              onClick={() => applyFilter(chip.filter)}
              className="btn btn-secondary"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 700,
                borderRadius: 'var(--radius-full)',
                minHeight: '36px',
                border: isActive ? `1.5px solid ${chip.color}` : '1px solid var(--border-color)',
                background: isActive ? 'var(--bg-surface-2)' : 'transparent',
                color: isActive ? chip.color : 'var(--text-secondary)',
              }}
            >
              <Icon size={13} style={{ color: chip.color }} />
              {chip.label}
              <span
                style={{
                  fontWeight: 800,
                  color: isActive ? chip.color : 'var(--text-primary)',
                }}
              >
                {chip.value}
              </span>
            </button>
          );
        })}
      </div>

      {/* Stage drill-down */}
      {showStageDrilldown && (
        <div
          className="glass-card"
          style={{
            padding: '6px 12px',
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: '10.5px',
              color: 'var(--text-muted)',
              fontWeight: 700,
              letterSpacing: '0.3px',
            }}
          >
            NARROW TO ONE STAGE
          </span>
          {STAGE3_STATUSES.map((s) => {
            const isActive = statusFilter === s;
            return (
              <button
                key={s}
                onClick={() => applyFilter(isActive ? ACTIVE_STATUSES : s)}
                className="btn btn-secondary"
                style={{
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: 700,
                  borderRadius: 'var(--radius-full)',
                  border: isActive ? '1.5px solid var(--accent)' : '1px solid var(--border-color)',
                  background: isActive ? 'var(--bg-surface-2)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {branchStatusLabel(s)}{' '}
                <span style={{ fontWeight: 800 }}>{branchStatusCounts[s] ?? 0}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Field issues drawer */}
      {(groupedIssues.length > 0 || handledIssues.length > 0) && (
        <details
          className="glass-card"
          style={{
            border: '1px solid var(--status-pending-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
          open={groupedIssues.length <= 3}
        >
          <summary
            style={{
              padding: '10px 16px',
              cursor: 'pointer',
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
              fontWeight: 700,
              color: 'var(--warning)',
            }}
          >
            <AlertTriangle size={15} />
            {groupedIssues.length > 0 ? (
              <>
                {groupedIssues.length} branch{groupedIssues.length > 1 ? 'es' : ''} with field
                issues
              </>
            ) : (
              <>No open field issues</>
            )}
            {openIssues.length > groupedIssues.length && !showHandledIssues && (
              <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                ({openIssues.length} reports)
              </span>
            )}
            {handledIssues.length > 0 && (
              <span
                role="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowHandledIssues((v) => !v);
                }}
                style={{
                  marginLeft: 'auto',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--accent)',
                }}
              >
                {showHandledIssues ? 'Open only' : `Include ${handledIssues.length} settled`}
              </span>
            )}
          </summary>
          <div
            style={{
              maxHeight: '220px',
              overflowY: 'auto',
              borderTop: '1px solid var(--border-color)',
            }}
          >
            {groupedIssues.map(({ latest: issue, count }) => (
              <div
                key={issue.assignmentId}
                onClick={() => onSelectAssignment(issue.assignmentId)}
                style={{
                  padding: '9px 16px',
                  borderBottom: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  opacity: issue.open ? 1 : 0.55,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                  }}
                >
                  <span
                    style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)' }}
                  >
                    {issue.categoryLabel || issue.category || 'Issue'} ·{' '}
                    {issue.branchName || issue.assignmentNumber || issue.assignmentId.slice(0, 8)}
                    {count > 1 && (
                      <span
                        title={`${count} reports on this assignment — showing the newest`}
                        style={{
                          marginLeft: '6px',
                          fontSize: '10px',
                          fontWeight: 800,
                          padding: '1px 7px',
                          borderRadius: '8px',
                          background: 'var(--status-pending-bg)',
                          color: 'var(--warning)',
                        }}
                      >
                        ×{count}
                      </span>
                    )}
                  </span>
                  <span
                    style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
                  >
                    {issue.assayerName || 'Assayer'} ·{' '}
                    {new Date(issue.reportedAt).toLocaleString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {issue.note && (
                  <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                    {issue.note}
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Search & Status view context */}
      <div
        className="glass-card"
        style={{
          padding: '12px 16px',
          display: 'flex',
          gap: '12px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <SearchInput
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder="Search this page by ID, project, assayer, branch..."
          iconSize={16}
        />
        <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
          Showing: <strong style={{ color: 'var(--text-secondary)' }}>{currentViewLabel}</strong>
        </span>
      </div>
    </div>
  );
};
