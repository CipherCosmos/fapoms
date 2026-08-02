import React from 'react';
import { Search } from 'lucide-react';

/**
 * Shared styled text input. The inline input styling (var(--bg-primary),
 * var(--border-color), var(--radius-sm), #fff text, no outline) was repeated on
 * every <input>/<select>/<textarea> across all pages. This is the base primitive;
 * SearchInput and FilterSelect wrap it with their icons.
 */
export const StyledInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => {
  return (
    <input
      {...props}
      style={{
        padding: '8px 12px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        fontSize: '13px',
        ...props.style,
      }}
    />
  );
};

/**
 * Shared search input with a magnifier icon. The `relative` wrapper + absolutely
 * positioned Search icon + padded input was duplicated across ~8 files.
 */
export const SearchInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  flex?: boolean;
  compact?: boolean;
  style?: React.CSSProperties;
  iconSize?: number;
  iconOffsetTop?: string | number;
}> = ({ value, onChange, placeholder = 'Search...', flex = true, compact = false, style, iconSize = 14, iconOffsetTop = '50%' }) => {
  return (
    <div style={{ position: 'relative', flex: flex ? 1 : undefined, minWidth: compact ? undefined : '200px', ...style }}>
      <Search
        size={iconSize}
        style={{
          position: 'absolute',
          left: '10px',
          top: iconOffsetTop === '50%' ? '50%' : iconOffsetTop,
          transform: iconOffsetTop === '50%' ? 'translateY(-50%)' : undefined,
          color: 'var(--text-muted)',
        }}
      />
      <StyledInput
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={compact ? { padding: '7px 10px 7px 30px', fontSize: '12px', width: '100%' } : { width: '100%', padding: '8px 12px 8px 34px' }}
      />
    </div>
  );
};

/**
 * Shared styled filter <select>. The dropdown styling + label pattern was duplicated
 * across pages.
 */
export const FilterSelect: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  label?: React.ReactNode;
  style?: React.CSSProperties;
  compact?: boolean;
}> = ({ value, onChange, options, label, style, compact = false }) => {
  const select = (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: compact ? '7px 10px' : '8px 12px',
        fontSize: compact ? '12px' : '13px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        ...style,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (label === undefined) return select;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      {label}
      {select}
    </div>
  );
};
