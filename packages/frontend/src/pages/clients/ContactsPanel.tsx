import React, { useState } from 'react';
import { Plus, X, Mail, Phone } from 'lucide-react';
import { Modal, StyledInput, useToast } from '../../components/ui';
import { useClientContacts, useAddContact, useDeleteContact } from '../../hooks/useClients';
import type { ClientContact } from '@fapoms/shared';

export const ContactsPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: contacts = [], isLoading } = useClientContacts(clientId);
  const add = useAddContact();
  const del = useDeleteContact();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', designation: '', department: '', isPrimary: false });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.phone || !form.designation) return;
    try {
      await add.mutateAsync({
        clientId,
        payload: { ...form, department: form.department || undefined, isPrimary: form.isPrimary },
      });
      toast('success', 'Contact added');
      setShowForm(false);
      setForm({ name: '', email: '', phone: '', designation: '', department: '', isPrimary: false });
    } catch (err: any) {
      toast('error', err?.message || 'Failed to add contact');
    }
  };

  const handleDelete = async (contact: ClientContact) => {
    try {
      await del.mutateAsync({ clientId, contactId: contact.id });
      toast('success', 'Contact removed');
    } catch (err: any) {
      toast('error', err?.message || 'Failed to remove contact');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
          <div key={c.id} style={{ padding: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {c.name}
                {c.isPrimary && <span style={{ fontSize: 10, color: 'var(--accent-secondary)', fontWeight: 700, marginLeft: 6 }}>PRIMARY</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.designation}{c.department ? ` • ${c.department}` : ''}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Mail size={11} /> {c.email}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Phone size={11} /> {c.phone}</span>
              </div>
            </div>
            <button onClick={() => handleDelete(c)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: 4 }} aria-label="Remove contact"><X size={14} /></button>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <StyledInput placeholder="Name *" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
            <StyledInput placeholder="Email *" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
            <StyledInput placeholder="Phone *" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} required />
            <StyledInput placeholder="Designation *" value={form.designation} onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))} required />
            <StyledInput placeholder="Department" value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))} /> Primary contact
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
};
