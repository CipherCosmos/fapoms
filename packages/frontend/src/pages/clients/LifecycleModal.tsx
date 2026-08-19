import React, { useEffect, useState } from 'react';
import { Modal, Select, useToast } from '../../components/ui';
import { useTransitionLifecycle } from '../../hooks/useClients';
import { clientLifecycleLabel } from '../../utils/statusLabels';
import { ClientLifecycleStatus, CLIENT_LIFECYCLE_TRANSITIONS } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

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

  /**
   * Where a client may move next, read from the shared table rather than a copy.
   *
   * This modal used to keep its own hand-written transition map — a fourth copy of a graph
   * `state-machines.ts` was created to own after three others were found drifting apart. It
   * happened to be identical, which is the dangerous case: nothing failed, nothing warned, and
   * the next edit to the real table would have left the screen users actually click offering
   * moves the backend rejects (or hiding moves it allows). The shapes match exactly —
   * `TransitionMap<ClientLifecycleStatus>`, keyed by the same enum — so this is an import, not
   * an adaptation. `currentStatus` arrives as a plain string, hence the cast at the lookup.
   */
  const options = CLIENT_LIFECYCLE_TRANSITIONS[currentStatus as ClientLifecycleStatus] ?? [];

  /**
   * Preselect when there is nothing to choose. From TERMINATED the only legal move is to
   * ARCHIVED, and the picker was still opening empty with the Confirm button disabled — asking
   * the user to make a decision that has exactly one answer. Where several moves are legal the
   * picker stays as it was, with no default, so nobody confirms a transition by reflex.
   *
   * This also clears `reason` and the target on close. Both used to survive a cancel: opening
   * the modal on the next client re-used the same component instance and carried the previous
   * client's typed reason with it, so a justification written for one client could be recorded
   * against another. `open` drives it so that both closing paths — Cancel and a completed
   * transition — reset the same way.
   */
  useEffect(() => {
    if (!open) { setTargetLifecycle(''); setReason(''); return; }
    setTargetLifecycle(options.length === 1 ? options[0] : '');
    setReason('');
    // `options` is derived from currentStatus; depending on the status keeps this to one run
    // per opening rather than one per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentStatus]);
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
        <Select
          value={targetLifecycle}
          onChange={setTargetLifecycle}
          options={options.map((s) => ({ value: s, label: clientLifecycleLabel(s) }))}
          placeholder="-- Select target status --"
        />
        <input type="text" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>
    </Modal>
  );
};
