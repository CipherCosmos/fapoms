import React from 'react';
import { AlertCircle, CheckCircle, X } from 'lucide-react';

/**
 * Shared success/error alert banner. The red/green banner with an AlertCircle or
 * CheckCircle icon + colored background + border was duplicated across Documents,
 * Scheduling, Assignments, Assayers, Branches, Projects, Holidays, Users, etc.
 */
export const AlertBanner: React.FC<{
  type: 'success' | 'error';
  message?: React.ReactNode;
  children?: React.ReactNode;
  onClose?: () => void;
  style?: React.CSSProperties;
}> = ({ type, message, children, onClose, style }) => {
  if (!message && !children) return null;
  const isSuccess = type === 'success';
  const color = isSuccess ? 'var(--success)' : 'var(--danger)';
  const bg = isSuccess ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)';
  const border = isSuccess ? 'rgba(63,125,83,0.25)' : 'rgba(177,68,68,0.25)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 16px',
        fontSize: '12.5px',
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 'var(--radius-sm)',
        color,
        ...style,
      }}
    >
      {isSuccess ? <CheckCircle size={16} style={{ flexShrink: 0 }} /> : <AlertCircle size={16} style={{ flexShrink: 0 }} />}
      <div style={{ flex: 1 }}>{message ?? children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" style={{ background: 'none', border: 'none', color, cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}>
          <X size={15} />
        </button>
      )}
    </div>
  );
};
