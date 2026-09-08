import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ProjectBranchStatus, SystemRole } from '@fapoms/shared';
import { useUrlSelection } from '../../hooks/useUrlSelection';
import { useCurrentRoles, hasAnyRole } from '../../hooks/useCurrentRoles';
import { useScope, withScope } from '../../context/ScopeContext';
import { useQueuedExcelExport } from '../../hooks/useQueuedExcelExport';
import { useConfirm } from '../../components/ui';
import { api } from '../../services/api';
import { queryClient } from '../../queryClient';
import { queryKeys } from '../../hooks/queryKeys';
import { userMessage } from '../../services/errors';
import { branchStatusLabel } from '../../utils/statusLabels';
import type { OperationalAttentionState } from '../../config/status-registry';
import type { Assignment, FieldIssue } from './types';

export const STAGE3_STATUSES = [
  ProjectBranchStatus.SCHEDULED,
  ProjectBranchStatus.AUDIT_COMPLETED,
  ProjectBranchStatus.VALIDATION_COMPLETED,
  ProjectBranchStatus.CLOSED,
  ProjectBranchStatus.CANCELLED,
];

export const ACTIVE_STATUSES = 'SCHEDULED,AUDIT_COMPLETED,VALIDATION_COMPLETED';
export const NEEDS_ATTENTION_FILTER = 'PENDING,REJECTED';
export const ESCALATED_FILTER = 'CRITICAL';
export const TERMINAL_FILTER = 'REJECTED,CANCELLED';
export const PAGE_SIZE = 25;

export const COMPLETE_CONFIRM = {
  title: 'Mark this assignment complete?',
  message: 'This closes out the field work and moves the audit to the next stage.',
  confirmLabel: 'Mark complete',
  reversible: false,
} as const;

export const COMPLETE_WITHOUT_CHECK_IN_CONFIRM = {
  title: 'Complete without a check-in?',
  message:
    'Nobody checked in on site for this one. Completing it still books the assayer’s payout and '
    + 'the client’s billing line, so this will be recorded against your name with the reason below.',
  confirmLabel: 'Complete and record the reason',
  reversible: false,
  tone: 'danger' as const,
  reasonPrompt: {
    label: 'Why is this being closed without a check-in?',
    placeholder: 'e.g. Attended, but no signal at the branch to check in',
  },
} as const;

/**
 * Deterministic Operational Attention Precedence Hierarchy:
 *
 * When multiple operational conditions overlap on an assignment, they are evaluated in the
 * strict, intentional order below:
 *
 * 1. BLOCKED (Tier 1 - Highest Urgency):
 *    - An active, open field issue thread exists (`hasOpenIssue === true`) or an explicit hold is in effect.
 *    - Note: High/Critical priority is an axis of severity/urgency, NOT an operational blocker.
 *      Priority is represented independently via dedicated badges and triage filters.
 *
 * 2. AWAITING_VALIDATION (Tier 2 - Field Complete / Desk QA Queue):
 *    - Assignment is COMPLETED and the branch workflow status is AUDIT_COMPLETED.
 *    - Field work has closed; the packet is now waiting for QA review and data entry.
 *
 * 3. CHECKIN_MISSING (Tier 3 - Active Audit Integrity Risk):
 *    - Assignment is currently IN_PROGRESS without an attested GPS check-in timestamp (`checkedInAt`).
 *    - Operations must intervene to verify on-site physical attendance.
 *
 * 4. OVERDUE (Tier 4 - Breached Schedule Date):
 *    - The scheduled visit date has passed (`visitDate < todayStr`) on a non-terminal assignment.
 *    - Takes precedence over PENDING/NEEDS_RESPONSE because a breached calendar date represents
 *      a confirmed SLA failure that requires immediate reschedule or investigation.
 *
 * 5. NEEDS_RESPONSE (Tier 5 - Unacknowledged Offer):
 *    - Assignment is PENDING response from the assayer (for today or future dates).
 *
 * 6. IN_PROGRESS (Tier 6 - Active Field Audit):
 *    - Assignment is CHECKED_IN or IN_PROGRESS with verified attendance.
 *
 * 7. NORMAL (Tier 7 - Routine / On Track):
 *    - Accepted visits scheduled for future dates, or terminal closed/cancelled records without issues.
 *
 * Transient Mutation Conflicts:
 * - 409 Optimistic Concurrency conflicts are transient mutation failures handled by ConflictModal;
 *   they are NEVER modeled as persistent queue state.
 */
