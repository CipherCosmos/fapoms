import React, { useState } from 'react';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
  formattedValue?: string;
  onClick?: () => void;
}

/**
 * Part-to-whole composition — how a queue or a workforce splits across a small number of
 * named states. The center carries one chosen headline figure (often not itself a segment,
 * e.g. daily capacity while the ring shows idle vs loaded) rather than always repeating the
 * segment total, since the most useful number to lead with isn't always "how many rows".
 *
 * A legend always renders below (≥2 segments), each row keyed by a short color stroke —
 * identity never rides on the ring alone.
 */
export const DonutChart: React.FC<{
  segments: DonutSegment[];
  centerLabel: string;
  centerValue: string;
  size?: number;
  thickness?: number;
}> = ({ segments, centerLabel, centerValue, size = 132, thickness = 16 }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = segments.reduce((s, seg) => s + Math.max(seg.value, 0), 0);
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const GAP = 3; // surface-color separation between adjoining arcs

  let offset = 0;
  const arcs = segments.map((seg) => {
    const fraction = total > 0 ? Math.max(seg.value, 0) / total : 0;
    const len = fraction * circumference;
    const arc = { ...seg, fraction, dashoffset: -offset, dasharray: `${Math.max(len - GAP, 0)} ${circumference}` };
    offset += len;
    return arc;
  });

  const hoveredSeg = segments.find((s) => s.key === hovered);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={thickness} />
          {total === 0 && (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={thickness} />
          )}
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={a.color} strokeWidth={thickness}
              strokeDasharray={a.dasharray} strokeDashoffset={a.dashoffset}
              style={{
                cursor: a.onClick ? 'pointer' : 'default',
                filter: hovered === a.key ? 'brightness(1.12)' : 'none',
                transition: 'filter 0.15s',
              }}
              onMouseEnter={() => setHovered(a.key)}
              onMouseLeave={() => setHovered(null)}
              onClick={a.onClick}
            />
          ))}
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 8,
          pointerEvents: 'none',
        }}>
          {hoveredSeg ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
                {hoveredSeg.formattedValue ?? hoveredSeg.value.toLocaleString('en-IN')}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.3 }}>{hoveredSeg.label}</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
                {centerValue}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.3 }}>{centerLabel}</div>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px 14px', width: '100%' }}>
        {segments.map((s) => {
          const pct = total > 0 ? Math.round((Math.max(s.value, 0) / total) * 100) : 0;
          return (
            <div
              key={s.key}
              onMouseEnter={() => setHovered(s.key)}
              onMouseLeave={() => setHovered(null)}
              onClick={s.onClick}
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: s.onClick ? 'pointer' : 'default' }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
                {s.formattedValue ?? s.value.toLocaleString('en-IN')}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({pct}%)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
