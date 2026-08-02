import React, { useState } from 'react';
import { Building2 } from 'lucide-react';
import { Modal, StyledInput, useToast } from '../../components/ui';
import { useUpdateClient } from '../../hooks/useClients';
import type { Client } from '@fapoms/shared';
import { ClientType, Priority } from '@fapoms/shared';

const CLIENT_TYPES = Object.values(ClientType);
const PRIORITIES = Object.values(Priority);

export const EditClientModal: React.FC<{ client: Client; onClose: () => void }> = ({ client, onClose }) => {
  const [form, setForm] = useState({
    name: client.name,
    displayName: client.displayName,
    website: client.website ?? '',
    industry: client.industry ?? '',
    registrationNumber: client.registrationNumber ?? '',
    taxId: client.taxId ?? '',
    contactPerson: client.contactPerson ?? '',
    contactEmail: client.contactEmail ?? '',
    contactPhone: client.contactPhone ?? '',
    address: client.address ?? '',
    clientType: client.clientType,
    priority: client.priority,
    budget: client.budget != null ? String(client.budget) : '',
  });
  const { toast } = useToast();
  const update = useUpdateClient();

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.displayName) return;
    try {
      await update.mutateAsync({
        id: client.id,
        payload: {
          name: form.name,
          displayName: form.displayName,
          website: form.website || undefined,
          industry: form.industry || undefined,
          registrationNumber: form.registrationNumber || undefined,
          taxId: form.taxId || undefined,
          contactPerson: form.contactPerson || undefined,
          contactEmail: form.contactEmail || undefined,
          contactPhone: form.contactPhone || undefined,
          address: form.address || undefined,
          clientType: form.clientType,
          priority: form.priority,
          budget: form.budget ? parseFloat(form.budget) : undefined,
        },
      });
      toast('success', 'Client updated');
      onClose();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to update client');
    }
  };

  const inputProps = { style: { width: '100%' } };
  const selectStyle: React.CSSProperties = { padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%' };

  return (
    <Modal open onClose={onClose} title={<><Building2 size={18} /> Edit Client — {client.clientCode}</>} width="560px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={update.isPending || !form.name || !form.displayName} className="btn btn-primary">
          {update.isPending ? 'Saving...' : 'Save Changes'}
        </button>
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StyledInput {...inputProps} placeholder="Name *" value={form.name} onChange={(e) => set('name', e.target.value)} required />
        <StyledInput {...inputProps} placeholder="Display Name *" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} required />
        <StyledInput {...inputProps} placeholder="Website" value={form.website} onChange={(e) => set('website', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Industry" value={form.industry} onChange={(e) => set('industry', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Registration Number" value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Tax ID" value={form.taxId} onChange={(e) => set('taxId', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Contact Person" value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Contact Email" type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Contact Phone" value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Budget" type="number" value={form.budget} onChange={(e) => set('budget', e.target.value)} />
        <select value={form.clientType} onChange={(e) => set('clientType', e.target.value)} style={selectStyle}>
          {CLIENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={selectStyle}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <textarea
          placeholder="Address"
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
          rows={2}
          style={{ gridColumn: '1 / -1', padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical' }}
        />
      </div>
    </Modal>
  );
};
