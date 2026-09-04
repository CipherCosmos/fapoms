import React, { useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { Modal, StyledInput, Select, useToast } from '../../components/ui';
import { Autocomplete } from '../../components/ui/Autocomplete';
import { useUpdateClient } from '../../hooks/useClients';
import type { Client } from '@fapoms/shared';
import { ClientType, Priority, clientTypeLabel, priorityLabel } from '@fapoms/shared';
import { userMessage } from '../../services/errors';
import { applyPlaceToAddressGroup, composeAddress, emptyAddressGroup, stateOptionsFor } from './address-group';
import { taxIdHint } from './field-hints';

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
    clientType: client.clientType,
    priority: client.priority,
    budget: client.budget != null ? String(client.budget) : '',
  });
  // The existing free-text address seeds the `address` line verbatim; pincode/city/district/
  // state start blank because they never existed as separate fields before this — there is
  // nothing recorded to prefill them with. Leaving them untouched round-trips the old address
  // exactly (see `composeAddress` in address-group.ts).
  const [addr, setAddr] = useState(emptyAddressGroup(client.address ?? ''));
  const { toast } = useToast();
  const update = useUpdateClient();

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setAddrField = (k: keyof typeof addr) => (v: string) => setAddr((a) => ({ ...a, [k]: v }));
  const stateOptions = useMemo(() => stateOptionsFor(addr.state), [addr.state]);

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
          address: composeAddress(addr) || undefined,
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
                options={CLIENT_TYPES.map((t) => ({ value: t, label: clientTypeLabel(t) }))}
                style={{ width: '100%' }}
              />
            </div>
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
            {/* Pincode first and geo-backed, same as the branch form: picking a result fills
                district, city and state in one go instead of asking for all four separately. */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="Pincode" />
              <Autocomplete
                value={addr.pincode}
                onChange={setAddrField('pincode')}
                onSelect={(place) => setAddr((a) => applyPlaceToAddressGroup('pincode', place, a))}
                placeholder="Type a pincode — the rest fills in"
                filterType={(r) => !!r.pincode}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="City" />
              <Autocomplete
                value={addr.city}
                onChange={setAddrField('city')}
                onSelect={(place) => setAddr((a) => applyPlaceToAddressGroup('city', place, a))}
                placeholder="Type to search city…"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="District" />
              <Autocomplete
                value={addr.district}
                onChange={setAddrField('district')}
                onSelect={(place) => setAddr((a) => applyPlaceToAddressGroup('district', place, a))}
                placeholder="Type to search district…"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label text="State" />
              <Select
                value={addr.state}
                onChange={setAddrField('state')}
                options={stateOptions}
                placeholder="Select…"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
              <Label text="Address" />
              <textarea
                placeholder="Corporate Office Address"
                value={addr.address}
                onChange={(e) => setAddrField('address')(e.target.value)}
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
              {/* Advisory, shown while the field still has focus of the operator's attention —
                  never a reason to refuse a save. The column has always held either shape. */}
              {taxIdHint(form.taxId) && (
                <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>{taxIdHint(form.taxId)}</span>
              )}
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
