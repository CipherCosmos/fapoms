import React, { useState } from 'react';
import {
  AssayerLifecycleStatus,
  assayerLifecycleLabel,
} from '@fapoms/shared';
import { Modal } from '../../../components/ui/Modal';
import { Select } from '../../../components/ui/Select';
import { AlertBanner } from '../../../components/ui/AlertBanner';
import {
  LIFECYCLE_MOVE_REASONS,
  OTHER_LIFECYCLE_REASON,
  REHIRE_REASON,
} from '../lifecycle-reason-vocabulary';
import { STAGE_CONSEQUENCE, HARD_TO_REVERSE_STAGES } from '../AssayerRecord';

export interface LifecycleTransitionModalProps {
  open: boolean;
  onClose: () => void;
  assayerName: string;
  assayerCode: string;
  currentStatus: string;
  targetStatus: string;
  onConfirm: (targetStatus: string, reason: string) => Promise<void>;
  busy: boolean;
}

// Moves requiring an explicit written reason per backend AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON
const MOVES_NEEDING_REASON = new Set<string>([
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.INACTIVE,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.INVITED, // Rehire edge
]);

export const LifecycleTransitionModal: React.FC<LifecycleTransitionModalProps> = ({
  open,
  onClose,
  assayerName,
  assayerCode,
  currentStatus,
  targetStatus,
  onConfirm,
  busy,
}) => {
  const [reason, setReason] = useState('');
  const [isOther, setIsOther] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open || !targetStatus) return null;

  const needsReason = MOVES_NEEDING_REASON.has(targetStatus);
  const isDestructive = HARD_TO_REVERSE_STAGES.includes(targetStatus as AssayerLifecycleStatus);
  const isSuspension = targetStatus === AssayerLifecycleStatus.SUSPENDED;
  const isDeparture =
    targetStatus === AssayerLifecycleStatus.RESIGNED ||
    targetStatus === AssayerLifecycleStatus.TERMINATED;
  const isRehire = targetStatus === AssayerLifecycleStatus.INVITED;

  const handleConfirm = async () => {
    if (needsReason && !reason.trim()) {
      setErrorMsg('A specific operational or HR reason is mandatory for this transition.');
      return;
    }
    try {
      setErrorMsg(null);
      await onConfirm(targetStatus, reason.trim());
      setReason('');
      setIsOther(false);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to complete lifecycle transition.');
    }
  };

  const reasonChoices = isRehire ? [REHIRE_REASON] : LIFECYCLE_MOVE_REASONS;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Transition to ${assayerLifecycleLabel(targetStatus)}`}
      width="520px"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
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
            className={`btn ${isDestructive ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleConfirm}
            disabled={busy || (needsReason && !reason.trim())}
            style={{
              fontSize: '12.5px',
              padding: '7px 16px',
              fontWeight: 600,
              background: isDestructive ? 'var(--danger)' : undefined,
              borderColor: isDestructive ? 'var(--danger)' : undefined,
            }}
          >
            {busy ? 'Transitioning…' : `Confirm ${assayerLifecycleLabel(targetStatus)}`}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
            {assayerName}{' '}
            <span style={{ fontFamily: 'monospace', fontSize: '12.5px', color: 'var(--text-muted)' }}>
              ({assayerCode})
            </span>
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Current stage:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {assayerLifecycleLabel(currentStatus)}
            </strong>{' '}
            → Moving to:{' '}
            <strong style={{ color: 'var(--accent)' }}>
              {assayerLifecycleLabel(targetStatus)}
            </strong>
          </div>
        </div>

        {/* Precise Downstream Consequence Banners */}
        {isSuspension && (
          <AlertBanner type="error">
            <div>
              <strong>Immediate Suspension Consequences:</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', lineHeight: 1.5 }}>
                <li>Mobile application sign-in is revoked immediately.</li>
                <li>GPS on-site field check-in is blocked.</li>
                <li>
                  <strong>Existing assigned visits remain on their schedule</strong> (must be re-assigned or cancelled manually).
                </li>
                <li>Existing client empanelments remain open.</li>
                <li>New deployment in planning is completely halted.</li>
              </ul>
            </div>
          </AlertBanner>
        )}

        {isDeparture && (
          <AlertBanner type="error">
            <div>
              <strong>Permanent Departure Consequences:</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', lineHeight: 1.5 }}>
                <li>All open and in-flight audit assignments are <strong>automatically cancelled</strong>.</li>
                <li>Active client bank empanelments are <strong>automatically closed</strong>.</li>
                <li>Departure dates are stamped on the permanent employment record.</li>
                <li>This person is permanently removed from all candidate pools.</li>
              </ul>
            </div>
          </AlertBanner>
        )}

        {!isSuspension && !isDeparture && STAGE_CONSEQUENCE[targetStatus] && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'var(--bg-muted, rgba(128,128,128,0.08))',
              fontSize: '12.5px',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}
          >
            {STAGE_CONSEQUENCE[targetStatus]}
          </div>
        )}

        {/* Mandatory Reason Input */}
        {needsReason && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              htmlFor="lifecycle-reason-select"
              style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}
            >
              Reason for this move <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <Select
              id="lifecycle-reason-select"
              value={isOther ? OTHER_LIFECYCLE_REASON : reason}
              onChange={(v) => {
                if (v === OTHER_LIFECYCLE_REASON) {
                  setIsOther(true);
                  setReason('');
                } else {
                  setIsOther(false);
                  setReason(String(v));
                }
              }}
              options={[
                { value: '', label: 'Select an official reason…' },
                ...reasonChoices.map((r) => ({ value: r, label: r })),
                { value: OTHER_LIFECYCLE_REASON, label: 'Other (type written explanation)' },
              ]}
              aria-label="Reason for lifecycle transition"
            />

            {isOther && (
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="State specific reason for the permanent employment record…"
                aria-label="Specific reason"
                style={{
                  padding: '8px 10px',
                  fontSize: '12.5px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-page)',
                  color: 'inherit',
                  resize: 'vertical',
                }}
              />
            )}
          </div>
        )}

        {errorMsg && (
          <div style={{ color: 'var(--danger)', fontSize: '12px', fontWeight: 500 }}>
            {errorMsg}
          </div>
        )}
      </div>
    </Modal>
  );
};
