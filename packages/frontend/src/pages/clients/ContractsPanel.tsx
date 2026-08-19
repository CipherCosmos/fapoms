import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal, StyledInput, StatusBadge, useToast, useConfirm } from '../../components/ui';
import { useClientContracts, useAddContract, useDeleteContract } from '../../hooks/useClients';
import { contractStatusLabel, todayDateKey } from '../../utils/statusLabels';
import type { ClientContract } from '@fapoms/shared';
import { ContractStatus } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

const CONTRACT_STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  [ContractStatus.DRAFT]: { color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  [ContractStatus.ACTIVE]: { color: 'var(--success)', bg: 'var(--status-active-bg)' },
  [ContractStatus.EXPIRED]: { color: 'var(--text-muted)', bg: 'var(--status-draft-bg)' },
  [ContractStatus.TERMINATED]: { color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  [ContractStatus.RENEWED]: { color: 'var(--accent)', bg: 'var(--status-pending-bg)' },
};

export const ContractsPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: contracts = [], isLoading } = useClientContracts(clientId);
  const add = useAddContract();
  const del = useDeleteContract();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  /**
   * `effectiveFrom` starts at today. A contract is registered when it is signed far more often
   * than it is backdated, and an empty required date field is one more thing to fill in before
   * the form will submit at all. It stays fully editable for the backdated case.
   */
  const emptyForm = () => ({ contractNumber: '', title: '', description: '', effectiveFrom: todayDateKey(), effectiveTo: '', value: '' });
  const [form, setForm] = useState(emptyForm);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.contractNumber || !form.title || !form.effectiveFrom) return;
    try {
      await add.mutateAsync({
        clientId,
        payload: {
          contractNumber: form.contractNumber,
          title: form.title,
          description: form.description || undefined,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || undefined,
          value: form.value ? parseFloat(form.value) : undefined,
          currency: 'INR',
        },
      });
      toast('success', 'Contract added');
      setShowForm(false);
      setForm(emptyForm());
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to add contract', message: userMessage(err) });
    }
  };

  const handleDelete = async (contract: ClientContract) => {
    // A contract is the commercial record behind the client's billing — typed title.
    const ok = await confirm({
      title: `Remove the contract "${contract.title}"?`,
      message: 'The contract and its dates and value are removed from this client.',
      confirmLabel: 'Remove contract',
      reversible: false,
      tone: 'danger',
      confirmPhrase: contract.title,
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ clientId, contractId: contract.id });
      toast('success', 'Contract removed');
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to remove contract', message: userMessage(err) });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {confirmDialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Contracts ({contracts.length})</span>
        <button onClick={() => setShowForm(true)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={12} /> Add
        </button>
      </div>

      {isLoading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : contracts.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          No contracts registered
        </div>
      ) : (
        contracts.map((c) => {
          const colors = CONTRACT_STATUS_COLORS[c.status] ?? { color: 'var(--text-muted)', bg: 'var(--status-draft-bg)' };
          return (
            <div key={c.id} style={{ padding: 12, background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</div>
                  <StatusBadge size="sm" label={contractStatusLabel(c.status)} color={colors.color} bg={colors.bg} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {c.contractNumber} • {c.value ? `₹${c.value.toLocaleString()}` : 'N/A'} • {new Date(c.effectiveFrom).toLocaleDateString()} — {c.effectiveTo ? new Date(c.effectiveTo).toLocaleDateString() : 'Open'}
                </div>
              </div>
              <button onClick={() => handleDelete(c)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 4 }} aria-label="Remove contract"><X size={14} /></button>
            </div>
          );
        })
      )}

      {showForm && (
        <Modal open onClose={() => setShowForm(false)} title="Add Contract" width="480px" asForm onSubmit={handleSubmit} footer={
          <>
            <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={add.isPending} className="btn btn-primary">{add.isPending ? 'Saving...' : 'Save Contract'}</button>
          </>
        }>
          {/* Every field was a placeholder standing in for a label, which disappears the moment
              anything is typed: a half-filled form showed five boxes with no way to tell which
              date was which, and the required ones were marked only by an asterisk inside the
              vanishing text. Real labels stay put. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Contract Number" required htmlFor="contract-number" hint="The client's own reference for this agreement.">
              <StyledInput id="contract-number" placeholder="e.g. SBI/GA/2026/014" value={form.contractNumber} onChange={(e) => setForm((f) => ({ ...f, contractNumber: e.target.value }))} required />
            </Field>
            <Field label="Title" required htmlFor="contract-title" hint="What this contract covers, in your own words.">
              <StyledInput id="contract-title" placeholder="e.g. Gold loan audit retainer" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </Field>
            <Field label="Effective From" required htmlFor="contract-from" hint="Defaults to today; change it if the contract is backdated.">
              <StyledInput id="contract-from" type="date" value={form.effectiveFrom} onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))} required />
            </Field>
            <Field label="Effective To" htmlFor="contract-to" hint="Leave empty for an open-ended contract.">
              <StyledInput id="contract-to" type="date" min={form.effectiveFrom || undefined} value={form.effectiveTo} onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))} />
            </Field>
            <Field label="Value (₹)" htmlFor="contract-value" hint="Total contract value. Optional.">
              <StyledInput id="contract-value" type="number" min={0} placeholder="e.g. 500000" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
            </Field>
          </div>
          <Field label="Description" htmlFor="contract-description">
            <textarea id="contract-description" placeholder="Anything worth recording about the terms" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} style={{ width: '100%', boxSizing: 'border-box', padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical' }} />
          </Field>
        </Modal>
      )}
    </div>
  );
};

/** Label above, optional one-line hint below — the pattern the client modals already use. */
const Field: React.FC<{ label: string; htmlFor: string; required?: boolean; hint?: string; children: React.ReactNode }> = ({ label, htmlFor, required, hint, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label htmlFor={htmlFor} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
      {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
    </label>
    {children}
    {hint && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span>}
  </div>
);
