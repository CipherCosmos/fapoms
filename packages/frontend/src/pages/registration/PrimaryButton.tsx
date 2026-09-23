import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * The registration flow's one button.
 *
 * Lived inside `PublicRegistration.tsx` until the consent notice became its own screen and
 * needed the same button; a second copy would have been the start of two of them drifting.
 */
export const PrimaryButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
}> = ({ onClick, disabled, busy, children, style, title }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled || busy}
    title={title}
    className="btn btn-primary"
    style={{
      padding: '12px 22px',
      minHeight: '48px',
      fontSize: 'var(--text-sm)',
      fontWeight: 600,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      cursor: disabled || busy ? 'not-allowed' : 'pointer',
      ...style,
    }}
  >
    {busy && <Loader2 size={16} className="spin" />}
    {children}
  </button>
);

export default PrimaryButton;
