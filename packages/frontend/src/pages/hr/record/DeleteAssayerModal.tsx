import React, { useState } from 'react';
import { Trash2, AlertTriangle, X } from 'lucide-react';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';

interface DeleteAssayerModalProps {
  open: boolean;
  onClose: () => void;
  assayerId: string;
  assayerName: string;
  onDeleted: () => void;
}

export const DeleteAssayerModal: React.FC<DeleteAssayerModalProps> = ({
  open,
  onClose,
  assayerId,
  assayerName,
  onDeleted,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  if (!open) return null;

  const handleDelete = async () => {
    if (confirmText.trim() !== assayerName.trim()) {
      setError(`Type "${assayerName}" exactly to confirm deletion.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.request(`/assayers/${assayerId}`, {
        method: 'DELETE',
      });
      onDeleted();
    } catch (e) {
      setError(userMessage(e));
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="delete-assayer-modal"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '16px',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          borderRadius: '12px',
          maxWidth: '480px',
          width: '100%',
          border: '1px solid var(--border-color)',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
            <Trash2 size={18} />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
              Delete Assayer Record
            </h3>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: '4px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div
            style={{
              padding: '12px',
              borderRadius: '8px',
              background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)',
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
            }}
          >
            <AlertTriangle size={18} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
              <strong>Permanent Operational Impact:</strong> Deleting this assayer record will soft-delete the profile, remove them from active rosters and dispatch queues, and revoke system access.
            </div>
          </div>

          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            To confirm this destructive action, please type the assayer’s exact name: <strong>{assayerName}</strong>
          </div>

          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={assayerName}
            disabled={busy}
            style={{
              padding: '8px 12px',
              fontSize: '13px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
            }}
          />

          {error && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--danger)',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)',
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={busy}
              style={{ fontSize: '12.5px', padding: '7px 14px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleDelete}
              disabled={busy || confirmText.trim() !== assayerName.trim()}
              style={{ fontSize: '12.5px', padding: '7px 14px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              {busy ? 'Deleting…' : 'Delete Assayer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
