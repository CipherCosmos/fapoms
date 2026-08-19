import React, { useState } from 'react';
import { Plus, X, Mail, Phone } from 'lucide-react';
import { Modal, StyledInput, useToast, useConfirm } from '../../components/ui';
import { useClientContacts, useAddContact, useDeleteContact } from '../../hooks/useClients';
import type { ClientContact } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

/** Digits only, then a `+91` unless the number already carries the country code. */
const normalisePhone = (raw: string): string => {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('91') ? `+${digits}` : `+91${digits}`;
};

/**
 * Every input here carries a real <label>. They were placeholders standing in for labels, which
 * vanish the moment the user types — so the form the user proof-reads before saving had nothing
 * on it identifying which box was which, and a screen reader had nothing to announce.
 */
const Field: React.FC<{
  id: string; label: string; value: string; onChange: (v: string) => void;
  required?: boolean; type?: string; placeholder?: string; tel?: boolean;
}> = ({ id, label, value, onChange, required, type, placeholder, tel }) => (
  <div>
    <label htmlFor={id} style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, fontWeight: 500 }}>
      {label}{required && <span style={{ color: 'var(--danger)', marginLeft: 2 }}>*</span>}
    </label>
    <div style={{ position: 'relative' }}>
      {tel && <span aria-hidden style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 12, pointerEvents: 'none' }}>+91</span>}
      <StyledInput
        id={id}
        type={tel ? 'tel' : type || 'text'}
        inputMode={tel ? 'numeric' : undefined}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', paddingLeft: tel ? 38 : undefined }}
      />
    </div>
  </div>
);

export const ContactsPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: contacts = [], isLoading } = useClientContacts(clientId);
  const add = useAddContact();
  const del = useDeleteContact();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', designation: '', department: '', isPrimary: false });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Designation is no longer part of this check — a contact you only have a number for is worth
    // recording. (The client-contact API still requires one server-side; when that DTO is relaxed
    // the way the branch-contact one now is, the field here becomes genuinely optional.)
    if (!form.name || !form.email || !form.phone) return;
    try {
      await add.mutateAsync({
        clientId,
        payload: {
          ...form,
          // One spelling of a phone number in the database, not five. Same normalisation the
          // assayer form applies: digits only, then +91 unless the country code is already there.
          phone: normalisePhone(form.phone),
          department: form.department || undefined,
          isPrimary: form.isPrimary,
        },
      });
      toast('success', 'Contact added');
      setShowForm(false);
      setForm({ name: '', email: '', phone: '', designation: '', department: '', isPrimary: false });
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to add contact', message: userMessage(err) });
    }
  };

  const handleDelete = async (contact: ClientContact) => {
    // Deleting a person's record off a client: typed name, both because it is a delete
    // and because contact rows are a list of similar-looking names.
    const ok = await confirm({
      title: `Remove "${contact.name}" from this client?`,
      message: 'This contact will no longer appear on the client, and nobody will be able to reach them from here.',
      confirmLabel: 'Remove contact',
      reversible: false,
      tone: 'danger',
      confirmPhrase: contact.name,
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ clientId, contactId: contact.id });
      toast('success', 'Contact removed');
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to remove contact', message: userMessage(err) });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {confirmDialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Contacts ({contacts.length})</span>
        <button onClick={() => setShowForm(true)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={12} /> Add
        </button>
      </div>

      {isLoading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : contacts.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          No contacts registered
        </div>
      ) : (
        contacts.map((c) => (
          <div key={c.id} style={{ padding: 12, background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {c.name}
                {c.isPrimary && <span style={{ fontSize: 10, color: 'var(--accent-secondary)', fontWeight: 700, marginLeft: 6 }}>PRIMARY</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.designation}{c.department ? ` • ${c.department}` : ''}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Mail size={11} /> {c.email}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Phone size={11} /> {c.phone}</span>
              </div>
            </div>
            <button onClick={() => handleDelete(c)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 4 }} aria-label="Remove contact"><X size={14} /></button>
          </div>
        ))
      )}

      {showForm && (
        <Modal open onClose={() => setShowForm(false)} title="Add Contact" width="460px" asForm onSubmit={handleSubmit} footer={
          <>
            <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={add.isPending} className="btn btn-primary">{add.isPending ? 'Saving...' : 'Save Contact'}</button>
          </>
        }>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field id="client-contact-name" label="Name" required value={form.name} placeholder="e.g. Anita Rao" onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
            <Field id="client-contact-email" label="Email" required type="email" value={form.email} placeholder="name@example.com" onChange={(v) => setForm((f) => ({ ...f, email: v }))} />
            <Field id="client-contact-phone" label="Phone" required tel value={form.phone} placeholder="9876543210" onChange={(v) => setForm((f) => ({ ...f, phone: v.replace(/\D/g, '') }))} />
            <Field id="client-contact-designation" label="Designation" value={form.designation} placeholder="e.g. Relationship Manager" onChange={(v) => setForm((f) => ({ ...f, designation: v }))} />
            <Field id="client-contact-department" label="Department" value={form.department} placeholder="e.g. Operations" onChange={(v) => setForm((f) => ({ ...f, department: v }))} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))} /> Primary contact
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
};
