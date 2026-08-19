import React, { useState } from 'react';
import { Building2 } from 'lucide-react';
import { Modal, StyledInput, Select, useToast } from '../../components/ui';
import { useCreateClient } from '../../hooks/useClients';
import { ClientType, Priority, clientTypeLabel, priorityLabel } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

// The enum supplies the values; `@fapoms/shared`'s label layer supplies the wording, the same
// way the clients list already does. Rendering the value itself put "MICROFINANCE" and
// "CRITICAL" in front of an office user as if they were words.
const CLIENT_TYPES = Object.values(ClientType);
const PRIORITIES = Object.values(Priority);

const Label: React.FC<{ text: string; required?: boolean }> = ({ text, required }) => (
  <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '4px' }}>
    {text} {required && <span style={{ color: 'var(--danger)' }}>*</span>}
  </label>
);

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
    if (!form.name || !form.displayName) return;
    try {
      await create.mutateAsync({
        // Blank is meaningful: the server allocates the next free code, the same way branches,
        // projects and assayers already do. Sending "" would be a code of empty string.
        clientCode: form.clientCode.trim() || undefined,
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
      toast('success', 'Client created successfully');
      onClose();
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to create client', message: userMessage(err) });
    }
  };

  return (
    <Modal open onClose={onClose} title={<><Building2 size={18} style={{ marginRight: 6 }} /> Add New Client</>} width="560px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={create.isPending || !form.name || !form.displayName} className="btn btn-primary">
          {create.isPending ? 'Creating...' : 'Create Client'}
        </button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Section 1: General Identity */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 12px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, color: 'var(--accent-primary)' }}>General Identity</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {/* The last hand-typed code on the platform. Branches, projects and assayers all
                  allocate their own when the field is left blank; clients now do the same, so
                  nobody has to invent a short code and check it is not already taken. */}
              <Label text="Client Code" />
              <StyledInput placeholder="Left blank, one is assigned for you" value={form.clientCode} onChange={(e) => set('clientCode', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Legal Name" required />
              <StyledInput placeholder="e.g., State Bank of India" value={form.name} onChange={(e) => set('name', e.target.value)} required />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
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
                options={CLIENT_TYPES.map((t) => ({ value: t, label: clientTypeLabel(t) }))}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </div>

        {/* Section 2: Contact Details */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 12px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, color: 'var(--accent-primary)' }}>Contact Information</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Contact Person" />
              <StyledInput placeholder="John Doe" value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Contact Email" />
              <StyledInput placeholder="john.doe@example.com" type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Contact Phone" />
              <StyledInput placeholder="+91 99999 99999" value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Website" />
              <StyledInput placeholder="https://example.com" value={form.website} onChange={(e) => set('website', e.target.value)} />
            </div>
          </div>
        </div>

        {/* Section 3: Financials & Preferences */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 12px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, color: 'var(--accent-primary)' }}>Financials & Preferences</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Priority" />
              <Select
                value={form.priority}
                onChange={(v) => set('priority', v)}
                options={PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Budget (₹)" />
              <StyledInput placeholder="e.g., 5000000" type="number" value={form.budget} onChange={(e) => set('budget', e.target.value)} />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};