export function computeAssignmentAttention(
  asn: Assignment,
  todayStr: string = new Date().toISOString().slice(0, 10),
  hasOpenIssue: boolean = false
): OperationalAttentionState {
  // Tier 1: Real operational blocker (open field issue or branch hold)
  if (hasOpenIssue) {
    return 'BLOCKED';
  }

  // Tier 2: Post-field completion awaiting desk QA
  if (asn.status === 'COMPLETED' && asn.projectBranch?.status === 'AUDIT_COMPLETED') {
    return 'AWAITING_VALIDATION';
  }

  // Tier 3: Active field work underway without physical check-in evidence
  if (asn.status === 'IN_PROGRESS' && !asn.checkedInAt) {
    return 'CHECKIN_MISSING';
  }

  // Tier 4: Schedule overdue (scheduled date elapsed on non-terminal visit)
  const isTerminal = asn.status === 'COMPLETED' || asn.status === 'CANCELLED' || asn.status === 'REJECTED';
  const visitDate = asn.scheduledDate ? asn.scheduledDate.slice(0, 10) : null;
  const isOverdue = visitDate !== null && visitDate < todayStr && !isTerminal;

  if (isOverdue) {
    return 'OVERDUE';
  }

  // Tier 5: Unanswered dispatch awaiting response
  if (asn.status === 'PENDING') {
    return 'NEEDS_RESPONSE';
  }

  // Tier 6: Active field audit (checked in or in progress with attendance)
  if (asn.status === 'CHECKED_IN' || asn.status === 'IN_PROGRESS') {
    return 'IN_PROGRESS';
  }

  // Tier 7: Default on-track / routine
  return 'NORMAL';
}

export interface AssignmentDashboardSummary {
  total: number;
  statusCounts: Record<string, number>;
  priorityCounts: Record<string, number>;
  branchStatusCounts: Record<string, number>;
}

