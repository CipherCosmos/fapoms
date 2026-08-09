import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal, StyledInput, StatusBadge, useToast } from '../../components/ui';
import { useClientContracts, useAddContract, useDeleteContract } from '../../hooks/useClients';
import { contractStatusLabel } from '../../utils/statusLabels';
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
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ contractNumber: '', title: '', description: '', effectiveFrom: '', effectiveTo: '', value: '' });

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
      setForm({ contractNumber: '', title: '', description: '', effectiveFrom: '', effectiveTo: '', value: '' });
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to add contract', message: userMessage(err) });
    }
  };

  const handleDelete = async (contract: ClientContract) => {
    if (!window.confirm(`Remove contract "${contract.title}"? This cannot be undone.`)) return;
    try {
      await del.mutateAsync({ clientId, contractId: contract.id });
      toast('success', 'Contract removed');
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to remove contract', message: userMessage(err) });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <StyledInput placeholder="Contract Number *" value={form.contractNumber} onChange={(e) => setForm((f) => ({ ...f, contractNumber: e.target.value }))} required />
            <StyledInput placeholder="Title *" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            <StyledInput placeholder="Effective From *" type="date" value={form.effectiveFrom} onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))} required />
            <StyledInput placeholder="Effective To" type="date" value={form.effectiveTo} onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))} />
            <StyledInput placeholder="Value (₹)" type="number" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
          </div>
          <textarea placeholder="Description" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical' }} />
        </Modal>
      )}
    </div>
  );
};
