import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar,
  MessageSquare,
  Clock,
  Send,
  ExternalLink,
  GitCommit,
  Circle,
  Hourglass,
  Flame,
} from 'lucide-react';
import { StatusBadge } from '../../components/ui';
import { activityEventLabel } from '@fapoms/shared';
import { anyStatusLabel } from '../../utils/statusLabels';
import { api } from '../../services/api';
import { queryClient } from '../../queryClient';
import { queryKeys } from '../../hooks/queryKeys';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { assignmentFee } from '../../utils/money';
import { AssignmentMoneyCard } from '../billing/AssignmentMoneyCard';
import { computeAssignmentAttention } from './useAssignmentQueue';
import { readAttendance, formatAttendanceMoment } from './attendance';
import type { Assignment, TimelineEvent } from './types';

interface AssignmentDetailDrawerProps {
  assignment?: Assignment;
  canActOnAssignments: boolean;
  actionBusy: boolean;
  actionError: string | null;
  onClearActionError: () => void;
  onTransition: (targetStatus: string, reason?: string) => Promise<void>;
  onEscalate: (reason?: string) => Promise<void>;
  askToComplete: (attended: boolean, departed?: boolean) => Promise<{ reason?: string } | null>;
  planningLinkFor: (asn: Assignment) => string;
  confirm: (opts: any) => Promise<boolean>;
  confirmWithReason: (opts: any) => Promise<{ confirmed: boolean; reason?: string }>;
  hasOpenIssue?: boolean;
}

