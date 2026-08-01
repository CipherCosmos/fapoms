import React from 'react';

/**
 * Shared status pill — a translucent colored badge. The styling (padding, radius,
 * weight, inline-flex layout) used to be hand-copied into every page, each with its
 * own background/color ternaries or color maps. This single component renders the
 * pill; callers supply the resolved colors (from their own status→color map) and an
 * optional label/icon so the badge stays visually identical everywhere.
 *
 * Two sizing/spacing conventions are supported:
 * - `pill` (default): rounded (10px), the common `badge` class look across pages.
 * - `tag`: tighter (6px radius), the Assignments/execution-table style with optional icon.
 */
export const StatusBadge: React.FC<{
  color: string;
  bg: string;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  variant?: 'pill' | 'tag';
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
  border?: boolean;
  style?: React.CSSProperties;
}> = ({ color, bg, label, icon, variant = 'pill', size = 'sm', className, title, border = false, style }) => {
  return (
    <span
      title={title}
      className={className}
      style={{
        padding: variant === 'tag' ? (size === 'sm' ? '3px 8px' : '4px 12px') : size === 'sm' ? '3px 10px' : '6px 12px',
        borderRadius: variant === 'tag' ? '6px' : '10px',
        fontSize: variant === 'tag' ? (size === 'sm' ? '11px' : '12px') : '11px',
        fontWeight: variant === 'tag' ? 700 : 600,
        background: bg,
        color,
        border: border ? `1px solid ${color}40` : 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon}
      {label}
    </span>
  );
};
