import React from 'react';

interface EmptyStateProps {
  /** A glyph in a soft chip, e.g. <Inbox size={22} />. */
  icon?: React.ReactNode;
  /** The one line that says what's (not) here. */
  title: string;
  /** Optional second line: what to do about it, in plain words. */
  message?: React.ReactNode;
  /** Optional primary action (a button/link) so the next step is one click away. */
  action?: React.ReactNode;
  /** Tighter padding for use inside a small panel rather than a full page. */
  compact?: boolean;
}

/**
 * The one empty-state block used across the app.
 *
 * An empty list should never leave someone guessing whether it broke or is just empty. This says
 * which — a calm glyph, a plain title, an optional "here's what to do" line, and an optional action
 * so the next step is right there. Replaces the scattering of bare "No items" strings each page
 * used to hand-roll differently.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, message, action, compact }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', gap: compact ? 8 : 12, padding: compact ? '26px 18px' : '52px 24px',
    color: 'var(--text-secondary)',
  }}>
    {icon && (
      <div style={{
        width: compact ? 42 : 54, height: compact ? 42 : 54, borderRadius: 'var(--radius-lg)',
        display: 'grid', placeItems: 'center', color: 'var(--text-muted)',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-hair)',
      }}>{icon}</div>
    )}
    <div style={{ fontSize: compact ? 14 : 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
    {message && <div style={{ fontSize: 13, maxWidth: 440, lineHeight: 1.5 }}>{message}</div>}
    {action && <div style={{ marginTop: 4 }}>{action}</div>}
  </div>
);

export default EmptyState;
