import React from 'react';
import { Database, Search, ShieldAlert, AlertTriangle, RotateCcw } from 'lucide-react';

export type EmptyStateMeaning = 'NO_DATA' | 'NO_RESULTS' | 'FORBIDDEN' | 'UNAVAILABLE';

export interface EmptyStateProps {
  /** The semantic meaning of this empty state */
  meaning?: EmptyStateMeaning;
  /** A glyph in a soft chip. Overrides the meaning default. */
  icon?: React.ReactNode;
  /** The primary headline. Overrides the meaning default. */
  title?: string;
  /** Optional secondary explanation: why it is empty or what to do next. */
  message?: React.ReactNode;
  /** Optional primary action (e.g. Clear Filters, Retry, Add Record). */
  action?: React.ReactNode;
  /** Convenience handler for clearing filters when meaning === 'NO_RESULTS' */
  onClearFilters?: () => void;
  /** Convenience handler for retrying when meaning === 'UNAVAILABLE' */
  onRetry?: () => void;
  /** Tighter padding for use inside a small panel rather than a full page. */
  compact?: boolean;
}

/**
 * Standardized empty-state block used across the application.
 *
 * Implements the four canonical empty-state meanings:
 * - NO_DATA: Zero records exist in the database for this collection.
 * - NO_RESULTS: Active filters/search yielded zero hits (offers filter reset).
 * - FORBIDDEN: User lacks the operational role/permission for this dataset.
 * - UNAVAILABLE: Upstream service error, network drop, or timeout (offers retry).
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  meaning,
  icon: propIcon,
  title: propTitle,
  message: propMessage,
  action: propAction,
  onClearFilters,
  onRetry,
  compact = false,
}) => {
  let defaultIcon: React.ReactNode = null;
  let defaultTitle = 'No records found';
  let defaultMessage: React.ReactNode = 'There are no records in this workspace yet.';
  let defaultAction: React.ReactNode = null;

  switch (meaning) {
    case 'NO_RESULTS':
      defaultIcon = <Search size={compact ? 20 : 26} />;
      defaultTitle = 'No matching results';
      defaultMessage = 'No items match your active filters or search criteria. Try clearing or relaxing filters.';
      if (onClearFilters) {
        defaultAction = (
          <button
            type="button"
            onClick={onClearFilters}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            Clear all filters
          </button>
        );
      }
      break;

    case 'FORBIDDEN':
      defaultIcon = <ShieldAlert size={compact ? 20 : 26} style={{ color: 'var(--danger)' }} />;
      defaultTitle = 'Access restricted';
      defaultMessage = 'You do not have the required operational permissions to view these records.';
      break;

    case 'UNAVAILABLE':
      defaultIcon = <AlertTriangle size={compact ? 20 : 26} style={{ color: 'var(--warning)' }} />;
      defaultTitle = 'Service temporarily unavailable';
      defaultMessage = 'Unable to retrieve records from the server right now. Please check your connection and retry.';
      if (onRetry) {
        defaultAction = (
          <button
            type="button"
            onClick={onRetry}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '6px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <RotateCcw size={13} />
            Retry
          </button>
        );
      }
      break;

    case 'NO_DATA':
    default:
      defaultIcon = <Database size={compact ? 20 : 26} />;
      defaultTitle = 'No records found';
      defaultMessage = 'There are no records in this workspace yet.';
      break;
  }

  const icon = propIcon ?? defaultIcon;
  const title = propTitle ?? defaultTitle;
  const message = propMessage ?? defaultMessage;
  const action = propAction ?? defaultAction;

  return (
    <div
      role="region"
      aria-label={title}
      data-meaning={meaning}
      data-testid={`empty-state-${(meaning || 'custom').toLowerCase().replace('_', '-')}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: compact ? 8 : 12,
        padding: compact ? '26px 18px' : '52px 24px',
        color: 'var(--text-secondary)',
      }}
    >
      {icon && (
        <div
          style={{
            width: compact ? 42 : 54,
            height: compact ? 42 : 54,
            borderRadius: 'var(--radius-lg)',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--text-muted)',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-hair)',
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: compact ? 14 : 16, fontWeight: 700, color: 'var(--text-primary)' }}>
        {title}
      </div>
      {message && <div style={{ fontSize: 13, maxWidth: 440, lineHeight: 1.5 }}>{message}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
};

export default EmptyState;
