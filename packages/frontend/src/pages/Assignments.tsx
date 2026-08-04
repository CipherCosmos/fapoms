import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, RefreshCw, Calendar, MessageSquare, Clock, Send, Filter, CheckCircle, XCircle, ExternalLink, GitCommit, Circle, ArrowRight, MapPin, FileText, Lock, ChevronLeft, ChevronRight, AlertTriangle, Hourglass, Flame } from 'lucide-react';
import { StatusBadge, KpiCard, SearchInput, FilterSelect, AlertBanner } from '../components/ui';
import { ProjectBranchStatus } from '@fapoms/shared';
import { anyStatusLabel, branchStatusLabel, branchStatusTone, assessmentStatusLabel } from '../utils/statusLabels';
import { api } from '../services/api';
import { queryClient } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';

interface Assignment {
  id: string;
  assignmentNumber: string;
  projectId: string;
  assayerId: string;
  status: string;
  rejectReason?: string | null;
  priority: string;
  proposedFee: number;
  agreedFee: number | null;
  scheduledDate: string | null;
  createdAt: string;
  project: { name: string };
  assayer: { displayName: string };
  projectBranch: { status?: string; branch: { name: string; state: string } };
  assessment: { status?: string; branch: { name: string; state: string }; packetSize?: number } | null;
}

interface TimelineEvent {
  type: string;
  timestamp: string;
  description: string;
  user: string;
}

// Intentional subset — the 5 "stage-3" (field execution) branch statuses this
// page's filter UI scopes to, not the full ProjectBranchStatus enum. Spelled
// via enum members so a rename of any of these is caught at compile time.
const STAGE3_STATUSES = [
  ProjectBranchStatus.SCHEDULED,
  ProjectBranchStatus.AUDIT_COMPLETED,
  ProjectBranchStatus.VALIDATION_COMPLETED,
  ProjectBranchStatus.CLOSED,
  ProjectBranchStatus.CANCELLED,
];
const ACTIVE_STATUSES = 'SCHEDULED,AUDIT_COMPLETED,VALIDATION_COMPLETED';
// Sentinel filter value: switches the main query from filtering by branch status
// (projectBranchStatus=) to filtering by assignment status (status=PENDING,REJECTED),
// surfacing not-yet-accepted/auto-declined assignments through the same table,
// filter dropdown, and detail panel — no separate section or components.
const NEEDS_ATTENTION_FILTER = 'PENDING,REJECTED';
// Second sentinel: switches the same query mechanism to the priority axis
// (priority=CRITICAL) for manually-escalated assignments.
const ESCALATED_FILTER = 'CRITICAL';
// Third sentinel, also on the assignment-status axis. Rejecting or cancelling an
// assignment returns its branch to CANDIDATE_SEARCH so it can be re-offered — it does
// NOT set the branch to CANCELLED. Counting this tile on the branch axis therefore
// always yielded 0 while real rejected/cancelled assignments existed.
const TERMINAL_FILTER = 'REJECTED,CANCELLED';
const PAGE_SIZE = 25;

// ── Shared status badge — single source of truth, used by both the list rows
// and the detail panel header (previously duplicated as two separate inline IIFEs).
// Colours come from the canonical branch-status tone in statusLabels, so this badge
// agrees with the planning map and every other page for the same branch status.
function getStatusBadgeProps(status: string): { bg: string; color: string; icon: React.ReactNode } {
  const isCheckedIn = status === 'SCHEDULED';
  const isDone = status === 'AUDIT_COMPLETED' || status === 'VALIDATION_COMPLETED';
  const isClosed = status === 'CLOSED';

  const tone = branchStatusTone(status);
  const icon = isCheckedIn ? <MapPin size={13} /> : isDone ? <FileText size={13} /> : isClosed ? <Lock size={13} /> : null;
  return { bg: tone.bg, color: tone.color, icon };
}

