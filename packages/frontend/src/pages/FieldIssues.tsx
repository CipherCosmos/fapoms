import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Flag, AlertTriangle, Lock, CalendarClock, HelpCircle, MoreHorizontal, ChevronRight, CheckCircle2, Inbox } from 'lucide-react';
import { assignmentStatusLabel } from '@fapoms/shared';
import { api } from '../services/api';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope } from '../context/ScopeContext';
import { StatusBadge } from '../components/ui';

interface FieldIssue {
  id: string;
  reportedAt: string;
  assignmentId: string;
  assignmentNumber: string | null;
  branchName: string | null;
  assayerName: string | null;
  category: string | null;
  categoryLabel: string | null;
  note: string;
  assignmentStatus: string | null;
  open: boolean;
}

const CATEGORY_ICON: Record<string, React.ComponentType<any>> = {
  CANNOT_ATTEND: CalendarClock,
  BRANCH_INACCESSIBLE: Lock,
  NEEDS_CLARIFICATION: HelpCircle,
  SAFETY_CONCERN: AlertTriangle,
  OTHER: MoreHorizontal,
};

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

/**
 * Field issues — the desk's queue of problems assayers have flagged from the app.
 *
 * The field app cannot cancel or reassign work; an assayer flags a problem and the desk acts.
 * Before this the flag only arrived as a transient notification and a line in the assignment's
 * timeline, so a "can't attend today" could scroll past unseen. This surfaces them in one place.
 *
 * There is no resolve button by design: an issue is "open" only while its assignment is still
 * actionable. When the desk reassigns, reschedules or cancels the job from the card's link, the
 * issue moves itself to Handled — the assignment's own state is the source of truth.
 */
export const FieldIssues: React.FC = () => {
  const navigate = useNavigate();

  const { scopeParams, scopeKey } = useScope();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...queryKeys.assignments.fieldIssues, scopeKey],
    queryFn: () => api.request<FieldIssue[]>(`/assignments/field-issues?${withScope(scopeParams)}`),
    // Cheap safety net on top of the socket invalidation, since this is a queue people watch.
    refetchInterval: 60_000,
  });
  const issues: FieldIssue[] = (Array.isArray(data) ? data : (data as any)?.data) || [];
  const open = issues.filter((i) => i.open);
  const handled = issues.filter((i) => !i.open);

  const Card: React.FC<{ issue: FieldIssue; muted?: boolean }> = ({ issue, muted }) => {
    const Icon = CATEGORY_ICON[issue.category ?? 'OTHER'] ?? Flag;
    return (
      <div
        onClick={() => navigate(`/assignments?id=${issue.assignmentId}`)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px',
          borderRadius: '10px', border: '1px solid var(--border-color)', cursor: 'pointer',
          background: muted ? 'transparent' : 'var(--status-pending-bg)', opacity: muted ? 0.65 : 1,
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: muted ? 'var(--border-hair)' : 'rgba(216,174,71,0.15)', color: muted ? 'var(--text-muted)' : 'var(--accent)',
        }}>
          <Icon size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '14px' }}>
              {issue.categoryLabel ?? 'Issue'}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {issue.branchName || issue.assignmentNumber || 'Assignment'}
            </span>
            {issue.assignmentStatus && (
              <StatusBadge label={assignmentStatusLabel(issue.assignmentStatus)} bg="var(--border-hair)" color="var(--text-secondary)" />
            )}
          </div>
          {issue.note ? (
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 3 }}>{issue.note}</div>
          ) : null}
          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: 4 }}>
            {issue.assayerName || 'Assayer'} · {timeAgo(issue.reportedAt)}
          </div>
        </div>
        <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: '9px' }} />
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Flag style={{ color: 'var(--accent)' }} /> Field Issues
        </h2>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Problems assayers flagged from the field. Open one to reassign, reschedule or cancel — that clears it.
        </span>
      </div>

      {isLoading ? (
        <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      ) : isError ? (
        <div className="glass-card" style={{ padding: '32px', textAlign: 'center' }}>
          <Flag size={36} style={{ margin: '0 auto 12px', opacity: 0.5, color: 'var(--danger)' }} />
          <p style={{ fontWeight: 700, color: 'var(--danger)' }}>Couldn’t load field issues.</p>
          <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '4px 0 14px' }}>
            This queue could not be reached — it is <strong>not</strong> confirmation that there are none.
          </p>
          <button onClick={() => refetch()} className="btn btn-secondary" style={{ fontSize: 12.5 }}>Retry</button>
        </div>
      ) : issues.length === 0 ? (
        <div className="glass-card" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <Inbox size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
          <p style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>No field issues reported.</p>
          <p style={{ fontSize: '12.5px' }}>Anything an assayer flags from the app will appear here.</p>
        </div>
      ) : (
        <>
          <div className="glass-card" style={{ padding: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>Needs attention</span>
              <span style={{ fontSize: '11px', fontWeight: 700, padding: '1px 8px', borderRadius: '999px', background: open.length ? 'var(--danger)' : 'var(--border-hair)', color: open.length ? '#fff' : 'var(--text-muted)' }}>
                {open.length}
              </span>
            </div>
            {open.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)', fontSize: '13px', padding: '8px 0' }}>
                <CheckCircle2 size={16} /> Nothing open — every flagged issue has been actioned.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {open.map((i) => <Card key={i.id} issue={i} />)}
              </div>
            )}
          </div>

          {handled.length > 0 && (
            <div className="glass-card" style={{ padding: '18px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '12px' }}>
                Handled <span style={{ fontWeight: 500 }}>· the assignment was reassigned, cancelled or completed</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {handled.map((i) => <Card key={i.id} issue={i} muted />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default FieldIssues;
