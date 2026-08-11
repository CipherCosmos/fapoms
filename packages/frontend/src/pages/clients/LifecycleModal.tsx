import React, { useState } from 'react';
import { Modal, useToast } from '../../components/ui';
import { useTransitionLifecycle } from '../../hooks/useClients';
import { clientLifecycleLabel } from '../../utils/statusLabels';
import { ClientLifecycleStatus } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

const LIFECYCLE_OPTIONS: Record<string, string[]> = {
  [ClientLifecycleStatus.PROSPECT]: [ClientLifecycleStatus.ONBOARDING, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ONBOARDING]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.ACTIVE]: [ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.SUSPENDED]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.UNDER_REVIEW]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.INACTIVE]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.TERMINATED]: [ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ARCHIVED]: [],
};

export const LifecycleModal: React.FC<{
  open: boolean;
  onClose: () => void;
  clientName: string;
  currentStatus: string;
  clientId: string;
}> = ({ open, onClose, clientName, currentStatus, clientId }) => {
  const [targetLifecycle, setTargetLifecycle] = useState('');
  const [reason, setReason] = useState('');
  const { toast } = useToast();
  const transition = useTransitionLifecycle();

  const options = LIFECYCLE_OPTIONS[currentStatus] ?? [];
  const colorMap: Record<string, string> = {
    [ClientLifecycleStatus.PROSPECT]: 'var(--warning)',
    [ClientLifecycleStatus.ONBOARDING]: 'var(--accent)',
    [ClientLifecycleStatus.ACTIVE]: 'var(--success)',
    [ClientLifecycleStatus.SUSPENDED]: 'var(--danger)',
    [ClientLifecycleStatus.UNDER_REVIEW]: 'var(--warning)',
    [ClientLifecycleStatus.INACTIVE]: 'var(--text-muted)',
    [ClientLifecycleStatus.TERMINATED]: 'var(--danger)',
    [ClientLifecycleStatus.ARCHIVED]: 'var(--text-muted)',
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetLifecycle) return;
    try {
      await transition.mutateAsync({ id: clientId, status: targetLifecycle as ClientLifecycleStatus, reason: reason || undefined });
      toast('success', `Moved to ${clientLifecycleLabel(targetLifecycle)}`);
      setTargetLifecycle('');
      setReason('');
      onClose();
    } catch (err: any) {
      toast({ type: 'error', title: 'Transition failed', message: userMessage(err) });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Transition Lifecycle Status" width="420px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={!targetLifecycle || transition.isPending} className="btn btn-primary">
          {transition.isPending ? 'Updating...' : 'Confirm Transition'}
        </button>
      </>
    }>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
        {clientName} — Current: <b style={{ color: colorMap[currentStatus] }}>{clientLifecycleLabel(currentStatus)}</b>
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <select value={targetLifecycle} onChange={(e) => setTargetLifecycle(e.target.value)} style={{ padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }}>
          <option value="">-- Select target status --</option>
          {options.map((s) => <option key={s} value={s}>{clientLifecycleLabel(s)}</option>)}
        </select>
        <input type="text" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>
    </Modal>
  );
};
