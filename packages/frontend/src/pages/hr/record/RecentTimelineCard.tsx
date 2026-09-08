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
          <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>
            Recent Activity & Audit
          </h3>
        </div>
        {onViewAll && events.length > 5 && (
          <button
            type="button"
            onClick={onViewAll}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '12px',
              color: 'var(--accent-primary)',
              cursor: 'pointer',
              padding: 0,
              fontWeight: 500,
            }}
          >
            View all ({events.length})
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '12px 0' }}>
          Loading confirmed activity…
        </div>
      ) : recent.length === 0 ? (
        <div
          style={{
            padding: '14px',
            borderRadius: '8px',
            background: 'var(--bg-surface-2)',
            border: '1px dashed var(--border-hair)',
            textAlign: 'center',
            fontSize: '12.5px',
            color: 'var(--text-muted)',
          }}
        >
          No confirmed activity recorded yet. Audit events appear only after server verification.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {recent.map((ev) => (
            <div
              key={ev.id}
              style={{
                paddingBottom: '10px',
                borderBottom: '1px solid var(--border-hair)',
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {activityEventLabel(ev.eventType)}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '3px' }}>
                  <Clock size={11} />
                  {fmtWhen(ev.occurredAt)}
                </span>
              </div>

              {(ev.previousState || ev.newState) && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>{assayerLifecycleLabel(ev.previousState || '')}</span>
                  <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />
                  <strong>{assayerLifecycleLabel(ev.newState || '')}</strong>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
                <User size={11} />
                <span>{ev.performedByName || 'System'}</span>
              </div>

              {ev.remarks && (
                <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', padding: '4px 8px', borderRadius: '4px', marginTop: '2px' }}>
                  {ev.remarks}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
