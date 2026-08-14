import React, { useState } from 'react';

export interface HBarDatum {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Shown small and muted under the label — e.g. a packet count riding alongside the branch count. */
  sublabel?: string;
  /** Overrides the plain `value.toLocaleString()` shown at the bar's tip. */
  formattedValue?: string;
  /** Extra line shown only in the hover tooltip, for detail that doesn't fit the row itself. */
  tooltipDetail?: string;
  onClick?: () => void;
}

/**
 * Ranked horizontal bar chart — one value per named category, longest-to-compare-by-eye
 * rather than read off a list of numbers. Each bar carries its own color and its category
 * label sits directly beside it, so this never needs a legend (see dataviz mark spec: a
 * legend is for shared series on one axis, not one color per already-labeled row).
 *
 * Bars share one baseline and one `max`, are capped at 22px thick with a rounded data-end,
 * and the value rides the tip rather than fighting with text-fit-inside-the-fill.
 */
export const HBarChart: React.FC<{
  data: HBarDatum[];
  /** Defaults to the largest value in `data`; pass one to compare against a fixed ceiling (e.g. total capacity). */
  maxValue?: number;
  barHeight?: number;
  valueColumnWidth?: number;
}> = ({ data, maxValue, barHeight = 20, valueColumnWidth = 96 }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = maxValue ?? Math.max(1, ...data.map((d) => d.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {data.map((d) => {
        // A non-zero value stays visible even at a tiny fraction of max — a 2px sliver reads as "empty".
        const pct = d.value > 0 ? Math.max((d.value / max) * 100, 3) : 0;
        const isHovered = hovered === d.key;
        return (
          <div
            key={d.key}
            style={{ position: 'relative' }}
            onMouseEnter={() => setHovered(d.key)}
            onMouseLeave={() => setHovered(null)}
          >
            {isHovered && (d.tooltipDetail || d.sublabel) && (
              <div
                role="tooltip"
                style={{
                  position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 5,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)',
                  padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap', pointerEvents: 'none',
                }}
              >
                <strong style={{ color: 'var(--text-primary)' }}>{d.label}</strong>
                <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
                  {d.tooltipDetail ?? d.sublabel}
                </div>
              </div>
            )}
            <div
              onClick={d.onClick}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                cursor: d.onClick ? 'pointer' : 'default',
              }}
            >
              <div style={{ width: 128, flexShrink: 0, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {d.label}
                </div>
                {d.sublabel && (
                  <div style={{
                    fontSize: 10, color: 'var(--text-muted)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {d.sublabel}
                  </div>
                )}
              </div>
              <div style={{
                flex: 1, height: barHeight, background: 'var(--bg-tertiary)',
                borderRadius: 4, overflow: 'hidden', position: 'relative',
              }}>
                <div style={{
                  height: '100%', width: `${pct}%`, background: d.color, borderRadius: 4,
                  transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1), filter 0.15s',
                  filter: isHovered ? 'brightness(1.12)' : 'none',
                }} />
              </div>
              <div style={{
                width: valueColumnWidth, flexShrink: 0, textAlign: 'right',
                fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {d.formattedValue ?? d.value.toLocaleString('en-IN')}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
