import React, { useState } from 'react';
import { RefreshCw, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Modal } from './Modal';

export interface ConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReload: () => void;
  onDiscard?: () => void;
  title?: string;
  message?: string;
  unsavedDiff?: Record<string, { myValue: any; serverValue?: any }>;
}

/**
 * ConflictModal — Deliberate Conflict Resolution UX.
 *
 * Rendered when concurrent modification (409 Conflict) occurs, preventing
 * silent data loss or blind overwrites.
 */
export const ConflictModal: React.FC<ConflictModalProps> = ({
  isOpen,
  onClose,
  onReload,
  onDiscard,
  title = 'Record Modified by Another Operator',
  message = 'Another operator or system process updated this record while you were editing it. Your changes were not applied to prevent overwriting their work.',
  unsavedDiff,
}) => {
  const [showDiff, setShowDiff] = useState(false);
  const diffEntries = unsavedDiff ? Object.entries(unsavedDiff) : [];

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--status-warning-fg)' }}>
          <AlertTriangle size={18} />
          <span>{title}</span>
        </div>
      }
      footer={
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', width: '100%' }}>
          {onDiscard && (
            <button
              type="button"
              onClick={onDiscard}
              className="btn btn-secondary"
              style={{ fontSize: '13px', padding: '7px 14px' }}
            >
              Discard My Changes
            </button>
          )}
          <button
            type="button"
            onClick={onReload}
            className="btn btn-primary"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              padding: '7px 14px',
            }}
          >
            <RefreshCw size={14} />
            Reload Latest Record
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13.5px', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          {message}
        </p>

        <div
          style={{
            padding: '12px 14px',
            background: 'var(--status-pending-bg)',
            border: '1px solid var(--status-pending-border)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '12.5px',
            color: 'var(--text-primary)',
          }}
        >
          <strong>What happens next:</strong> Clicking <em>Reload Latest Record</em> will refresh the data from the server so you can review the latest changes and re-apply any adjustments safely.
        </div>

        {diffEntries.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
            <button
              type="button"
              onClick={() => setShowDiff((s) => !s)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent-primary)',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: 0,
              }}
            >
              {showDiff ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showDiff ? 'Hide unsaved input details' : `Review ${diffEntries.length} unsaved fields`}
            </button>

            {showDiff && (
              <div
                style={{
                  marginTop: '10px',
                  maxHeight: '160px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-hair)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface-2)',
                  padding: '8px',
                  fontSize: '12px',
                }}
              >
                {diffEntries.map(([field, vals]) => (
                  <div
                    key={field}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr',
                      gap: '8px',
                      padding: '4px 0',
                      borderBottom: '1px dashed var(--border-hair)',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{field}:</span>
                    <span style={{ color: 'var(--text-primary)' }}>{String(vals.myValue ?? '')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
