import React, { useState } from 'react';

export interface ColumnSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface ColumnDatum {
  key: string;
  label: string;
  sublabel?: string;
  /** Bottom-to-top stacking order. */
  segments: ColumnSegment[];
}

/**
 * A short time axis (days out, weeks) with a composition stacked at each point — the shape
 * of the week, not just a list of dates. Each column is capped at 24px and anchored to one
 * shared baseline; the total rides the cap since there are few enough columns (a look-ahead
 * window, never an unbounded range) for every one to carry its number without becoming noise.
 */
export const StackedColumnChart: React.FC<{
  data: ColumnDatum[];
  legend: { key: string; label: string; color: string }[];
  chartHeight?: number;
}> = ({ data, legend, chartHeight = 110 }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const totals = data.map((d) => d.segments.reduce((s, seg) => s + Math.max(seg.value, 0), 0));
  const max = Math.max(1, ...totals);

  return (
    <div>
      {legend.length > 1 && (
        <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
          {legend.map((l) => (
            <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: l.color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{l.label}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
        {data.map((d, i) => {
          const total = totals[i];
          const lastNonZeroIdx = (() => {
            for (let j = d.segments.length - 1; j >= 0; j--) if (d.segments[j].value > 0) return j;
            return -1;
          })();
          return (
            <div
              key={d.key}
              style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
              onMouseEnter={() => setHovered(d.key)}
              onMouseLeave={() => setHovered(null)}
            >
              {hovered === d.key && (
                <div role="tooltip" style={{
                  position: 'absolute', bottom: '100%', marginBottom: 6, zIndex: 5,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)',
                  padding: '7px 10px', fontSize: 11, whiteSpace: 'nowrap', pointerEvents: 'none',
                }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{d.label}</strong>
                  {d.segments.filter((s) => s.value > 0).map((s) => (
                    <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 1.5, background: s.color, flexShrink: 0 }} />
                      <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{s.value}</span>
                    </div>
                  ))}
                  {total === 0 && <div style={{ color: 'var(--text-muted)', marginTop: 3 }}>Nothing scheduled</div>}
                </div>
              )}

              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, height: 14 }}>
                {total > 0 ? total : ''}
              </div>

              <div style={{
                width: '100%', maxWidth: 26, height: chartHeight,
                display: 'flex', flexDirection: 'column-reverse', gap: 2,
              }}>
                {d.segments.map((seg, j) => {
                  const h = total > 0 || max > 0 ? (Math.max(seg.value, 0) / max) * chartHeight : 0;
                  const isTop = j === lastNonZeroIdx;
                  return seg.value > 0 ? (
                    <div key={seg.key} style={{
                      width: '100%', height: Math.max(h, 2), background: seg.color,
                      borderRadius: isTop ? '4px 4px 0 0' : 0,
                      filter: hovered === d.key ? 'brightness(1.1)' : 'none',
                      transition: 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1), filter 0.15s',
                    }} />
                  ) : null;
                })}
                {total === 0 && (
                  <div style={{ width: '100%', height: 2, background: 'var(--bg-tertiary)', borderRadius: 1 }} />
                )}
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', width: '100%', marginTop: 2 }} />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 5, textAlign: 'center', lineHeight: 1.3 }}>
                {d.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
