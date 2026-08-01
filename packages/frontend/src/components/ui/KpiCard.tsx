import React from 'react';

/**
 * Shared KPI / stat metric card — the `glass-card` block (icon box + label + value)
 * that was copy-pasted N times within Validation, Documents, AssayerProfile and
 * Assignments. Supports both value-above-label (most pages) and label-above-value
 * (AssayerProfile) layouts, plus optional click handling.
 */
export const KpiCard: React.FC<{
  icon: React.ReactNode;
  iconBg?: string;
  iconColor?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  valueColor?: string;
  onClick?: () => void;
  layout?: 'value-first' | 'label-first';
  style?: React.CSSProperties;
}> = ({ icon, iconBg = 'rgba(99,102,241,0.1)', iconColor = 'var(--accent-primary)', label, value, valueColor, onClick, layout = 'value-first', style }) => {
  const box = (
    <div
      className="glass-card"
      onClick={onClick}
      style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px', cursor: onClick ? 'pointer' : undefined, ...style }}
    >
      <div
        style={{
          width: '40px',
          height: '40px',
          borderRadius: 'var(--radius-md)',
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {React.isValidElement(icon)
          ? React.cloneElement(icon as React.ReactElement<{ size?: number; color?: string }>, { size: 20, color: iconColor })
          : icon}
      </div>
      {layout === 'value-first' ? (
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)', color: valueColor }}>{value}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</div>
          <div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)', color: valueColor }}>{value}</div>
        </div>
      )}
    </div>
  );
  return box;
};
