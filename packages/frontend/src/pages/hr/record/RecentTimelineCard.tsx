import React from 'react';
import { History, Clock, ArrowRight, User } from 'lucide-react';
import { activityEventLabel, assayerLifecycleLabel } from '@fapoms/shared';
import { fmtWhen } from '../../../utils/dates';

export interface TimelineEvent {
  id: string;
  eventType: string;
  previousState?: string | null;
  newState?: string | null;
  performedByName?: string | null;
  occurredAt: string;
  remarks?: string | null;
}

interface RecentTimelineCardProps {
  events: TimelineEvent[];
  loading?: boolean;
  onViewAll?: () => void;
}

/** One recorded event — shared by this card and the History tab so the two read the same. */
export const TimelineRow: React.FC<{ event: TimelineEvent }> = ({ event: ev }) => (
  <div
    style={{
      paddingBottom: '10px',
      borderBottom: '1px solid var(--border-hair)',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
        {activityEventLabel(ev.eventType)}
      </span>
      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '3px' }}>
        <Clock size={11} />
        {fmtWhen(ev.occurredAt)}
      </span>
    </div>

    {(ev.previousState || ev.newState) && (
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span>{assayerLifecycleLabel(ev.previousState || '')}</span>
        <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />
        <strong>{assayerLifecycleLabel(ev.newState || '')}</strong>
      </div>
    )}

    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
      <User size={11} />
      <span>{ev.performedByName || 'System'}</span>
    </div>

    {ev.remarks && (
      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', padding: '4px 8px', borderRadius: '4px', marginTop: '2px' }}>
        {ev.remarks}
      </div>
    )}
  </div>
);

export const RecentTimelineCard: React.FC<RecentTimelineCardProps> = ({
  events,
  loading = false,
  onViewAll,
}) => {
  const recent = events.slice(0, 5);

  return (
    <section
      data-testid="recent-timeline-card"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <History size={16} style={{ color: 'var(--text-secondary)' }} />
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
            Recent activity
          </h3>
        </div>
        {onViewAll && events.length > 5 && (
          <button
            type="button"
            onClick={onViewAll}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 'var(--text-xs)',
              color: 'var(--accent-primary)',
              cursor: 'pointer',
              padding: 0,
              fontWeight: 500,
            }}
          >
            See full history ({events.length})
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: '12px 0' }}>
          Loading…
        </div>
      ) : recent.length === 0 ? (
        <div
          style={{
            padding: '14px',
            borderRadius: '8px',
            background: 'var(--bg-surface-2)',
            border: '1px dashed var(--border-hair)',
            textAlign: 'center',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-muted)',
          }}
        >
          Nothing has been recorded for this person yet.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            maxHeight: '240px',
            overflowY: 'auto',
            paddingRight: '4px',
            scrollbarWidth: 'thin',
          }}
        >
          {recent.map((ev) => <TimelineRow key={ev.id} event={ev} />)}
        </div>
      )}
    </section>
  );
};
