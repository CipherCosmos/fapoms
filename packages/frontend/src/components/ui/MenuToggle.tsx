import React from 'react';
import { Menu } from 'lucide-react';

interface MenuToggleProps {
  onClick: () => void;
  label?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const MenuToggle: React.FC<MenuToggleProps> = ({
  onClick,
  label,
  title,
  className,
  style,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={className}
    title={title || (label ? label : 'Toggle Menu')}
    style={{
      background: 'transparent',
      border: 'none',
      color: 'var(--text-muted)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      ...(label
        ? { flexDirection: 'column' as const, gap: 2, fontSize: 10, fontWeight: 600, padding: 0 }
        : { padding: 4, borderRadius: 'var(--radius-sm)' }),
      ...style,
    }}
  >
    <Menu size={18} />
    {label && <span>{label}</span>}
  </button>
);