import React from 'react';
import { ROSTER_SEGMENTS, type RosterPerson } from '../roster-filters';

export interface RosterSegmentTabsProps {
  currentSegmentKey: string;
  onSelectSegment: (segmentKey: string) => void;
  rows: RosterPerson[];
  exactCounts?: Partial<Record<string, number | undefined>>;
}

export const RosterSegmentTabs: React.FC<RosterSegmentTabsProps> = ({
  currentSegmentKey,
  onSelectSegment,
  rows,
  exactCounts,
}) => {
  const activeSegment = ROSTER_SEGMENTS.find((s) => s.key === currentSegmentKey) ?? ROSTER_SEGMENTS[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div
        role="tablist"
        aria-label="Roster segments and operational queues"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          overflowX: 'auto',
          paddingBottom: '4px',
          scrollbarWidth: 'thin',
        }}
      >
        {ROSTER_SEGMENTS.map((segment) => {
          const isSelected = segment.key === currentSegmentKey;
          // Count source: exactCounts from backend overview aggregate if provided, otherwise compute from loaded rows
          const count = exactCounts?.[segment.key] ?? rows.filter((r) => segment.match(r)).length;

          // Hide empty operational queue chips unless selected or it's a permanent population chip
          if (segment.queue && count === 0 && !isSelected) {
            return null;
          }

          return (
            <button
              key={segment.key}
              role="tab"
              id={`tab-${segment.key}`}
              aria-selected={isSelected}
              aria-controls="roster-table-panel"
              onClick={() => onSelectSegment(segment.key)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                borderRadius: '20px',
                fontSize: '12.5px',
                fontWeight: isSelected ? 600 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                border: isSelected
                  ? '1px solid var(--accent)'
                  : '1px solid var(--border-color)',
                background: isSelected
                  ? 'var(--status-active-bg, color-mix(in srgb, var(--accent) 12%, transparent))'
                  : 'var(--bg-card)',
                color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                transition: 'all 0.15s ease',
              }}
            >
              <span>{segment.label}</span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: '10px',
                  background: isSelected ? 'var(--accent)' : 'var(--bg-muted, rgba(128,128,128,0.15))',
                  color: isSelected ? '#fff' : 'var(--text-muted)',
                }}
              >
                {count.toLocaleString('en-IN')}
              </span>
            </button>
          );
        })}
      </div>

      {activeSegment.hint && (
        <div
          style={{
            fontSize: '12.5px',
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'var(--bg-muted, rgba(128,128,128,0.06))',
            borderLeft: '3px solid var(--accent)',
          }}
        >
          {activeSegment.hint}
        </div>
      )}
    </div>
  );
};