function AssignmentStatusBadge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const { bg, color, icon } = getStatusBadgeProps(status);
  return <StatusBadge label={anyStatusLabel(status)} bg={bg} color={color} icon={icon} variant="tag" size={size} />;
}

function AutoDeclinedChip() {
  return <StatusBadge label="Auto-declined" bg="var(--status-pending-bg)" color="var(--warning)" icon={<Hourglass size={11} />} variant="tag" />;
}

// Only rendered for HIGH/CRITICAL — the default MEDIUM/LOW stay invisible so
// this doesn't turn into visual noise on every ordinary row.
function PriorityBadge({ priority }: { priority?: string }) {
  if (priority !== 'CRITICAL' && priority !== 'HIGH') return null;
  const isCritical = priority === 'CRITICAL';
  return <StatusBadge label={priority} bg={isCritical ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)'} color={isCritical ? 'var(--danger)' : 'var(--warning)'} icon={<Flame size={11} />} variant="tag" />;
}

// ── Compact workflow breadcrumb — replaces the old pipeline-bar + gradient
// banner + h2 (three separate blocks all stating "Stage 3 / Field Execution").
// Uses client-side navigation instead of window.location.href full reloads.
function WorkflowBreadcrumb({ onNavigate }: { onNavigate: (path: string) => void }) {
  const steps = [
    { n: 1, label: 'Planning & Matching', path: '/planning' },
    { n: 2, label: 'Schedule Dispatch', path: '/scheduling' },
    { n: 3, label: 'Field Execution', path: '/assignments' },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      {steps.map((s, i) => {
        const active = s.n === 3;
        return (
          <React.Fragment key={s.n}>
            <button
              onClick={() => onNavigate(s.path)}
              className="btn"
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px',
                background: active ? 'var(--status-active-bg)' : 'var(--bg-surface-2)',
                border: `1px solid ${active ? 'var(--success)' : 'var(--border-color)'}`,
                borderRadius: '20px', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: '11px', fontWeight: active ? 700 : 600, cursor: 'pointer',
              }}
            >
              <span>{s.n}</span> {s.label}
            </button>
            {i < steps.length - 1 && <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export const Assignments: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const assignmentIdParam = searchParams.get('id');
  const [selectedAsnId, setSelectedAsnId] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');
  const [error] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [page, setPage] = useState(1);

  useSocketInvalidation();

  const applyFilter = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  // ── Lifecycle actions — the only mutation this page had was posting a
  // comment. Accept/Reject/Cancel/Complete/Escalate call the same endpoints
  // PlanningWorkspace and the SLA scanner already use; a plain un-countered
  // PENDING offer had no manual override anywhere in the frontend before this.
  const [actionMode, setActionMode] = useState<'REJECT' | 'CANCEL' | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resetActionState = () => {
    setActionMode(null);
    setActionReason('');
    setActionError(null);
  };

  useEffect(() => {
    resetActionState();
  }, [selectedAsnId]);

  const runTransition = async (targetStatus: string, reason?: string) => {
    if (!selectedAsnId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.request(`/assignments/${selectedAsnId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, reason }),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all });
      resetActionState();
    } catch (err: any) {
      setActionError(err?.message || 'Action failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const runEscalate = async () => {
    if (!selectedAsnId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.request(`/assignments/${selectedAsnId}/escalate`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Manually escalated by ops' }),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all });
    } catch (err: any) {
      setActionError(err?.message || 'Escalate failed.');
    } finally {
      setActionBusy(false);
    }
  };

  // ── Main table — one unified list driven by one filter, whether the axis is
  // branch status (the normal stage-3 views), assignment status (Needs Attention),
  // or priority (Escalated).
  const isAttentionView = statusFilter === NEEDS_ATTENTION_FILTER;
  const isEscalatedView = statusFilter === ESCALATED_FILTER;
  const isTerminalView = statusFilter === TERMINAL_FILTER;
  // 'ALL' means genuinely unfiltered. It used to constrain to the five stage-3 branch
  // statuses, which silently hid every rejected/cancelled assignment (their branch is back
  // at CANDIDATE_SEARCH) — so this page reported 3 while the dashboard reported 5.
  const queryString = isAttentionView
    ? `status=${NEEDS_ATTENTION_FILTER}`
    : isEscalatedView
    ? `priority=${ESCALATED_FILTER}`
    : isTerminalView
    ? `status=${TERMINAL_FILTER}`
    : statusFilter === 'ALL'
    ? ''
    : `projectBranchStatus=${statusFilter}`;

  const { data: mainData, isLoading } = useQuery({
    queryKey: queryKeys.assignments.list(page, statusFilter),
    queryFn: () => api.request<{ data: Assignment[]; meta: { pagination: { total: number } } }>(
      `/assignments?page=${page}&limit=${PAGE_SIZE}&${queryString}`,
      { withMeta: true },
    ),
    staleTime: 15_000,
  });
  const assignments = mainData?.data ?? [];
  const total = mainData?.meta?.pagination?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Lightweight KPI counts — cheap limit=1 requests reusing the same
  // paginated endpoint purely for its `meta.pagination.total`, rather than
  // recomputing counts by filtering whatever single page happens to be loaded.
  const useCount = (params: string) => useQuery({
    queryKey: queryKeys.assignments.count(params),
    queryFn: () => api.request<{ meta: { pagination: { total: number } } }>(
      `/assignments?page=1&limit=1&${params}`,
      { withMeta: true },
    ),
    staleTime: 15_000,
  });
  const grandTotalQ = useCount('');
  const activeCountQ = useCount(`projectBranchStatus=${ACTIVE_STATUSES}`);
  const closedCountQ = useCount(`projectBranchStatus=CLOSED`);
  const cancelledCountQ = useCount(`status=${TERMINAL_FILTER}`);
  const attentionCountQ = useCount(`status=${NEEDS_ATTENTION_FILTER}`);
  const escalatedCountQ = useCount(`priority=${ESCALATED_FILTER}`);
  const activeCount = activeCountQ.data?.meta?.pagination?.total ?? 0;
  const closedCount = closedCountQ.data?.meta?.pagination?.total ?? 0;
  const cancelledCount = cancelledCountQ.data?.meta?.pagination?.total ?? 0;
  const needsAttentionCount = attentionCountQ.data?.meta?.pagination?.total ?? 0;
  const escalatedCount = escalatedCountQ.data?.meta?.pagination?.total ?? 0;
  // Queried directly rather than summing the tiles below. The tiles overlap (an escalated
  // assignment is also active) and don't cover everything, so summing them under-reported
  // the total and disagreed with the dashboard.
  const totalCount = grandTotalQ.data?.meta?.pagination?.total ?? 0;

  const selectedAsn = assignments.find(a => a.id === selectedAsnId);

  const { data: timeline = [], isLoading: isLoadingTimeline } = useQuery({
    queryKey: queryKeys.assignments.timeline(selectedAsnId || ''),
    queryFn: () => api.request<TimelineEvent[]>(`/assignments/${selectedAsnId}/timeline`),
    enabled: !!selectedAsnId,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (assignmentIdParam) {
      setSelectedAsnId(assignmentIdParam);
    } else if (assignments.length > 0 && !selectedAsnId) {
      setSelectedAsnId(assignments[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentIdParam, assignments]);

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

  const formatEventTime = (ts: string): string => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatEventDate = (ts: string): string => {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  const groupByDate = (events: TimelineEvent[]): { date: string; events: TimelineEvent[] }[] => {
    const groups: Record<string, TimelineEvent[]> = {};
    events.forEach(evt => {
      const key = new Date(evt.timestamp).toDateString();
      if (!groups[key]) groups[key] = [];
      groups[key].push(evt);
    });
    return Object.entries(groups).map(([date, evts]) => ({ date, events: evts }));
  };

  const getEventIcon = (type: string) => {
    if (type === 'COMMENT') return <MessageSquare size={14} />;
    if (type === 'STATUS_CHANGE' || type === 'TRANSITION') return <GitCommit size={14} />;
    return <Circle size={14} />;
  };

  const getEventAccent = (type: string) => {
    if (type === 'COMMENT') return { color: 'var(--accent-primary)', bg: 'rgba(216,174,71,0.08)', border: 'rgba(216,174,71,0.2)', iconBg: 'rgba(216,174,71,0.15)' };
    if (type === 'STATUS_CHANGE' || type === 'TRANSITION') return { color: 'var(--success)', bg: 'var(--status-active-bg)', border: 'var(--status-active-bg)', iconBg: 'var(--status-active-bg)' };
    return { color: 'var(--accent-secondary)', bg: 'rgba(216,174,71,0.08)', border: 'rgba(216,174,71,0.2)', iconBg: 'rgba(216,174,71,0.15)' };
  };

  const highlightKeywords = (text: string): React.ReactNode => {
    const keywordMap: Record<string, string> = {
      'CREATED': 'var(--warning)', 'ACCEPTED': 'var(--success)', 'REJECTED': 'var(--danger)',
      'SCHEDULED': 'var(--accent)', 'COMPLETED': 'var(--accent)', 'CANCELLED': 'var(--danger)',
      'CLOSED': 'var(--success)', 'PENDING': 'var(--warning)', 'CONFIRMED': 'var(--success)',
      'NEGOTIATION': 'var(--warning)', 'CHECKED_IN': 'var(--accent)',
      'CANDIDATE_SELECTED': 'var(--warning)', 'CONTACT_INITIATED': 'var(--accent)',
      'AUDIT_COMPLETED': 'var(--accent)',
    };
    const pattern = new RegExp(`(${Object.keys(keywordMap).join('|')}|₹[\\d,]+(?:\\.\\d+)?)`, 'gi');
    const parts = text.split(pattern);
    return parts.map((part, i) => {
      const upper = part.toUpperCase();
      const color = keywordMap[upper];
      if (color) {
        return <span key={i} style={{ display: 'inline-block', padding: '0 5px', borderRadius: '3px', fontSize: '11px', fontWeight: 700, background: color + '20', color, letterSpacing: '0.2px' }}>{part}</span>;
      }
      if (/^₹[\d,]+(\.\d+)?$/.test(part)) {
        return <span key={i} style={{ display: 'inline-block', padding: '0 5px', borderRadius: '3px', fontSize: '11px', fontWeight: 700, background: 'var(--warning)' + '20', color: 'var(--warning)' }}>{part}</span>;
      }
      return part;
    });
  };

  const invalidateTimeline = (id: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.assignments.timeline(id) });
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAsnId || !newComment.trim()) return;
    try {
      await api.request(`/assignments/${selectedAsnId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ comment: newComment })
      });
      setNewComment('');
      invalidateTimeline(selectedAsnId);
    } catch (err) {
      console.error('Failed to post comment');
    }
  };

  const filteredAssignments = assignments.filter(a => {
    if (!searchTerm) return true;
    return a.assignmentNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.project?.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.assayer?.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.projectBranch?.branch?.name?.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const selectAndShow = (id: string) => {
    setSelectedAsnId(id);
    navigate(`/assignments?id=${id}`, { replace: true });
  };

  const pageStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Consolidated header — one breadcrumb, one title. Replaces the old
          pipeline-bar + gradient banner + h2 (three blocks, same fact repeated). */}
      <WorkflowBreadcrumb onNavigate={navigate} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Field Execution Workspace</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Track and manage live field audits — acceptance through check-in, submission, and closure.
          </p>
        </div>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all })}
          className="btn btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && <AlertBanner type="error" message={error} />}

      {/* KPI Cards — clickable, filter the single table below. "Needs Attention"
          is not a separate list: it's the same filter mechanism switched to the
          assignment-status axis, so PENDING/auto-declined assignments (previously
          invisible on this page entirely) surface in the exact same table/detail
          panel as everything else. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
        {[
          { label: 'Total Assignments', value: totalCount, icon: ClipboardList, color: 'var(--accent-primary)', filter: 'ALL' },
          { label: 'Active / In Progress', value: activeCount, icon: RefreshCw, color: 'var(--accent-secondary)', filter: ACTIVE_STATUSES },
          { label: 'Closed', value: closedCount, icon: CheckCircle, color: 'var(--status-active)', filter: 'CLOSED' },
          { label: 'Cancelled / Rejected', value: cancelledCount, icon: XCircle, color: 'var(--danger)', filter: TERMINAL_FILTER },
          { label: 'Needs Attention', value: needsAttentionCount, icon: AlertTriangle, color: 'var(--warning)', filter: NEEDS_ATTENTION_FILTER },
          { label: 'Escalated', value: escalatedCount, icon: Flame, color: 'var(--danger)', filter: ESCALATED_FILTER },
        ].map(card => {
          const Icon = card.icon;
          const isActive = statusFilter === card.filter;
          return (
            <KpiCard
              key={card.label}
              layout="label-first"
              icon={<Icon />}
              iconBg="var(--bg-surface-2)"
              iconColor={card.color}
              label={card.label}
              value={card.value}
              valueColor="var(--text-primary)"
              onClick={() => applyFilter(card.filter)}
              style={{
                border: isActive ? `1px solid ${card.color}` : '1px solid var(--border-color)',
                background: isActive ? `${card.color}10` : undefined,
              }}
            />
          );
        })}
      </div>

      {/* Search & Filter */}
      <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search this page by ID, project, assayer, branch..." iconSize={16} />
        <FilterSelect
          value={statusFilter}
          onChange={applyFilter}
          label={<Filter size={14} style={{ color: 'var(--text-muted)' }} />}
          options={[
            { value: 'ALL', label: 'All Statuses' },
            ...STAGE3_STATUSES.map(s => ({ value: s, label: branchStatusLabel(s) })),
            { value: TERMINAL_FILTER, label: 'Cancelled / Rejected' },
            { value: NEEDS_ATTENTION_FILTER, label: 'Needs Attention (awaiting response / auto-declined)' },
            { value: ESCALATED_FILTER, label: 'Escalated (Critical priority)' },
          ]}
        />
      </div>

      <div className="responsive-grid-split" style={{ alignItems: 'start' }}>
        {/* Left Column - Assignments List */}
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading assignments queue...</div>
          ) : filteredAssignments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <ClipboardList size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
              <p>No assignments found matching your criteria.</p>
            </div>
          ) : (
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '16px 24px' }}>Assignment ID</th>
                  <th style={{ padding: '16px 24px' }}>Project / Branch</th>
                  <th style={{ padding: '16px 24px' }}>Assayer</th>
                  <th style={{ padding: '16px 24px' }}>Status</th>
                  <th style={{ padding: '16px 24px' }}>{isAttentionView ? 'Waiting' : 'Branch Status'}</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssignments.map((asn) => (
                  <tr key={asn.id} onClick={() => selectAndShow(asn.id)} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '14px', cursor: 'pointer', background: selectedAsnId === asn.id ? 'rgba(216,174,71,0.08)' : 'transparent', borderLeft: selectedAsnId === asn.id ? '4px solid var(--accent-primary)' : '4px solid transparent' }}>
                    <td style={{ padding: '16px 24px', fontWeight: 600 }}>{asn.assignmentNumber}</td>
                    <td style={{ padding: '16px 24px' }}>
                      <div><b>{asn.projectBranch?.branch?.name}</b></div>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{asn.project?.name}</span>
                    </td>
                    <td style={{ padding: '16px 24px' }}>{asn.assayer?.displayName}</td>
                    <td style={{ padding: '16px 24px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <AssignmentStatusBadge status={String(asn.projectBranch?.status || asn.status)} size="sm" />
                        {asn.status === 'REJECTED' && asn.rejectReason === 'AUTO_DECLINED_SLA_EXPIRED' && <AutoDeclinedChip />}
                        <PriorityBadge priority={asn.priority} />
                      </div>
                    </td>
                    <td style={{ padding: '16px 24px', color: isAttentionView ? 'var(--text-muted)' : undefined, fontSize: isAttentionView ? '12px' : undefined }} onClick={(e) => e.stopPropagation()}>
                      {isAttentionView
                        ? formatRelativeTime(asn.createdAt)
                        : (asn.assessment?.status ? (
                          <span className="badge" style={{ background: 'rgba(216,174,71,0.12)', color: 'var(--accent)', padding: '2px 8px', fontWeight: 600, borderRadius: '4px', fontSize: '11px' }}>
                            {assessmentStatusLabel(asn.assessment.status)}
                          </span>
                        ) : '-')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Pagination — wired to the server pagination that already existed on
              the backend and was never used (fixed limit=100, no controls). */}
          {!isLoading && total > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px', borderTop: '1px solid var(--border-color)' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Showing {pageStart}–{pageEnd} of {total}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="btn btn-secondary"
                  style={{ padding: '5px 8px', opacity: page <= 1 ? 0.4 : 1, cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
                >
                  <ChevronLeft size={14} />
                </button>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', padding: '0 6px' }}>
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="btn btn-secondary"
                  style={{ padding: '5px 8px', opacity: page >= totalPages ? 0.4 : 1, cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Column - Details Panel */}
        <div className="glass-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: '500px', overflow: 'hidden' }}>
          {selectedAsn ? (
            <>
              {/* Header */}
              <div style={{
                background: 'linear-gradient(135deg, rgba(216,174,71,0.12) 0%, rgba(216,174,71,0.06) 100%)',
                borderBottom: '1px solid var(--border-color)',
                padding: '14px 16px 12px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>DETAILS PANEL</span>
                    <h4 style={{ fontSize: '14px', fontWeight: 700, margin: '1px 0' }}>{selectedAsn.assignmentNumber}</h4>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <AssignmentStatusBadge status={String(selectedAsn.projectBranch?.status || selectedAsn.status)} />
                    {selectedAsn.status === 'REJECTED' && selectedAsn.rejectReason === 'AUTO_DECLINED_SLA_EXPIRED' && <AutoDeclinedChip />}
                    <PriorityBadge priority={selectedAsn.priority} />
                  </div>
                </div>
              </div>

              {/* Lifecycle actions — contextual to the current status. This is the
                  page's actual management console, not just a viewer. */}
              {selectedAsn.status !== 'COMPLETED' && (
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {selectedAsn.status === 'PENDING' && (
                      <>
                        <button onClick={() => { if (window.confirm('Accept this offer? This commits the assayer to the assignment.')) runTransition('ACCEPTED'); }} disabled={actionBusy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                          ✓ Accept
                        </button>
                        <button onClick={() => setActionMode('REJECT')} disabled={actionBusy} className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--danger)', borderColor: 'var(--status-cancelled-bg)' }}>
                          ✕ Reject
                        </button>
                      </>
                    )}
                    {['ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'].includes(selectedAsn.status) && (
                      <button onClick={() => { if (window.confirm('Mark this assignment complete? This is not reversible.')) runTransition('COMPLETED'); }} disabled={actionBusy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                        ✓ Mark Complete
                      </button>
                    )}
                    {['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'].includes(selectedAsn.status) && (
                      <button onClick={() => setActionMode('CANCEL')} disabled={actionBusy} className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                        Cancel
                      </button>
                    )}
                    {['REJECTED', 'CANCELLED'].includes(selectedAsn.status) && (
                      <button onClick={() => navigate('/planning')} className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px' }}>
                        Reassign →
                      </button>
                    )}
                    {selectedAsn.priority !== 'CRITICAL' && (
                      <button onClick={() => { if (window.confirm('Escalate this assignment? It will be flagged as critical priority.')) runEscalate(); }} disabled={actionBusy} className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--warning)', borderColor: 'var(--status-pending-bg)', marginLeft: 'auto' }}>
                        ⚠ Escalate
                      </button>
                    )}
                  </div>

                  {actionMode && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        type="text"
                        value={actionReason}
                        onChange={(e) => setActionReason(e.target.value)}
                        placeholder={actionMode === 'REJECT' ? 'Reason for rejecting...' : 'Reason for cancelling...'}
                        style={{ flex: 1, padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '11.5px' }}
                      />
                      <button
                        onClick={() => runTransition(actionMode === 'REJECT' ? 'REJECTED' : 'CANCELLED', actionReason || undefined)}
                        disabled={actionBusy}
                        className="btn btn-primary"
                        style={{ padding: '5px 10px', fontSize: '11px', background: 'var(--danger)', borderColor: 'var(--danger)' }}
                      >
                        Confirm
                      </button>
                      <button onClick={resetActionState} className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '11px' }}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {actionError && (
                    <div style={{ fontSize: '11px', color: 'var(--danger)' }}>{actionError}</div>
                  )}
                </div>
              )}

              {/* Details Grid */}
              <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ background: 'rgba(216,174,71,0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(216,174,71,0.15)' }}>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Assayer</span>
                  <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>{selectedAsn.assayer?.displayName || '—'}</p>
                </div>
                <div style={{ background: 'rgba(216,174,71,0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(216,174,71,0.15)' }}>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Fee</span>
                  <p style={{ fontSize: '14px', fontWeight: 800, margin: '1px 0', background: 'linear-gradient(135deg, var(--warning), var(--warning))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    ₹{selectedAsn.agreedFee ?? selectedAsn.proposedFee}
                  </p>
                </div>
                <div style={{ background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid var(--status-active-bg)', gridColumn: 'span 2' }}>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Branch / Project</span>
                  <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>
                    {selectedAsn.projectBranch?.branch?.name}
                    {selectedAsn.projectBranch?.branch?.state && (
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> — {selectedAsn.projectBranch.branch.state}</span>
                    )}
                  </p>
                  <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '1px 0 0' }}>{selectedAsn.project?.name}</p>
                </div>
                <div style={{ background: 'rgba(216,174,71,0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(216,174,71,0.15)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Calendar size={13} style={{ color: 'var(--accent)' }} />
                  <div>
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Scheduled</span>
                    <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>{selectedAsn.scheduledDate ? new Date(selectedAsn.scheduledDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unscheduled'}</p>
                  </div>
                </div>
                <div style={{ background: 'var(--status-pending-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid var(--status-pending-bg)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <ExternalLink size={13} style={{ color: 'var(--warning)' }} />
                  <div>
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Quick Links</span>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '1px' }}>
                      <button onClick={() => navigate(`/planning`)} className="btn btn-secondary" style={{ padding: '1px 6px', fontSize: '9px', background: 'var(--border-hair)' }}>Planning</button>
                      <button onClick={() => navigate(`/scheduling`)} className="btn btn-secondary" style={{ padding: '1px 6px', fontSize: '9px', background: 'var(--border-hair)' }}>Schedule</button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Timeline Section */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px', letterSpacing: '0.3px' }}>
                    <Clock size={12} style={{ color: 'var(--accent-primary)' }} /> CHRONOLOGICAL TIMELINE
                  </span>
                  {timeline.length > 0 && (
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 'var(--radius-full)' }}>
                      {timeline.length} event{timeline.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {isLoadingTimeline ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '32px', color: 'var(--text-muted)', fontSize: '13px' }}>
                    <div style={{ width: '14px', height: '14px', border: '2px solid var(--border-color)', borderTop: '2px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    Loading timeline...
                  </div>
                ) : (
                  <div style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '4px', flex: 1 }}>
                    {timeline.length === 0 ? (
                      <div style={{ padding: '28px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
                        <Clock size={22} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                        <p style={{ fontWeight: 600, marginBottom: '2px' }}>No timeline events yet</p>
                        <p style={{ fontSize: '12px' }}>Events will appear here as the assignment progresses.</p>
                      </div>
                    ) : (
                      groupByDate(timeline).map((group) => (
                        <div key={group.date}>
                          {/* Date Header */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 8px' }}>
                            <div style={{
                              fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                              background: 'var(--bg-tertiary)', padding: '2px 10px',
                              borderRadius: 'var(--radius-full)', letterSpacing: '0.3px',
                            }}>
                              {formatEventDate(group.events[0].timestamp)}
                            </div>
                            <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
                          </div>

                          {/* Timeline vertical line + events */}
                          <div style={{ position: 'relative', paddingLeft: '28px' }}>
                            {/* Vertical connecting line */}
                            <div style={{
                              position: 'absolute', left: '13px', top: '8px', bottom: '8px',
                              width: '2px', background: 'var(--border-color)',
                              borderRadius: '1px',
                            }} />
                            {group.events.map((evt, idx) => {
                              const accent = getEventAccent(evt.type);
                              return (
                                <div key={idx} style={{
                                  position: 'relative',
                                  marginBottom: idx < group.events.length - 1 ? '10px' : 0,
                                }}>
                                  {/* Icon node on the timeline line */}
                                  <div style={{
                                    position: 'absolute', left: '-28px', top: '8px',
                                    width: '26px', height: '26px',
                                    borderRadius: '50%',
                                    background: accent.iconBg,
                                    border: `2px solid ${accent.color}`,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: accent.color,
                                    zIndex: 1,
                                  }}>
                                    {getEventIcon(evt.type)}
                                  </div>
                                  {/* Event card */}
                                  <div style={{
                                    background: accent.bg,
                                    border: `1px solid ${accent.border}`,
                                    borderRadius: 'var(--radius-sm)',
                                    padding: '8px 10px',
                                    fontSize: '12px',
                                    transition: 'all 0.2s ease',
                                    cursor: 'default',
                                  }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateX(2px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)'; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'none'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{
                                          display: 'inline-block', padding: '1px 6px',
                                          fontSize: '9px', fontWeight: 700, letterSpacing: '0.3px',
                                          borderRadius: 'var(--radius-full)',
                                          background: accent.color + '20',
                                          color: accent.color,
                                        }}>
                                          {evt.type}
                                        </span>
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 500 }}>
                                          {evt.user}
                                        </span>
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatEventTime(evt.timestamp)}</span>
                                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', opacity: 0.6 }}>{formatRelativeTime(evt.timestamp)}</span>
                                      </div>
                                    </div>
                                    <p style={{ color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, paddingLeft: '2px', fontSize: '12px' }}>{highlightKeywords(evt.description)}</p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Comment Form */}
              <form onSubmit={handlePostComment} style={{
                display: 'flex',
                gap: '6px',
                padding: '10px 16px',
                borderTop: '1px solid var(--border-color)',
                background: 'rgba(216,174,71,0.04)',
              }}>
                <input
                  type="text"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Post comment..."
                  required
                  style={{
                    flex: 1,
                    padding: '7px 10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    fontSize: '12px',
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{
                    padding: '7px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <Send size={13} />
                </button>
              </form>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '60px 24px', textAlign: 'center' }}>
              <div style={{
                width: '56px', height: '56px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(216,174,71,0.1)',
                border: '1px solid rgba(216,174,71,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: '16px',
              }}>
                <MessageSquare size={28} style={{ color: 'var(--accent-primary)', opacity: 0.7 }} />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 600 }}>No Assignment Selected</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px', maxWidth: '260px' }}>
                Select an assignment row from the table to review its details, timeline, and post comments.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
