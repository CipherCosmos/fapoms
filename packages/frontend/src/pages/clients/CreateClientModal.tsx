import React, { useState } from 'react';
import { Building2 } from 'lucide-react';
import { Modal, StyledInput, useToast } from '../../components/ui';
import { useCreateClient } from '../../hooks/useClients';
import { ClientType, Priority } from '@fapoms/shared';

const CLIENT_TYPES = Object.values(ClientType);
const PRIORITIES = Object.values(Priority);

export const CreateClientModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [form, setForm] = useState({
    clientCode: '',
    name: '',
    displayName: '',
    contactPerson: '',
    contactEmail: '',
    contactPhone: '',
    website: '',
    industry: '',
    clientType: ClientType.OTHER,
    priority: Priority.MEDIUM,
    budget: '',
  });
  const { toast } = useToast();
  const create = useCreateClient();

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.clientCode || !form.name || !form.displayName) return;
    try {
      await create.mutateAsync({
        clientCode: form.clientCode,
        name: form.name,
        displayName: form.displayName,
        contactPerson: form.contactPerson || undefined,
        contactEmail: form.contactEmail || undefined,
        contactPhone: form.contactPhone || undefined,
        website: form.website || undefined,
        industry: form.industry || undefined,
        clientType: form.clientType,
        priority: form.priority,
        budget: form.budget ? parseFloat(form.budget) : undefined,
      });
      toast('success', 'Client created');
      onClose();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to create client');
    }
  };

  const inputProps = { style: { width: '100%' } };

  return (
    <Modal open onClose={onClose} title={<><Building2 size={18} /> Add New Client</>} width="520px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={create.isPending || !form.clientCode || !form.name || !form.displayName} className="btn btn-primary">
          {create.isPending ? 'Creating...' : 'Create Client'}
        </button>
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StyledInput {...inputProps} placeholder="Client Code *" value={form.clientCode} onChange={(e) => set('clientCode', e.target.value)} required />
        <StyledInput {...inputProps} placeholder="Name *" value={form.name} onChange={(e) => set('name', e.target.value)} required />
        <StyledInput {...inputProps} placeholder="Display Name *" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} required style={{ gridColumn: '1 / -1', width: '100%' }} />
        <StyledInput {...inputProps} placeholder="Contact Person" value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Contact Email" type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Contact Phone" value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Website" value={form.website} onChange={(e) => set('website', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Industry" value={form.industry} onChange={(e) => set('industry', e.target.value)} />
        <select value={form.clientType} onChange={(e) => set('clientType', e.target.value)} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%' }}>
          {CLIENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%' }}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <StyledInput {...inputProps} placeholder="Budget" type="number" value={form.budget} onChange={(e) => set('budget', e.target.value)} style={{ gridColumn: '1 / -1', width: '100%' }} />
      </div>
    </Modal>
  );
};
