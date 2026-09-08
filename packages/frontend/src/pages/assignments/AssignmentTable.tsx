import React from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  Hourglass,
  Flame,
} from 'lucide-react';
import { StatusBadge, EmptyState } from '../../components/ui';
import { assignmentFee } from '../../utils/money';
import {
  computeAssignmentAttention,
  PAGE_SIZE,
} from './useAssignmentQueue';
import type { Assignment } from './types';

export interface AssignmentTableProps {
  assignments: Assignment[];
  filteredAssignments: Assignment[];
  selectedAsnId: string | null;
  onSelectAssignment: (id: string) => void;
  statusFilter: string;
  searchTerm: string;
  isLoading: boolean;
  page: number;
  total: number;
  totalPages: number;
  setPage: (next: number | ((current: number) => number)) => void;
  dateSort: 'asc' | 'desc';
  setDateSort: (setter: (current: 'asc' | 'desc') => 'asc' | 'desc') => void;
  quickBusyId: string | null;
  onQuickAction: (asnId: string, targetStatus: 'ACCEPTED' | 'COMPLETED', attended?: boolean) => void;
  isAttentionView: boolean;
  openIssueAssignmentIds: Set<string>;
  todayStr: string;
  isError?: boolean;
  error?: unknown;
  onResetFilters?: () => void;
  onRetry?: () => void;
}

