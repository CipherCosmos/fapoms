import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw, CheckCircle2, MapPin, UserX, CalendarClock, ArrowRightCircle } from 'lucide-react';
import { api } from '../services/api';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope } from '../context/ScopeContext';
import { useSocketConnection } from '../hooks/useSocketConnection';
import { counted } from '../utils/plural';
import { AlertBanner } from '../components/ui';

/**
 * "Falling behind" — the chase list.
 *
 * The SLA machinery has always flagged overdue work (slaStatus / slaDueDate, the 15-minute
 * scanner, the auto-decline of expired offers) but nothing ever rendered it, so a breach only
 * became visible if someone happened to open the exact assignment. This board is the missing
 * screen: every assignment past a deadline or its audit date, most-overdue first, never dropping
 * off until it is resolved. The server ranks; this only reads and points at the next step.
 */

interface FallingBehindItem {
  id: string;
  assignmentNumber: string;
  status: string;
  projectId: string | null;
  projectBranchId: string | null;
  branchId: string | null;
  branchName: string | null;
  branchCity: string | null;
  projectName: string | null;
  clientName: string | null;
  assayerId: string | null;
  assayerName: string | null;
  scheduledDate: string | null;
  slaDueDate: string | null;
  daysOverdue: number;
  slaState: string;
  nextAction: 'OPEN' | 'REASSIGN' | 'RESCHEDULE';
}

/** Plain-language "how late" — never a raw day count at zero, which reads as "not late". */
const overdueText = (days: number) =>
  days <= 0 ? 'slipped today' : counted(days, 'day') + ' overdue';

const ACTION_LABEL: Record<FallingBehindItem['nextAction'], string> = {
  OPEN: 'Open',
  REASSIGN: 'Find another assayer',
  RESCHEDULE: 'Reschedule',
};

export const FallingBehind: React.FC = () => {
  const navigate = useNavigate();
  const { scopeParams, scopeKey } = useScope();
  const scopeQuery = withScope(scopeParams);
  const live = useSocketConnection();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: [...queryKeys.desk.fallingBehind, scopeKey],
    queryFn: () => api.request<FallingBehindItem[]>(`/assignments/falling-behind?${scopeQuery}`),
    staleTime: 20_000,
    // The Layout's socket invalidation refreshes this on every assignment event; the poll is only
    // a fallback for when the realtime channel is down.
    refetchInterval: live ? false : 60_000,
  });

  const items = data ?? [];

  /** Route each row to where its next step actually happens — no new mutations on this board. */
  const goToAction = (item: FallingBehindItem) => {
    if (item.nextAction === 'RESCHEDULE') {
      navigate(`/scheduling?assignmentId=${item.id}`);
      return;
    }
    if (item.nextAction === 'REASSIGN') {
      // The planning workspace, opened on this exact branch, is where a replacement is offered.
      const params = new URLSearchParams();
      if (item.projectId) params.set('projectId', item.projectId);
      if (item.projectBranchId) params.set('branchId', item.projectBranchId);
      const qs = params.toString();
      navigate(qs ? `/planning?${qs}` : '/planning');
      return;
    }
    navigate(`/assignments?id=${item.id}`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '0 8px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px' }}>Falling behind</h1>
          <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
            Everything past a deadline or its audit date, most overdue first. Nothing here drops off
            until it is dealt with.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {items.length > 0 && (
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--danger)' }}>
              {counted(items.length, 'item')} to chase
            </span>
          )}
          <button onClick={() => refetch()} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RefreshCw size={14} className={isFetching ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </div>

      {isError && (
        <AlertBanner type="error">
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            Could not load the board.
            <button onClick={() => refetch()} className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: '11px' }}>Retry</button>
          </span>
        </AlertBanner>
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
          <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} /> Loading the board…
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <CheckCircle2 size={34} style={{ opacity: 0.6, marginBottom: 10, color: 'var(--success)' }} />
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Nothing overdue — everything is on track.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {items.map((item) => {
            const ActionIcon = item.nextAction === 'REASSIGN' ? UserX : item.nextAction === 'RESCHEDULE' ? CalendarClock : ArrowRightCircle;
            return (
              <div key={item.id} className="glass-card" style={{
                padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: '14px', flexWrap: 'wrap', borderLeft: '3px solid var(--danger)',
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {item.branchName || item.assignmentNumber}
                    {item.branchCity && <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>· {item.branchCity}</span>}
                    <span style={{
                      fontSize: '10px', fontWeight: 800, padding: '1px 8px', borderRadius: '8px',
                      background: 'var(--status-cancelled-bg)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: '4px',
                    }}>
                      <AlertTriangle size={10} /> {overdueText(item.daysOverdue)}
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <span>{item.assignmentNumber}</span>
                    {item.projectName && <span>{item.projectName}</span>}
                    {item.clientName && <span>{item.clientName}</span>}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <MapPin size={11} />
                      {item.assayerName ? <b style={{ color: 'var(--text-secondary)' }}>{item.assayerName}</b> : 'Unassigned'}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-primary)', marginTop: '4px', fontWeight: 600 }}>
                    {item.slaState}
                    {item.scheduledDate && item.nextAction === 'RESCHEDULE' && (
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · was due {item.scheduledDate}</span>
                    )}
                  </div>
                </div>
                <button onClick={() => goToAction(item)} className="btn btn-primary"
                  style={{ padding: '6px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  <ActionIcon size={13} /> {ACTION_LABEL[item.nextAction]}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default FallingBehind;
