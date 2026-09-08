import React, { useState } from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { AssayerLifecycleStatus, assayerLifecycleLabel } from '@fapoms/shared';
import { Modal } from '../../../components/ui';
import { STAGE_CONSEQUENCE } from '../AssayerRecord';
import { REHIRE_REASON } from '../lifecycle-reason-vocabulary';

export interface LifecycleTransitionModalProps {
  open: boolean;
  onClose: () => void;
  assayerName: string;
  assayerCode: string;
  currentStatus: AssayerLifecycleStatus | string;
  targetStatus: AssayerLifecycleStatus | string;
  onConfirm: (reason: string) => Promise<void>;
  busy?: boolean;
}

export const LifecycleTransitionModal: React.FC<LifecycleTransitionModalProps> = ({
  open,
  onClose,
  assayerName,
  assayerCode,
  currentStatus,
  targetStatus,
  onConfirm,
  busy = false,
}) => {
  const isRehire =
    targetStatus === AssayerLifecycleStatus.INVITED &&
    (currentStatus === AssayerLifecycleStatus.RESIGNED || currentStatus === AssayerLifecycleStatus.TERMINATED);

  const needsReason =
    isRehire ||
    targetStatus === AssayerLifecycleStatus.SUSPENDED ||
    targetStatus === AssayerLifecycleStatus.INACTIVE ||
    targetStatus === AssayerLifecycleStatus.RESIGNED ||
    targetStatus === AssayerLifecycleStatus.TERMINATED;

  const [reason, setReason] = useState(isRehire ? REHIRE_REASON : '');
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const isSuspension = targetStatus === AssayerLifecycleStatus.SUSPENDED;
  const isDeparture =
    targetStatus === AssayerLifecycleStatus.RESIGNED ||
    targetStatus === AssayerLifecycleStatus.TERMINATED;
  const isHardToReverse =
    isSuspension || isDeparture || targetStatus === AssayerLifecycleStatus.ARCHIVED;

  const handleConfirm = async () => {
    if (needsReason && !reason.trim()) {
      setError('A reason is mandatory for this transition.');
      return;
    }
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Transition failed');
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={
        isRehire
          ? `Rehire / Start Re-onboarding: ${assayerName} (${assayerCode})`
          : `Transition Lifecycle to ${assayerLifecycleLabel(targetStatus)} (${assayerCode})`
      }
      width={560}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Consequence callout */}
        {isRehire ? (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--status-pending-bg)',
              border: '1px solid var(--warning)',
              display: 'flex',
              gap: '10px',
            }}
          >
            <Info size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
              <strong>Rehire Semantics:</strong> This will place {assayerName} back into{' '}
              <strong>INVITED</strong> stage to restart the verification and onboarding process.
              <br />
              <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                They will NOT be immediately returned to ACTIVE. Fresh KYC, background checks, and
                compliance verification must be completed.
              </span>
            </div>
          </div>
        ) : isSuspension ? (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--status-cancelled-bg)',
              border: '1px solid var(--danger)',
              display: 'flex',
              gap: '10px',
            }}
          >
            <ShieldAlert size={18} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
              <strong>Suspension Consequences:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                <li>App access and mobile field sign-in are halted immediately.</li>
                <li>Field GPS check-ins are blocked.</li>
                <li>Existing assignments are <strong>NOT</strong> automatically cancelled (review assignments workspace).</li>
                <li>Client empanelments remain on file but future planning is stopped.</li>
                <li>This disciplinary action is recorded in the permanent audit trail.</li>
              </ul>
            </div>
          </div>
        ) : isDeparture ? (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--status-cancelled-bg)',
              border: '1px solid var(--danger)',
              display: 'flex',
              gap: '10px',
            }}
          >
            <AlertTriangle size={18} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
              <strong>Permanent Departure ({assayerLifecycleLabel(targetStatus)}):</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                <li>Permanent departure: all future planning and dispatching stop immediately.</li>
                <li>Any uncompleted assignments will be cancelled.</li>
                <li>Active client bank empanelments are closed.</li>
                <li>Re-engagement in future requires the explicit supported Rehire path via INVITED.</li>
              </ul>
            </div>
          </div>
        ) : (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-color)',
              fontSize: '12.5px',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}
          >
            <strong>Transition Consequence:</strong>{' '}
            {STAGE_CONSEQUENCE[targetStatus] ??
              `Moving from ${assayerLifecycleLabel(currentStatus)} to ${assayerLifecycleLabel(targetStatus)}.`}
          </div>
        )}

        {/* Mandatory Reason Box */}
        {needsReason && (
          <div>
            <label
              htmlFor="lifecycle-reason-input"
              style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}
            >
              Reason for transition <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <textarea
              id="lifecycle-reason-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="State the operational or compliance reason for this status change..."
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: '13px',
                background: 'var(--bg-surface-2)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-sm)',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
          </div>
        )}

        {error && (
          <div style={{ fontSize: '12px', color: 'var(--danger)', fontWeight: 600 }}>
            {error}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || (needsReason && !reason.trim())}
            className={isHardToReverse ? 'btn btn-danger' : 'btn btn-primary'}
            style={{ fontSize: '12px', padding: '6px 16px' }}
          >
            {busy
              ? 'Executing…'
              : isRehire
              ? 'Confirm Rehire to INVITED'
              : `Confirm Move to ${assayerLifecycleLabel(targetStatus)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
};
