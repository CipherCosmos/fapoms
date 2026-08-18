import React, { useState } from 'react';
import { Building2 } from 'lucide-react';
import { Modal, StyledInput, Select, useToast } from '../../components/ui';
import { useUpdateClient } from '../../hooks/useClients';
import type { Client } from '@fapoms/shared';
import { ClientType, Priority } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

const CLIENT_TYPES = Object.values(ClientType);
const PRIORITIES = Object.values(Priority);

const Label: React.FC<{ text: string; required?: boolean }> = ({ text, required }) => (
  <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '4px' }}>
    {text} {required && <span style={{ color: 'var(--danger)' }}>*</span>}
  </label>
);

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
      toast('success', 'Client updated successfully');
      onClose();
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to update client', message: userMessage(err) });
    }
  };

  return (
    <Modal open onClose={onClose} title={<><Building2 size={18} style={{ marginRight: 6 }} /> Edit Client — {client.clientCode}</>} width="560px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={update.isPending || !form.name || !form.displayName} className="btn btn-primary">
          {update.isPending ? 'Saving...' : 'Save Changes'}
        </button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Section 1: General Identity */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 12px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, color: 'var(--accent-primary)' }}>General Identity</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Legal Name" required />
              <StyledInput placeholder="e.g., State Bank of India" value={form.name} onChange={(e) => set('name', e.target.value)} required />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Display Name" required />
              <StyledInput placeholder="e.g., SBI Corporate Office" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} required />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Industry" />
              <StyledInput placeholder="e.g., Banking & Finance" value={form.industry} onChange={(e) => set('industry', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Client Type" />
              <Select
                value={form.clientType}
                onChange={(v) => set('clientType', v)}
                options={CLIENT_TYPES.map((t) => ({ value: t, label: t }))}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Priority" />
              <Select
                value={form.priority}
                onChange={(v) => set('priority', v)}
                options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Website" />
              <StyledInput placeholder="https://example.com" value={form.website} onChange={(e) => set('website', e.target.value)} />
            </div>
          </div>
        </div>

        {/* Section 2: Contact Information */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 12px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, color: 'var(--accent-primary)' }}>Contact Details</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Contact Person" />
              <StyledInput placeholder="John Doe" value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Contact Email" />
              <StyledInput placeholder="john.doe@example.com" type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
              <Label text="Contact Phone" />
              <StyledInput placeholder="+91 99999 99999" value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
              <Label text="Address" />
              <textarea
                placeholder="Corporate Office Address"
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                rows={2}
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  resize: 'vertical',
                  fontSize: '13px',
                }}
              />
            </div>
          </div>
        </div>

        {/* Section 3: Financials & Registration */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 12px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, color: 'var(--accent-primary)' }}>Financials & Registration</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Registration Number" />
              <StyledInput placeholder="e.g., L65190MH1994PLC080639" value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Tax ID" />
              <StyledInput placeholder="e.g., GSTIN / PAN" value={form.taxId} onChange={(e) => set('taxId', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
              <Label text="Budget (₹)" />
              <StyledInput placeholder="e.g., 5000000" type="number" value={form.budget} onChange={(e) => set('budget', e.target.value)} />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};