export const AssignmentDetailDrawer: React.FC<AssignmentDetailDrawerProps> = ({
  assignment,
  canActOnAssignments,
  actionBusy,
  actionError,
  onClearActionError,
  onTransition,
  onEscalate,
  askToComplete,
  planningLinkFor,
  confirm,
  confirmWithReason,
  hasOpenIssue,
}) => {
  const navigate = useNavigate();
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [actionMode, setActionMode] = useState<'REJECT' | 'CANCEL' | 'ESCALATE' | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [newComment, setNewComment] = useState('');
  const [reviewingExpenseId, setReviewingExpenseId] = useState<string | null>(null);

  const resetActionState = () => {
    setActionMode(null);
    setActionReason('');
    onClearActionError();
  };

  // Timeline query
  const timelineQuery = useQuery({
    queryKey: queryKeys.assignments.timeline(assignment?.id || ''),
    queryFn: () => api.request<TimelineEvent[]>(`/assignments/${assignment?.id}/timeline`),
    enabled: !!assignment?.id,
    staleTime: 15_000,
  });
  const { data: timeline = [], isLoading: isLoadingTimeline } = timelineQuery;

  // Expenses query
  const { data: expenses = [], refetch: refetchExpenses } = useQuery({
    queryKey: ['assignment-expenses', assignment?.id],
    queryFn: () => api.request<any[]>(`/assignments/${assignment?.id}/expenses`),
    enabled: !!assignment?.id,
  });

  const reviewExpense = async (expenseId: string, approve: boolean) => {
    let notes: string | undefined;
    if (!approve) {
      const { confirmed, reason } = await confirmWithReason({
        title: 'Reject this claim?',
        message: 'The assayer will see the reason and can correct the claim from it.',
        confirmLabel: 'Reject claim',
        reversible: true,
        reasonPrompt: {
          label: 'Why is this claim being rejected? The assayer will see this.',
          placeholder: 'e.g. Fuel bill is for a branch this assignment never visited',
        },
      });
      if (!confirmed) return;
      notes = reason;
    }
    setReviewingExpenseId(expenseId);
    try {
      await api.request(`/expenses/${expenseId}/review`, {
        method: 'POST',
        body: JSON.stringify({ approve, notes }),
      });
      await refetchExpenses();
      onClearActionError();
    } catch {
      // Handled upstream or silently flagged
    } finally {
      setReviewingExpenseId(null);
    }
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignment?.id || !newComment.trim()) return;
    try {
      await api.request(`/assignments/${assignment.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ comment: newComment }),
      });
      setNewComment('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments.timeline(assignment.id) });
    } catch {
      // comment error
    }
  };

  if (!assignment) {
    return (
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
    );
  }

  // Arrival, departure and the span between them, read once for the whole panel.
  const attendance = readAttendance(assignment);

  const canAcceptOffer = assignment.status === 'PENDING';
  const canComplete = ['ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'].includes(assignment.status);
  const canCancel = ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'].includes(assignment.status);
  const canReassign = ['REJECTED', 'CANCELLED'].includes(assignment.status);
  const canEscalate = assignment.priority !== 'CRITICAL';
  const hasMore = canAcceptOffer || canCancel || canReassign || canEscalate;

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

  const formatEventTime = (ts: string): string =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
      'CHECKED_IN': 'var(--accent)',
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

  return (
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
            <h4 style={{ fontSize: '14px', fontWeight: 700, margin: '1px 0' }}>{assignment.assignmentNumber}</h4>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {/* 1. Branch Workflow Status */}
            <StatusBadge
              domain="branch"
              status={assignment.projectBranch?.status || 'SCHEDULED'}
              size="md"
            />
            {/* 2. Assignment Execution Status */}
            <StatusBadge
              domain="assignment"
              status={assignment.status}
              size="md"
            />
            {/* 3. Operational Attention State */}
            <StatusBadge
              domain="attention"
              status={computeAssignmentAttention(assignment, undefined, hasOpenIssue)}
              variant="tag"
              size="md"
            />
            {assignment.status === 'REJECTED' && assignment.rejectReason === 'AUTO_DECLINED_SLA_EXPIRED' && (
              <StatusBadge label="Auto-declined" category="pending" icon={<Hourglass size={11} />} variant="tag" />
            )}
            {(assignment.priority === 'CRITICAL' || assignment.priority === 'HIGH') && (
              <StatusBadge
                label={assignment.priority === 'CRITICAL' ? 'Escalated — act today' : 'Urgent'}
                category={assignment.priority === 'CRITICAL' ? 'danger' : 'pending'}
                icon={<Flame size={11} />}
                variant="tag"
              />
            )}
          </div>
        </div>
      </div>

      {/* Lifecycle actions */}
      {canActOnAssignments && assignment.status !== 'COMPLETED' && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '10px', background: 'var(--bg-surface-2)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {canAcceptOffer && (
                <button
                  onClick={async () => {
                    if (await confirm({
                      title: 'Accept this offer?',
                      message: 'This commits the assayer to the assignment.',
                      confirmLabel: 'Accept offer',
                      reversible: true,
                    })) {
                      await onTransition('ACCEPTED');
                    }
                  }}
                  disabled={actionBusy}
                  className="btn btn-primary"
                  style={{
                    padding: '8px 16px', minHeight: 'var(--touch-target-min)', fontSize: '13px',
                    fontWeight: 700, background: 'var(--success)', borderColor: 'var(--success)',
                  }}
                >
                  ✓ Accept Offer
                </button>
              )}
              {canComplete && (
                <button
                  onClick={async () => {
                    const answer = await askToComplete(!!assignment.checkedInAt, !!assignment.checkedOutAt);
                    if (answer) {
                      await onTransition('COMPLETED', answer.reason);
                    }
                  }}
                  disabled={actionBusy}
                  className="btn btn-primary"
                  style={{
                    padding: '8px 16px', minHeight: 'var(--touch-target-min)', fontSize: '13px',
                    fontWeight: 700, background: 'var(--success)', borderColor: 'var(--success)',
                  }}
                >
                  ✓ Mark Audit Complete
                </button>
              )}
              {canReassign && !canAcceptOffer && !canComplete && (
                <button
                  onClick={() => navigate(planningLinkFor(assignment))}
                  className="btn btn-primary"
                  style={{ padding: '8px 16px', minHeight: 'var(--touch-target-min)', fontSize: '13px', fontWeight: 700 }}
                >
                  🔄 Reassign Branch →
                </button>
              )}
              {hasMore && (
                <button
                  onClick={() => setShowMoreActions(v => !v)}
                  disabled={actionBusy}
                  className="btn btn-secondary"
                  style={{ padding: '8px 12px', minHeight: 'var(--touch-target-min)', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginLeft: 'auto' }}
                  aria-expanded={showMoreActions}
                >
                  More {showMoreActions ? '▲' : '▼'}
                </button>
              )}
            </div>
            {showMoreActions && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', padding: '8px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)', border: '1px solid var(--border-hair)' }}>
                {canAcceptOffer && (
                  <button onClick={() => setActionMode('REJECT')} disabled={actionBusy} className="btn btn-secondary" style={{ padding: '6px 12px', minHeight: '36px', fontSize: '12px', fontWeight: 700, color: 'var(--danger)', borderColor: 'var(--status-cancelled-bg)' }}>
                    ✕ Reject Offer
                  </button>
                )}
                {canCancel && (
                  <button onClick={() => setActionMode('CANCEL')} disabled={actionBusy} className="btn btn-secondary" style={{ padding: '6px 12px', minHeight: '36px', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    🚫 Cancel Assignment
                  </button>
                )}
                {canReassign && (canAcceptOffer || canComplete) && (
                  <button onClick={() => navigate(planningLinkFor(assignment))} className="btn btn-secondary" style={{ padding: '6px 12px', minHeight: '36px', fontSize: '12px', fontWeight: 700 }}>
                    🔄 Reassign Branch →
                  </button>
                )}
                {canEscalate && (
                  <button onClick={() => setActionMode('ESCALATE')} disabled={actionBusy} className="btn btn-secondary" style={{ padding: '6px 12px', minHeight: '36px', fontSize: '12px', fontWeight: 700, color: 'var(--warning)', borderColor: 'var(--status-pending-bg)' }}>
                    ⚠ Escalate
                  </button>
                )}
              </div>
            )}
          </div>

          {actionMode && (
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                placeholder={actionMode === 'REJECT' ? 'Reason for rejecting...' : actionMode === 'CANCEL' ? 'Reason for cancelling...' : 'Reason for escalating (what went wrong?)...'}
                style={{ flex: 1, padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '11.5px' }}
              />
              <button
                onClick={() => actionMode === 'ESCALATE'
                  ? onEscalate(actionReason || undefined)
                  : onTransition(actionMode === 'REJECT' ? 'REJECTED' : 'CANCELLED', actionReason || undefined)}
                disabled={actionBusy || ((actionMode === 'REJECT' || actionMode === 'CANCEL') && !actionReason.trim())}
                className="btn btn-primary"
                style={{ padding: '5px 10px', fontSize: '11px', background: actionMode === 'ESCALATE' ? 'var(--warning)' : 'var(--danger)', borderColor: actionMode === 'ESCALATE' ? 'var(--warning)' : 'var(--danger)' }}
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
          <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>
            {assignment.assayerId ? (
              <Link
                to={`/hr/roster/${encodeURIComponent(assignment.assayerId)}`}
                style={{ color: 'var(--accent-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                title="View Assayer 360 profile"
              >
                {assignment.assayer?.displayName || '—'}
                <ExternalLink size={10} />
              </Link>
            ) : (
              assignment.assayer?.displayName || '—'
            )}
          </p>
        </div>
        <div style={{ background: 'rgba(216,174,71,0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(216,174,71,0.15)' }}>
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Fee</span>
          <p style={{ fontSize: '14px', fontWeight: 800, margin: '1px 0', color: 'var(--warning)' }}>
            {assignmentFee(assignment)}
          </p>
        </div>
        <div style={{ background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid var(--status-active-bg)', gridColumn: 'span 2' }}>
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Branch / Project</span>
          <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>
            {assignment.projectBranch?.branch?.name}
            {assignment.projectBranch?.branch?.state && (
              <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> — {assignment.projectBranch.branch.state}</span>
            )}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '1px 0 0' }}>{assignment.project?.name}</p>
        </div>
        <div style={{ background: 'rgba(216,174,71,0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(216,174,71,0.15)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Calendar size={13} style={{ color: 'var(--accent)' }} />
          <div>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Scheduled</span>
            <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>{assignment.scheduledDate ? new Date(assignment.scheduledDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unscheduled'}</p>
          </div>
        </div>
        {/*
          Attendance on site: the arrival, the departure, and the span between them.

          Only the arrival used to be here, and `checkedOutAt` appeared nowhere in the frontend at
          all — so a visit that ended properly and a visit that simply stopped being recorded drew
          the same panel. Time on site is what a client dispute, a travel claim and a bank's audit
          file are read out of, so a missing departure is stated in words here rather than being
          left as an absence the reader has to notice.
        */}
        {attendance.arrival && (
          <div style={{ background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid var(--status-active-bg)', gridColumn: 'span 2' }}>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Attendance on site</span>
            <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>
              Checked in {formatAttendanceMoment(attendance.arrival)}
              {assignment.checkInDistanceMeters != null && (
                <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> · {assignment.checkInDistanceMeters < 1000 ? `${assignment.checkInDistanceMeters} m` : `${(assignment.checkInDistanceMeters / 1000).toFixed(1)} km`} from the branch</span>
              )}
              {assignment.checkInAccuracyMeters != null && (
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — phone accuracy ±{assignment.checkInAccuracyMeters} m</span>
              )}
            </p>
            {attendance.departure ? (
              <>
                <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: 'var(--text-primary)' }}>
                  Checked out {formatAttendanceMoment(attendance.departure)}
                  {assignment.checkOutDistanceMeters != null && (
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> · {assignment.checkOutDistanceMeters < 1000 ? `${assignment.checkOutDistanceMeters} m` : `${(assignment.checkOutDistanceMeters / 1000).toFixed(1)} km`} from the branch</span>
                  )}
                  {assignment.checkOutAccuracyMeters != null && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — phone accuracy ±{assignment.checkOutAccuracyMeters} m</span>
                  )}
                </p>
                <p style={{ fontSize: '12px', fontWeight: 800, margin: '3px 0 1px', color: 'var(--success)' }}>
                  {attendance.durationLabel} on site
                </p>
              </>
            ) : (
              <div style={{ marginTop: '4px', padding: '6px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--status-pending-bg)', border: '1px solid var(--warning)' }}>
                <p style={{ fontSize: '11.5px', fontWeight: 700, margin: 0, color: 'var(--warning)' }}>
                  No check-out recorded — time on site unknown
                </p>
                <p style={{ fontSize: '10.5px', margin: '2px 0 0', color: 'var(--text-secondary)' }}>
                  {attendance.gapReason
                    ? `Closed without a departure. Reason given: “${attendance.gapReason}”`
                    : assignment.status === 'COMPLETED'
                      ? 'This audit was completed before a departure was required, so no reason was recorded.'
                      : 'The assayer has not checked out of this branch yet.'}
                </p>
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '3px' }}>
              {assignment.checkInLatitude != null && assignment.checkInLongitude != null && (
                <a
                  href={`https://www.google.com/maps?q=${assignment.checkInLatitude},${assignment.checkInLongitude}`}
                  target="_blank" rel="noreferrer"
                  style={{ fontSize: '10.5px', color: 'var(--accent)', textDecoration: 'none' }}
                >
                  Arrival on map ↗
                </a>
              )}
              {assignment.checkOutLatitude != null && assignment.checkOutLongitude != null && (
                <a
                  href={`https://www.google.com/maps?q=${assignment.checkOutLatitude},${assignment.checkOutLongitude}`}
                  target="_blank" rel="noreferrer"
                  style={{ fontSize: '10.5px', color: 'var(--accent)', textDecoration: 'none' }}
                >
                  Departure on map ↗
                </a>
              )}
            </div>
          </div>
        )}
        {/*
          No arrival at all. Previously drew nothing whatever, so the panel for a job closed on
          somebody's word was indistinguishable from one nobody had looked at — and the reason the
          desk was made to state at completion was stored and then never shown to anyone.
        */}
        {!attendance.arrival && assignment.status === 'COMPLETED' && (
          <div style={{ background: 'var(--status-pending-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid var(--warning)', gridColumn: 'span 2' }}>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Attendance on site</span>
            <p style={{ fontSize: '11.5px', fontWeight: 700, margin: '1px 0', color: 'var(--warning)' }}>
              No check-in recorded — this audit was closed without attendance evidence
            </p>
            <p style={{ fontSize: '10.5px', margin: '2px 0 0', color: 'var(--text-secondary)' }}>
              {attendance.gapReason
                ? `Reason given: “${attendance.gapReason}”`
                : 'No reason was recorded against this completion.'}
            </p>
          </div>
        )}
        <div style={{ background: 'var(--status-pending-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid var(--status-pending-bg)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ExternalLink size={13} style={{ color: 'var(--warning)' }} />
          <div>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Quick Links</span>
            <div style={{ display: 'flex', gap: '4px', marginTop: '1px' }}>
              <button onClick={() => navigate(planningLinkFor(assignment))} className="btn btn-secondary" style={{ padding: '1px 6px', fontSize: '9px', background: 'var(--border-hair)' }}>Planning</button>
              <button onClick={() => navigate(`/scheduling?assignmentId=${assignment.id}`)} className="btn btn-secondary" style={{ padding: '1px 6px', fontSize: '9px', background: 'var(--border-hair)' }}>Schedule</button>
            </div>
          </div>
        </div>
      </div>

      {/* Money card */}
      <AssignmentMoneyCard assignmentId={assignment.id} status={String(assignment.status)} canEdit={canActOnAssignments} />

      {/* Expense claims */}
      {expenses.length > 0 && (
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.3px' }}>
            EXPENSE CLAIMS ({expenses.length})
          </span>
          {expenses.map((e: any) => {
            const pending = e.status === 'PENDING';
            const tone = e.status === 'APPROVED' ? 'var(--success)' : e.status === 'REJECTED' ? 'var(--danger)' : 'var(--warning)';
            return (
              <div key={e.id} style={{
                display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                background: 'var(--bg-surface-2)', border: '1px solid var(--border-hair)',
                borderRadius: 'var(--radius-sm)', padding: '7px 9px',
              }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>₹{Number(e.amount).toLocaleString()}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{anyStatusLabel(e.category)}</span>
                {e.description && <span style={{ fontSize: '10px', color: 'var(--text-secondary)', flex: 1, minWidth: 0 }}>{e.description}</span>}
                <span style={{ fontSize: '9px', fontWeight: 700, color: tone }}>{anyStatusLabel(e.status)}</span>
                {pending && canActOnAssignments && (
                  <span style={{ display: 'flex', gap: '4px' }}>
                    <button onClick={() => reviewExpense(e.id, true)} disabled={reviewingExpenseId === e.id}
                      className="btn btn-primary" style={{ padding: '2px 8px', fontSize: '9.5px' }}>Approve</button>
                    <button onClick={() => reviewExpense(e.id, false)} disabled={reviewingExpenseId === e.id}
                      className="btn btn-secondary" style={{ padding: '2px 8px', fontSize: '9.5px', color: 'var(--danger)' }}>Reject</button>
                  </span>
                )}
                {!pending && e.reviewNotes && (
                  <span style={{ fontSize: '9.5px', color: 'var(--text-muted)', width: '100%' }}>Note: {e.reviewNotes}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

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
        {/* A refused or failed timeline used to be indistinguishable from an untouched
            assignment: "No timeline events yet — Events will appear here as the assignment
            progresses." That is what somebody reads before concluding nobody has done anything,
            on the record of what was actually done and when. */}
        {loadFailed(timelineQuery) ? (
          <LoadFailure loads={[{ label: "this assignment's timeline", query: timelineQuery }]} />
        ) : isLoadingTimeline ? (
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

                  <div style={{ position: 'relative', paddingLeft: '28px' }}>
                    <div style={{
                      position: 'absolute', left: '13px', top: '8px', bottom: '8px',
                      width: '2px', background: 'var(--border-color)',
                      borderRadius: '1px',
                    }} />
                    {group.events.map((evt, idx) => {
                      const accent = getEventAccent(evt.type);
                      return (
                        <div key={idx} style={{ position: 'relative', marginBottom: idx < group.events.length - 1 ? '10px' : 0 }}>
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
                          <div style={{
                            background: accent.bg,
                            border: `1px solid ${accent.border}`,
                            borderRadius: 'var(--radius-sm)',
                            padding: '8px 10px',
                            fontSize: '12px',
                            transition: 'all 0.2s ease',
                            cursor: 'default',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{
                                  display: 'inline-block', padding: '1px 6px',
                                  fontSize: '9px', fontWeight: 700, letterSpacing: '0.3px',
                                  borderRadius: 'var(--radius-full)',
                                  background: accent.color + '20',
                                  color: accent.color,
                                }}>
                                  {activityEventLabel(evt.type)}
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
            minHeight: '36px',
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
  );
};
