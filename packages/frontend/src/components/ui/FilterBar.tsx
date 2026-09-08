import React from 'react';
import { X, RotateCcw } from 'lucide-react';
import { SearchInput } from './inputs';

export interface FilterChipItem {
  id: string;
  label: string;
  value: string;
  onRemove: () => void;
}

export interface FilterChipProps {
  label: string;
  value: string;
  onRemove: () => void;
  style?: React.CSSProperties;
}

export const FilterChip: React.FC<FilterChipProps> = ({ label, value, onRemove, style }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '3px 8px',
      borderRadius: 'var(--radius-full, 9999px)',
      background: 'var(--bg-surface-2)',
      border: '1px solid var(--border-hair)',
      color: 'var(--text-primary)',
      fontSize: 'var(--text-xs, 12px)',
      fontWeight: 500,
      ...style,
    }}
  >
    <span style={{ color: 'var(--text-muted)' }}>{label}:</span>
    <strong>{value}</strong>
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      title={`Remove ${label} filter`}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        margin: 0,
        color: 'var(--text-muted)',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--status-danger-fg)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
    >
      <X size={12} />
    </button>
  </span>
);

export interface FilterBarProps {
  children?: React.ReactNode;
  /** Built-in search input configuration. */
  search?: {
    value: string;
    onChange: (val: string) => void;
    placeholder?: string;
  };
  /** Number of active filters applied. */
  activeCount?: number;
  /** Callback to clear all active filters. */
  onClearAll?: () => void;
  /** Summary count or results text (e.g. "Showing 42 of 150 items"). */
  summary?: React.ReactNode;
  /** Interactive chips for active filters. */
  chips?: FilterChipItem[];
  style?: React.CSSProperties;
  className?: string;
}

/**
 * Canonical FilterBar Primitive.
 *
 * Provides a unified filter container with optional search, active filter count,
 * removable filter chips, and a single "Clear all" button.
 */
export const FilterBar: React.FC<FilterBarProps> = ({
  children,
  search,
  activeCount = 0,
  onClearAll,
  summary,
  chips = [],
  style,
  className,
}) => {
  const showActiveBar = Boolean(chips.length > 0 || (activeCount > 0 && onClearAll));

  return (
    <div
      className={`filter-bar ${className || ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2, 8px)',
        padding: 'var(--space-3, 12px) var(--space-3-5, 14px)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-hair)',
        borderRadius: 'var(--radius-md, 10px)',
        ...style,
      }}
    >
      {/* Primary control row: Search, Filter Selects, Actions */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2-5, 10px)',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2, 8px)',
            flexWrap: 'wrap',
            alignItems: 'center',
            flex: 1,
            minWidth: '240px',
          }}
        >
          {search && (
            <SearchInput
              value={search.value}
              onChange={search.onChange}
              placeholder={search.placeholder ?? 'Search...'}
              style={{ maxWidth: '320px', minWidth: '180px' }}
            />
          )}
          {children}
        </div>

        {summary && (
          <div
            style={{
              fontSize: 'var(--text-xs, 12px)',
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {summary}
          </div>
        )}
      </div>

      {/* Active Filter Chips & Clear All row */}
      {showActiveBar && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2, 8px)',
            flexWrap: 'wrap',
            alignItems: 'center',
            borderTop: '1px solid var(--border-hair)',
            paddingTop: 'var(--space-2, 8px)',
          }}
        >
          <span style={{ fontSize: 'var(--text-xs, 12px)', color: 'var(--text-muted)', fontWeight: 600 }}>
            Active Filters ({activeCount || chips.length}):
          </span>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', flex: 1 }}>
            {chips.map((chip) => (
              <FilterChip
                key={chip.id}
                label={chip.label}
                value={chip.value}
                onRemove={chip.onRemove}
              />
            ))}
          </div>

          {onClearAll && (
            <button
              type="button"
              onClick={onClearAll}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                border: 'none',
                background: 'transparent',
                color: 'var(--accent-primary)',
                fontSize: 'var(--text-xs, 12px)',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: 'var(--radius-xs, 4px)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
            >
              <RotateCcw size={11} />
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default FilterBar;