export function useAssignmentQueue() {
  const canActOnAssignments = hasAnyRole(useCurrentRoles(), [
    SystemRole.ADMIN,
    SystemRole.OPERATIONS,
  ]);

  // URL selections
  const [selectedAsnId, selectAssignment] = useUrlSelection('id');
  const [statusParam, setStatusParam] = useUrlSelection('status');
  const statusFilter = statusParam ?? 'ALL';
  const [pageParam, setPageParam] = useUrlSelection('page');
  const parsedPage = Number(pageParam);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
  const setPage = (next: number | ((current: number) => number)) => {
    const value = typeof next === 'function' ? next(page) : next;
    setPageParam(value <= 1 ? null : String(value));
  };

  const [searchTerm, setSearchTerm] = useState('');
  const [dateSort, setDateSort] = useState<'asc' | 'desc'>('asc');
  const { confirm, confirmWithReason, confirmDialog } = useConfirm();

  // 409 Conflict state
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | undefined>();

  // Action busy states
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [quickBusyId, setQuickBusyId] = useState<string | null>(null);

  const resetActionState = () => {
    setActionError(null);
  };

  useEffect(() => {
    resetActionState();
  }, [selectedAsnId]);

  const applyFilter = (value: string) => {
    setStatusParam(value === 'ALL' ? null : value);
    setPage(1);
  };

  const handleReloadLatest = () => {
    setConflictModalOpen(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all });
    if (selectedAsnId) {
      void queryClient.invalidateQueries({ queryKey: ['assignment-detail', selectedAsnId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments.timeline(selectedAsnId) });
      void queryClient.invalidateQueries({ queryKey: ['assignment-expenses', selectedAsnId] });
    }
  };

  const isAttentionView =
    statusFilter === NEEDS_ATTENTION_FILTER ||
    statusFilter === 'PENDING' ||
    statusFilter === 'REJECTED';
  const isEscalatedView = statusFilter === ESCALATED_FILTER;
  const isTerminalView = statusFilter === TERMINAL_FILTER;

  const queryString = isAttentionView
    ? `status=${statusFilter === NEEDS_ATTENTION_FILTER ? NEEDS_ATTENTION_FILTER : statusFilter}`
    : isEscalatedView
    ? `priority=${ESCALATED_FILTER}`
    : isTerminalView
    ? `status=${TERMINAL_FILTER}`
    : statusFilter === 'ALL'
    ? ''
    : `projectBranchStatus=${statusFilter}`;

  const { scopeParams, scopeKey } = useScope();
  const scopeQuery = withScope(scopeParams);

  // Main assignments list query
  const {
    data: mainData,
    isLoading,
    isError,
    error,
    refetch: refetchList,
  } = useQuery({
    queryKey: [...queryKeys.assignments.list(page, statusFilter), scopeKey],
    queryFn: () =>
      api.request<{ data: Assignment[]; meta: { pagination: { total: number } } }>(
        `/assignments?page=${page}&limit=${PAGE_SIZE}&${queryString}&${scopeQuery}`,
        { withMeta: true }
      ),
    staleTime: 15_000,
  });

  const assignments = mainData?.data ?? [];
  const total = mainData?.meta?.pagination?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Dashboard summary metrics
  const summaryQ = useQuery({
    queryKey: [...queryKeys.assignments.summary, scopeKey],
    queryFn: () =>
      api.request<AssignmentDashboardSummary>(`/assignments/dashboard/summary?${scopeQuery}`),
    staleTime: 15_000,
  });

  const statusCounts = summaryQ.data?.statusCounts ?? {};
  const priorityCounts = summaryQ.data?.priorityCounts ?? {};
  const branchStatusCounts = summaryQ.data?.branchStatusCounts ?? {};
  const sumOf = (counts: Record<string, number>, keys: string[]) =>
    keys.reduce((s, k) => s + (counts[k] ?? 0), 0);

  const activeCount = sumOf(branchStatusCounts, ACTIVE_STATUSES.split(','));
  const closedCount = branchStatusCounts.CLOSED ?? 0;
  const cancelledCount = sumOf(statusCounts, TERMINAL_FILTER.split(','));
  const pendingCount = statusCounts.PENDING ?? 0;
  const rejectedCount = statusCounts.REJECTED ?? 0;
  const escalatedCount = priorityCounts[ESCALATED_FILTER] ?? 0;
  const totalCount = summaryQ.data?.total ?? 0;

  // Field issues query
  const [showHandledIssues, setShowHandledIssues] = useState(false);
  const { data: rawIssues = [] } = useQuery({
    queryKey: ['field-issues', scopeKey],
    queryFn: () => api.request<FieldIssue[]>(`/assignments/field-issues?${scopeQuery}`),
    staleTime: 15_000,
  });

  const openIssues = rawIssues.filter((i) => i.open);
  const handledIssues = rawIssues.filter((i) => !i.open);
  const visibleIssues = showHandledIssues ? rawIssues : openIssues;

  const openIssueAssignmentIds = useMemo(() => {
    return new Set(openIssues.map((i) => i.assignmentId));
  }, [openIssues]);

  const issuesByAssignment = new Map<string, { latest: FieldIssue; count: number }>();
  for (const issue of visibleIssues) {
    const existing = issuesByAssignment.get(issue.assignmentId);
    if (!existing) {
      issuesByAssignment.set(issue.assignmentId, { latest: issue, count: 1 });
    } else {
      existing.count += 1;
      if (new Date(issue.reportedAt).getTime() > new Date(existing.latest.reportedAt).getTime()) {
        existing.latest = issue;
      }
    }
  }
  const groupedIssues = Array.from(issuesByAssignment.values());

  // Selected assignment resolution
  const onPage = assignments.find((a) => a.id === selectedAsnId);
  const { data: fetchedSelected } = useQuery({
    queryKey: ['assignment-detail', selectedAsnId],
    queryFn: () => api.request<Assignment>(`/assignments/${selectedAsnId}`),
    enabled: !!selectedAsnId && !onPage,
    staleTime: 15_000,
  });
  const selectedAsn = onPage ?? (fetchedSelected?.id === selectedAsnId ? fetchedSelected : undefined);

  useEffect(() => {
    if (!selectedAsnId && assignments.length > 0) {
      selectAssignment(assignments[0].id);
    }
  }, [assignments, selectedAsnId, selectAssignment]);

  // Filter and sort assignments with derived attention calculation
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const filteredAssignments = useMemo(() => {
    return assignments
      .filter((a) => {
        if (!searchTerm) return true;
        const term = searchTerm.toLowerCase();
        return (
          a.assignmentNumber.toLowerCase().includes(term) ||
          a.project?.name?.toLowerCase().includes(term) ||
          a.assayer?.displayName?.toLowerCase().includes(term) ||
          a.projectBranch?.branch?.name?.toLowerCase().includes(term)
        );
      })
      .sort((a, b) => {
        const ta = a.scheduledDate ? new Date(a.scheduledDate).getTime() : Number.POSITIVE_INFINITY;
        const tb = b.scheduledDate ? new Date(b.scheduledDate).getTime() : Number.POSITIVE_INFINITY;
        return dateSort === 'asc' ? ta - tb : tb - ta;
      });
  }, [assignments, searchTerm, dateSort]);

  // Actions
  const runTransition = async (targetStatus: string, reason?: string) => {
    if (!selectedAsnId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.request(`/assignments/${selectedAsnId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, reason }),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all });
      resetActionState();
    } catch (err: any) {
      if (err?.status === 409 || err?.message?.includes('conflict') || err?.code === 'CONFLICT') {
        setConflictMessage(userMessage(err));
        setConflictModalOpen(true);
      } else {
        setActionError(userMessage(err));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const askToComplete = async (attended: boolean): Promise<{ reason?: string } | null> => {
    if (attended) return (await confirm(COMPLETE_CONFIRM)) ? {} : null;
    const { confirmed, reason } = await confirmWithReason(COMPLETE_WITHOUT_CHECK_IN_CONFIRM);
    return confirmed ? { reason } : null;
  };

  const quickAction = async (
    asnId: string,
    targetStatus: 'ACCEPTED' | 'COMPLETED',
    attended = true
  ) => {
    if (quickBusyId) return;
    let reason: string | undefined;
    if (targetStatus === 'COMPLETED') {
      const answer = await askToComplete(attended);
      if (!answer) return;
      reason = answer.reason;
    }
    setQuickBusyId(asnId);
    try {
      await api.request(`/assignments/${asnId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, reason }),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all });
    } catch (err: any) {
      if (err?.status === 409 || err?.message?.includes('conflict') || err?.code === 'CONFLICT') {
        setConflictMessage(userMessage(err));
        setConflictModalOpen(true);
      } else {
        selectAssignment(asnId);
        setActionError(userMessage(err));
      }
    } finally {
      setQuickBusyId(null);
    }
  };

  const runEscalate = async (reason?: string) => {
    if (!selectedAsnId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.request(`/assignments/${selectedAsnId}/escalate`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason?.trim() || 'Manually escalated by ops' }),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all });
    } catch (err: any) {
      if (err?.status === 409 || err?.message?.includes('conflict') || err?.code === 'CONFLICT') {
        setConflictMessage(userMessage(err));
        setConflictModalOpen(true);
      } else {
        setActionError(userMessage(err));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const { download: downloadExcel, busy: exporting } = useQueuedExcelExport();
  const handleExport = () => {
    const params: Record<string, string> = { ...scopeParams };
    if (queryString) {
      for (const pair of queryString.split('&')) {
        const [k, v] = pair.split('=');
        if (k) params[k] = v;
      }
    }
    void downloadExcel('/reports/assignments/jobs', params);
  };

  const planningLinkFor = (asn: Assignment): string => {
    const params = new URLSearchParams();
    if (asn.projectId) params.set('projectId', asn.projectId);
    if (asn.projectBranchId) params.set('branchId', asn.projectBranchId);
    const qs = params.toString();
    return qs ? `/planning?${qs}` : '/planning';
  };

  const currentViewLabel =
    statusFilter === 'ALL'
      ? 'Everything'
      : statusFilter === ACTIVE_STATUSES
      ? 'Active work'
      : statusFilter === 'PENDING'
      ? 'Awaiting the assayer’s response'
      : statusFilter === 'REJECTED'
      ? 'Declined by assayer'
      : statusFilter === ESCALATED_FILTER
      ? 'Escalated'
      : statusFilter === 'CLOSED'
      ? 'Closed'
      : statusFilter === TERMINAL_FILTER
      ? 'Cancelled or rejected'
      : branchStatusLabel(statusFilter);

  const showStageDrilldown =
    statusFilter === ACTIVE_STATUSES || (STAGE3_STATUSES as string[]).includes(statusFilter);

  return {
    // Role & permissions
    canActOnAssignments,
    // Selection state
    selectedAsnId,
    selectAssignment,
    selectedAsn,
    // Filters & Pagination
    statusFilter,
    applyFilter,
    page,
    setPage,
    total,
    totalPages,
    searchTerm,
    setSearchTerm,
    dateSort,
    setDateSort,
    currentViewLabel,
    showStageDrilldown,
    // Counts
    totalCount,
    activeCount,
    pendingCount,
    rejectedCount,
    escalatedCount,
    closedCount,
    cancelledCount,
    branchStatusCounts,
    // Issues
    openIssues,
    handledIssues,
    groupedIssues,
    showHandledIssues,
    setShowHandledIssues,
    openIssueAssignmentIds,
    // Queries
    assignments,
    filteredAssignments,
    isLoading,
    isError,
    error,
    refetchList,
    // Attention calculation helper
    todayStr,
    // Actions & Busy states
    quickBusyId,
    actionBusy,
    actionError,
    setActionError,
    quickAction,
    runTransition,
    runEscalate,
    askToComplete,
    planningLinkFor,
    // Export
    exporting,
    handleExport,
    // Modals
    confirmDialog,
    conflictModalOpen,
    setConflictModalOpen,
    conflictMessage,
    handleReloadLatest,
    confirm,
    confirmWithReason,
  };
}