export const AssignmentTable: React.FC<AssignmentTableProps> = ({
  assignments = [],
  filteredAssignments = assignments,
  selectedAsnId,
  onSelectAssignment,
  statusFilter,
  searchTerm,
  isLoading,
  page,
  total,
  totalPages,
  setPage,
  dateSort,
  setDateSort,
  quickBusyId,
  onQuickAction,
  isAttentionView,
  openIssueAssignmentIds = new Set<string>(),
  todayStr = new Date().toISOString().split('T')[0],
  isError,
  error,
  onResetFilters,
  onRetry,
}) => {
  const pageStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, total);

  const formatRelativeTime = (ts: string): string => {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  return (
    <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          Loading assignments queue...
        </div>
      ) : isError ? (
        (error as any)?.statusCode === 403 ? (
          <EmptyState
            meaning="FORBIDDEN"
            title="Assignment queue access restricted"
            message="You do not have the required operational permissions to view this assignment queue or scope."
          />
        ) : (
          <EmptyState
            meaning="UNAVAILABLE"
            title="Could not load assignments queue"
            message="An error occurred while fetching assignments from the server. Please retry."
            onRetry={onRetry}
          />
        )
      ) : filteredAssignments.length === 0 ? (
        assignments.length === 0 && statusFilter === 'ALL' && !searchTerm ? (
          <EmptyState
            meaning="NO_DATA"
            icon={<ClipboardList size={28} />}
            title="Nobody has been given a branch to audit yet"
            message={
              <span>
                A branch appears here once an assayer has been chosen for it. Choose one in{' '}
                <Link to="/planning" style={{ color: 'var(--accent-primary)' }}>
                  Planning
                </Link>{' '}
                and it will show up on this tab.
              </span>
            }
          />
        ) : (
          <EmptyState
            meaning="NO_RESULTS"
            title="No matching assignments"
            message="Nothing matches what you have selected. Clear filters or search to see everything."
            onClearFilters={onResetFilters}
          />
        )
      ) : (
        <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border-color)',
                color: 'var(--text-muted)',
                fontSize: '11.5px',
                textTransform: 'uppercase',
              }}
            >
              <th scope="col" style={{ padding: '10px 14px' }}>Branch / Assignment</th>
              <th scope="col" style={{ padding: '10px 14px' }}>Assayer</th>
              <th
                scope="col"
                aria-sort={dateSort === 'asc' ? 'ascending' : 'descending'}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
                onClick={() => setDateSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
                title="Sort by scheduled date"
              >
                Scheduled {dateSort === 'asc' ? '▲' : '▼'}
              </th>
              <th scope="col" style={{ padding: '10px 14px' }}>Fee</th>
              <th scope="col" style={{ padding: '10px 14px' }}>Branch Workflow</th>
              <th scope="col" style={{ padding: '10px 14px' }}>Assignment State</th>
              <th scope="col" style={{ padding: '10px 14px' }}>Attention</th>
              <th scope="col" style={{ padding: '10px 14px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAssignments.map((asn) => {
              const rowBusy = quickBusyId === asn.id;
              const canAccept = asn.status === 'PENDING';
              const canComplete = asn.status === 'CHECKED_IN' || asn.status === 'IN_PROGRESS';
              const overdue =
                asn.scheduledDate &&
                new Date(asn.scheduledDate).getTime() < Date.now() - 86_400_000 &&
                !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(asn.status);

              const hasOpenIssue = openIssueAssignmentIds.has(asn.id);
              const attention = computeAssignmentAttention(asn, todayStr, hasOpenIssue);

              return (
                <tr
                  key={asn.id}
                  onClick={() => onSelectAssignment(asn.id)}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    fontSize: '13px',
                    cursor: 'pointer',
                    background: selectedAsnId === asn.id ? 'var(--bg-surface-2)' : 'transparent',
                    borderLeft: selectedAsnId === asn.id ? '4px solid var(--accent)' : '4px solid transparent',
                  }}
                >
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 700 }}>
                      {asn.projectBranch?.branch?.name || asn.assignmentNumber}
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      {asn.assignmentNumber} · {asn.project?.name}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {asn.assayerId ? (
                      <Link
                        to={`/hr/roster/${encodeURIComponent(asn.assayerId)}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          color: 'var(--text-primary)',
                          textDecoration: 'none',
                          fontWeight: 600,
                        }}
                        title="View Assayer 360 profile"
                      >
                        {asn.assayer?.displayName || '—'}
                      </Link>
                    ) : (
                      asn.assayer?.displayName || '—'
                    )}
                    {asn.checkedInAt && (
                      <span
                        title={`Checked in ${new Date(asn.checkedInAt).toLocaleString('en-IN')}`}
                        style={{ marginLeft: '5px', color: 'var(--success)', fontWeight: 700 }}
                      >
                        📍
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      whiteSpace: 'nowrap',
                      color: overdue ? 'var(--danger)' : undefined,
                      fontWeight: overdue ? 700 : undefined,
                    }}
                    title={overdue ? 'Scheduled date has passed without completion' : undefined}
                  >
                    {asn.scheduledDate
                      ? new Date(asn.scheduledDate).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                        })
                      : '—'}
                    {overdue && ' ⚠'}
                  </td>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {assignmentFee(asn)}
                  </td>

                  {/* 1. Branch Workflow Status */}
                  <td style={{ padding: '10px 14px' }}>
                    <StatusBadge
                      domain="branch"
                      status={asn.projectBranch?.status || 'SCHEDULED'}
                      size="sm"
                    />
                  </td>

                  {/* 2. Assignment Execution Status */}
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                      <StatusBadge
                        domain="assignment"
                        status={asn.status}
                        size="sm"
                      />
                      {asn.status === 'REJECTED' && asn.rejectReason === 'AUTO_DECLINED_SLA_EXPIRED' && (
                        <StatusBadge
                          label="Auto-declined"
                          category="pending"
                          icon={<Hourglass size={11} />}
                          variant="tag"
                          size="sm"
                        />
                      )}
                      {(asn.priority === 'CRITICAL' || asn.priority === 'HIGH') && (
                        <StatusBadge
                          label={asn.priority === 'CRITICAL' ? 'Escalated' : 'Urgent'}
                          category={asn.priority === 'CRITICAL' ? 'danger' : 'pending'}
                          icon={<Flame size={11} />}
                          variant="tag"
                          size="sm"
                        />
                      )}
                    </div>
                  </td>

                  {/* 3. Derived Operational Attention State */}
                  <td style={{ padding: '10px 14px' }}>
                    <StatusBadge
                      domain="attention"
                      status={attention}
                      variant="tag"
                      size="sm"
                    />
                  </td>

                  {/* Inline Actions */}
                  <td
                    style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isAttentionView ? (
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        Waiting since {formatRelativeTime(asn.createdAt)}
                      </span>
                    ) : (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {canAccept && (
                          <button
                            onClick={() => onQuickAction(asn.id, 'ACCEPTED')}
                            disabled={rowBusy}
                            className="btn btn-primary"
                            style={{
                              padding: '3px 9px',
                              minHeight: '32px',
                              fontSize: '11px',
                              background: 'var(--success)',
                              borderColor: 'var(--success)',
                            }}
                          >
                            {rowBusy ? '…' : 'Accept'}
                          </button>
                        )}
                        {canComplete && (
                          <button
                            onClick={() => onQuickAction(asn.id, 'COMPLETED', !!asn.checkedInAt)}
                            disabled={rowBusy}
                            className="btn btn-primary"
                            style={{ padding: '3px 9px', minHeight: '32px', fontSize: '11px' }}
                          >
                            {rowBusy ? '…' : 'Complete'}
                          </button>
                        )}
                        {!canAccept && !canComplete && (
                          <button
                            onClick={() => onSelectAssignment(asn.id)}
                            className="btn btn-secondary"
                            style={{ padding: '3px 9px', minHeight: '32px', fontSize: '11px' }}
                          >
                            Open
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      {!isLoading && total > 0 && (
        <nav
          aria-label="Assignments pagination"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 24px',
            borderTop: '1px solid var(--border-color)',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Showing {pageStart}–{pageEnd} of {total}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
              className="btn btn-secondary"
              style={{
                padding: '5px 8px',
                opacity: page <= 1 ? 0.4 : 1,
                cursor: page <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', padding: '0 6px' }}>
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="Next page"
              className="btn btn-secondary"
              style={{
                padding: '5px 8px',
                opacity: page >= totalPages ? 0.4 : 1,
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
              }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
};
