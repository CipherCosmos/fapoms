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
import { useCurrentRoles, useCurrentPermissions } from '../../hooks/useCurrentRoles';
import { canAccessRoute } from '../../config/route-permissions';
import { assignmentFee } from '../../utils/money';
import { classifyError, translateError, userMessage } from '../../services/errors';
import {
  computeAssignmentAttention,
  PAGE_SIZE,
} from './useAssignmentQueue';
import { readAttendance, attendanceSummary } from './attendance';
import type { Assignment } from './types';
import { businessTodayDateKey } from '@fapoms/shared';

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
  onQuickAction: (asnId: string, targetStatus: 'ACCEPTED' | 'COMPLETED', attended?: boolean, departed?: boolean) => void;
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
  todayStr = businessTodayDateKey(),
  isError,
  error,
  onResetFilters,
  onRetry,
}) => {
  const pageStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, total);

  /**
   * Whether this reader can actually open Planning, asked of the same function the router uses.
   *
   * Only the empty state below reads it, but it is computed here because hooks cannot be called
   * conditionally, and the answer must not be duplicated as a role list — a second copy of "who
   * may plan" is a second thing to keep in step with route-permissions.ts.
   */
  const roles = useCurrentRoles();
  const permissions = useCurrentPermissions();
  const canPlan = canAccessRoute(roles, permissions, '/planning');

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
        /*
         * `(error as any)?.statusCode === 403` never matched anything.
         *
         * `api.request` throws an `AppError`, and an AppError's field is `status` — `statusCode`
         * exists only on the `ErrorTranslation` object `translateError` builds, which is not what
         * lands here. So the FORBIDDEN branch below was unreachable, and every refusal fell
         * through to "An error occurred while fetching assignments from the server. Please
         * retry." with a Retry button whose only possible outcome was the same 403 again. The
         * queue is region-scoped, so that is not a rare path.
         *
         * Asked of `classifyError` now, which is the one place that decides what a status means
         * and whether retrying it can change the answer — the same function LoadFailure consults,
         * so a refusal reads the same here as it does everywhere else in the app.
         */
        classifyError(error).category === 'permission-required' ? (
          <EmptyState
            meaning="FORBIDDEN"
            title="Assignment queue access restricted"
            message={userMessage(error)}
          />
        ) : (
          <EmptyState
            meaning="UNAVAILABLE"
            title="Could not load assignments queue"
            message={userMessage(error)}
            /*
             * Only where pressing it could produce a different answer: a dropped connection, a
             * timeout, a 5xx. Never on a record that does not exist.
             *
             * `translateError().retryable`, not `classifyError().isRetryable` — see the note in
             * components/LoadFailure.tsx. The latter answers `category === 'retryable'`, a
             * category `fromResponse` never assigns, so it calls every server outage
             * non-retryable and would have removed the button from the one case it helps with.
             */
            onRetry={translateError(error).retryable ? onRetry : undefined}
          />
        )
      ) : filteredAssignments.length === 0 ? (
        assignments.length === 0 && statusFilter === 'ALL' && !searchTerm ? (
          <EmptyState
            meaning="NO_DATA"
            icon={<ClipboardList size={28} />}
            title="Nobody has been given a branch to audit yet"
            /*
             * Two messages, because the useful next step is not the same for everyone.
             *
             * This said "Choose one in Planning" with a link, to every reader. Planning is
             * restricted to ADMIN and OPERATIONS holding PLANNING:VIEW:ORGANIZATION, so for a
             * desk operator, an auditor or a validator that was an instruction they could not
             * carry out attached to a link that would bounce them straight back out — the empty
             * state told them the queue was empty and then wasted the one action it offered.
             *
             * `canAccessRoute` is the same function ProtectedRoute consults, so this cannot drift
             * from what the router will actually allow: change who may plan and this follows.
             */
            message={
              canPlan ? (
                <span>
                  A branch appears here once an assayer has been chosen for it. Choose one in{' '}
                  <Link to="/planning" style={{ color: 'var(--accent-primary)' }}>
                    Planning
                  </Link>{' '}
                  and it will show up on this tab.
                </span>
              ) : (
                <span>
                  A branch appears here once someone in Planning has chosen an assayer for it.
                  Nothing is waiting on you.
                </span>
              )
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
                fontSize: 'var(--text-2xs)',
                textTransform: 'uppercase',
              }}
            >
              <th scope="col" title="Branch and assignment this row is about" style={{ padding: '10px 14px' }}>Branch / Assignment</th>
              <th scope="col" title="Assayer assigned to this audit" style={{ padding: '10px 14px' }}>Assayer</th>
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
              <th scope="col" title="Agreed audit fee for this assignment" style={{ padding: '10px 14px' }}>Fee</th>
              <th scope="col" title="Current status and progress of this assignment" style={{ padding: '10px 14px' }}>Status & Progress</th>
              <th scope="col" title="Quick actions you can take on this assignment" style={{ padding: '10px 14px' }}>Actions</th>
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
                    fontSize: 'var(--text-sm)',
                    cursor: 'pointer',
                    background: selectedAsnId === asn.id ? 'var(--bg-surface-2)' : 'transparent',
                    borderLeft: selectedAsnId === asn.id ? '4px solid var(--accent)' : '4px solid transparent',
                  }}
                >
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 700 }}>
                      {asn.projectBranch?.branch?.name || asn.assignmentNumber}
                      {asn.projectBranch?.branch?.city && (
                        <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}> · {asn.projectBranch.branch.city}</span>
                      )}
                    </div>
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
                      {asn.assignmentNumber} · {asn.project?.name}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
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
                      {/* Attendance checkin marker */}
                      {asn.checkedInAt && (() => {
                        const read = readAttendance(asn);
                        const missingDeparture = read.gap === 'NO_DEPARTURE';
                        return (
                          <span
                            title={attendanceSummary(read)}
                            style={{
                              marginLeft: '5px',
                              color: missingDeparture ? 'var(--warning)' : 'var(--success)',
                              fontWeight: 700,
                            }}
                          >
                            📍
                            {read.durationLabel && (
                              <span style={{ marginLeft: '3px', fontSize: 'var(--text-3xs)', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                {read.durationLabel}
                              </span>
                            )}
                            {missingDeparture && (
                              <span style={{ marginLeft: '3px', fontSize: 'var(--text-3xs)', fontWeight: 700 }}>
                                no check-out
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </div>
                    {asn.assayer?.phone && (
                      <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
                        <a href={`tel:${asn.assayer.phone}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
                          {asn.assayer.phone}
                        </a>
                      </div>
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

                  {/* Status & Progress (synthesized from assignment status, operational attention, and branch workflow) */}
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <StatusBadge
                          domain="assignment"
                          status={asn.status}
                          size="sm"
                        />
                        {attention && attention !== 'NORMAL' && (
                          <StatusBadge
                            domain="attention"
                            status={attention}
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
                        {asn.status === 'REJECTED' && asn.rejectReason === 'AUTO_DECLINED_SLA_EXPIRED' && (
                          <StatusBadge
                            label="Auto-declined"
                            category="pending"
                            icon={<Hourglass size={11} />}
                            variant="tag"
                            size="sm"
                          />
                        )}
                      </div>
                      {asn.projectBranch?.status && asn.projectBranch.status !== 'SCHEDULED' && (
                        <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>
                          Branch: {asn.projectBranch.status.replace(/_/g, ' ')}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Inline Actions */}
                  <td
                    style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isAttentionView ? (
                      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                        Waiting since {formatRelativeTime(asn.createdAt)}
                      </span>
                    ) : (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {canAccept && (
                          <button
                            onClick={() => onQuickAction(asn.id, 'ACCEPTED')}
                            disabled={rowBusy}
                            title={`Accept ${asn.assignmentNumber} on behalf of the assayer`}
                            className="btn btn-primary"
                            style={{
                              padding: '3px 9px',
                              minHeight: '32px',
                              fontSize: 'var(--text-2xs)',
                              background: 'var(--success)',
                              borderColor: 'var(--success)',
                            }}
                          >
                            {rowBusy ? '…' : 'Accept'}
                          </button>
                        )}
                        {canComplete && (
                          <button
                            onClick={() => onQuickAction(asn.id, 'COMPLETED', !!asn.checkedInAt, !!asn.checkedOutAt)}
                            disabled={rowBusy}
                            title={`Mark ${asn.assignmentNumber} as complete`}
                            className="btn btn-primary"
                            style={{ padding: '3px 9px', minHeight: '32px', fontSize: 'var(--text-2xs)' }}
                          >
                            {rowBusy ? '…' : 'Complete'}
                          </button>
                        )}
                        {!canAccept && !canComplete && (
                          <button
                            onClick={() => onSelectAssignment(asn.id)}
                            title={`Open details for ${asn.assignmentNumber}`}
                            className="btn btn-secondary"
                            style={{ padding: '3px 9px', minHeight: '32px', fontSize: 'var(--text-2xs)' }}
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
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
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
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', padding: '0 6px' }}>
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
