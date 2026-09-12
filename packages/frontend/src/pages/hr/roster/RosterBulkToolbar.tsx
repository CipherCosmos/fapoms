import React, { useState } from 'react';
import { ArrowRightLeft, KeyRound, MessageSquare } from 'lucide-react';
import {
  AssayerLifecycleStatus,
  assayerLifecycleLabel,
  assayerLifecyclePath,
} from '@fapoms/shared';
import { Select } from '../../../components/ui/Select';
import {
  LIFECYCLE_MOVE_REASONS,
  OTHER_LIFECYCLE_REASON,
} from '../lifecycle-reason-vocabulary';
import { STAGE_CONSEQUENCE } from '../AssayerRecord';
import type { RosterPerson } from '../roster-filters';
import { RosterNotifyDialog } from './RosterNotifyDialog';

export interface RosterBulkToolbarProps {
  selectedRows: RosterPerson[];
  selectedVisibleIds?: string[];
  hiddenCount?: number;
  hiddenNote?: string | null;
  onClearSelection: () => void;
  onBulkTransition: (targetStatus: string, reason: string) => Promise<void>;
  onBulkIssueAppAccess: () => Promise<void>;
  onBulkNotify: (subject: string, body: string, sendEmail: boolean) => Promise<void>;
  busy: boolean;
  appAccessBusy: boolean;
  notifyBusy: boolean;
}

export const RosterBulkToolbar: React.FC<RosterBulkToolbarProps> = ({
  selectedRows,
  hiddenNote,
  onClearSelection,
  onBulkTransition,
  onBulkIssueAppAccess,
  onBulkNotify,
  busy,
  appAccessBusy,
  notifyBusy,
}) => {
  const [targetStatus, setTargetStatus] = useState('');
  const [reason, setReason] = useState('');
  const [isOther, setIsOther] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);

  if (selectedRows.length === 0) return null;

  // Reachable target stages for the selected rows
  const bulkOptions = Object.values(AssayerLifecycleStatus).filter((status) => {
    return selectedRows.some(
      (a) =>
        status !== a.lifecycleStatus &&
        assayerLifecyclePath(a.lifecycleStatus, status) !== null,
    );
  });

  const handleApply = async () => {
    if (!targetStatus || !reason.trim()) return;
    await onBulkTransition(targetStatus, reason.trim());
    setTargetStatus('');
    setReason('');
    setIsOther(false);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        padding: '10px 14px',
        borderRadius: '8px',
        background: 'var(--status-pending-bg, rgba(234, 179, 8, 0.1))',
        border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
          {selectedRows.length} visible selected
        </strong>
        {hiddenNote && (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>({hiddenNote})</span>
        )}
      </div>

      <ArrowRightLeft size={13} style={{ color: 'var(--text-muted)' }} />

      {/* Target Selector */}
      {bulkOptions.length > 0 ? (
        <Select
          value={targetStatus}
          onChange={(v) => {
            setTargetStatus(String(v));
            setReason('');
            setIsOther(false);
          }}
          options={bulkOptions.map((t) => ({ value: t, label: assayerLifecycleLabel(t) }))}
          placeholder="Move selected to…"
          aria-label="Move all selected to"
          compact
        />
      ) : (
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          No common legal stage reachable
        </span>
      )}

      {/* Mandatory Reason Selector */}
      {targetStatus && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 200px' }}>
          <Select
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
              { value: '', label: 'Why? Select a reason…' },
              ...LIFECYCLE_MOVE_REASONS.map((r) => ({ value: r, label: r })),
              { value: OTHER_LIFECYCLE_REASON, label: 'Other (type it in)' },
            ]}
            compact
            aria-label="Reason for the move"
          />

          {isOther && (
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. bulk batch onboarding complete"
              aria-label="Reason, in your own words"
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                background: 'var(--bg-page)',
                color: 'inherit',
              }}
            />
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleApply}
        disabled={!targetStatus || !reason.trim() || busy}
        className="btn btn-primary"
        style={{ fontSize: '12px', padding: '6px 14px' }}
      >
        {busy ? 'Moving…' : 'Apply'}
      </button>

      <button
        type="button"
        onClick={onBulkIssueAppAccess}
        disabled={appAccessBusy}
        className="btn btn-secondary"
        style={{
          fontSize: '12px',
          padding: '6px 12px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
        }}
      >
        <KeyRound size={13} />
        <span>{appAccessBusy ? 'Issuing…' : 'Issue App Access'}</span>
      </button>

      <button
        type="button"
        onClick={() => setNotifyOpen(true)}
        disabled={notifyBusy}
        className="btn btn-secondary"
        style={{
          fontSize: '12px',
          padding: '6px 12px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
        }}
      >
        <MessageSquare size={13} />
        <span>{notifyBusy ? 'Notifying…' : 'Notify'}</span>
      </button>

      <button
        type="button"
        onClick={onClearSelection}
        className="btn btn-secondary"
        style={{ fontSize: '12px', padding: '6px 12px', marginLeft: 'auto' }}
      >
        Clear selection
      </button>

      {targetStatus && STAGE_CONSEQUENCE[targetStatus] && (
        <div style={{ flexBasis: '100%', fontSize: '12px', color: 'var(--text-secondary)' }}>
          {STAGE_CONSEQUENCE[targetStatus]} Partial results will be reported; unreachable rows will be skipped safely.
        </div>
      )}

      <RosterNotifyDialog
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        selectedRows={selectedRows}
        hiddenNote={hiddenNote}
        busy={notifyBusy}
        onSend={async (subject, body, sendEmail) => {
          await onBulkNotify(subject, body, sendEmail);
          setNotifyOpen(false);
        }}
      />
    </div>
  );
};
