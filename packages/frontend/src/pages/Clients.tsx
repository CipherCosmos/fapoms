import React, { useState, useEffect } from 'react';
import { Building2, Plus, Search, Mail, Phone, User, X } from 'lucide-react';
import { ClientLifecycleStatus } from '@fapoms/shared';
import { api } from '../services/api';

interface Client {
  id: string;
  clientCode: string;
  name: string;
  displayName: string;
  website: string | null;
  industry: string | null;
  clientType: string;
  registrationNumber: string | null;
  taxId: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  lifecycleStatus: string;
  address: string | null;
  createdAt: string;
}

interface ClientContact {
  id: string;
  name: string;
  email: string;
  phone: string;
  designation: string;
  department: string | null;
  isPrimary: boolean;
  notes: string | null;
}

interface ClientContract {
  id: string;
  contractNumber: string;
  title: string;
  description: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  value: number | null;
  currency: string;
}

interface ClientBilling {
  id: string;
  paymentTerms: string | null;
  currency: string;
  taxIdentifier: string | null;
  invoiceCycle: string | null;
  billingAddress: string | null;
  bankAccount: string | null;
  bankName: string | null;
  ifscCode: string | null;
}

interface ClientDetail extends Client {
  contacts: ClientContact[];
  contracts: ClientContract[];
  billing: ClientBilling | null;
  configuration: any;
}

const LIFECYCLE_OPTIONS: Record<string, string[]> = {
  [ClientLifecycleStatus.PROSPECT]: [ClientLifecycleStatus.ONBOARDING, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ONBOARDING]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.ACTIVE]: [ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.SUSPENDED]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.UNDER_REVIEW]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.INACTIVE]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.TERMINATED]: [ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ARCHIVED]: [],
};

export const Clients: React.FC = () => {
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const [showLifecycleModal, setShowLifecycleModal] = useState(false);
  const [targetLifecycle, setTargetLifecycle] = useState('');
  const [lifecycleReason, setLifecycleReason] = useState('');

  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [contracts, setContracts] = useState<ClientContract[]>([]);
  const [billing, setBilling] = useState<ClientBilling | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'contacts' | 'contracts' | 'billing'>('contacts');

  useEffect(() => { loadClients(); }, []);

  const loadClients = async () => {
    setIsLoading(true);
    try {
      const data = await api.request<Client[]>('/clients');
      setClients(data);
    } catch (err) {
      console.error('Failed to load clients', err);
    } finally { setIsLoading(false); }
  };

  const selectClient = async (client: Client) => {
    try {
      const detail = await api.request<ClientDetail>(`/clients/${client.id}`);
      setSelectedClient(detail);
      setContacts(detail.contacts || []);
      setContracts(detail.contracts || []);
      setBilling(detail.billing);
      setActiveTab('contacts');
    } catch (err) {
      console.error('Failed to load client details');
    }
  };

  const handleLifecycleTransition = async () => {
    if (!selectedClient || !targetLifecycle) return;
    try {
      await api.request(`/clients/${selectedClient.id}/lifecycle`, {
        method: 'PATCH',
        body: JSON.stringify({ status: targetLifecycle, reason: lifecycleReason || undefined }),
      });
      setShowLifecycleModal(false);
      setTargetLifecycle('');
      setLifecycleReason('');
      selectClient(selectedClient);
      loadClients();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Transition failed');
    }
  };

  const filteredClients = clients.filter(c =>
    !searchTerm || c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.clientCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.displayName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const lifecycleColors: Record<string, string> = {
    [ClientLifecycleStatus.PROSPECT]: '#f59e0b',
    [ClientLifecycleStatus.ONBOARDING]: '#3b82f6',
    [ClientLifecycleStatus.ACTIVE]: '#10b981',
    [ClientLifecycleStatus.SUSPENDED]: '#ef4444',
    [ClientLifecycleStatus.UNDER_REVIEW]: '#f59e0b',
    [ClientLifecycleStatus.INACTIVE]: '#6b7280',
    [ClientLifecycleStatus.TERMINATED]: '#dc2626',
    [ClientLifecycleStatus.ARCHIVED]: '#9ca3af',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Client Management</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Manage client institutions, lifecycle, contacts, contracts, and billing.
          </p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Plus size={16} /> Add Client
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '24px', height: 'calc(100vh - 220px)' }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input type="text" placeholder="Search clients..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                style={{ width: '100%', padding: '8px 12px 8px 32px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>Loading...</div>
            ) : filteredClients.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>No clients found.</div>
            ) : filteredClients.map(c => (
              <div key={c.id} onClick={() => selectClient(c)}
                style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer', marginBottom: '4px',
                  background: selectedClient?.id === c.id ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                  border: selectedClient?.id === c.id ? '1px solid var(--accent-primary)' : '1px solid transparent' }}>
                <div style={{ fontWeight: 600, fontSize: '14px' }}>{c.displayName}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', gap: '8px', marginTop: '2px' }}>
                  <span>{c.clientCode}</span>
                  <span>•</span>
                  <span style={{ color: lifecycleColors[c.lifecycleStatus] || '#6b7280' }}>{c.lifecycleStatus}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedClient ? (
            <>
              <div style={{ padding: '24px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>{selectedClient.displayName}</h3>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                      <span>{selectedClient.clientCode}</span>
                      {selectedClient.industry && <><span>•</span><span>{selectedClient.industry}</span></>}
                      {selectedClient.clientType && <><span>•</span><span>{selectedClient.clientType}</span></>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span className="badge" style={{ padding: '6px 12px', background: `${lifecycleColors[selectedClient.lifecycleStatus] || '#6b7280'}20`, color: lifecycleColors[selectedClient.lifecycleStatus] || '#6b7280', border: `1px solid ${lifecycleColors[selectedClient.lifecycleStatus] || '#6b7280'}40`, fontWeight: 600 }}>
                      {selectedClient.lifecycleStatus}
                    </span>
                    {LIFECYCLE_OPTIONS[selectedClient.lifecycleStatus]?.length > 0 && (
                      <button onClick={() => setShowLifecycleModal(true)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
                        Transition
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginTop: '16px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}><User size={12} /> Contact</div>
                    <div style={{ color: '#fff', fontWeight: 600, fontSize: '13px' }}>{selectedClient.contactPerson || '-'}</div>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}><Mail size={12} /> Email</div>
                    <div style={{ color: '#fff', fontWeight: 600, fontSize: '13px' }}>{selectedClient.contactEmail || '-'}</div>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}><Phone size={12} /> Phone</div>
                    <div style={{ color: '#fff', fontWeight: 600, fontSize: '13px' }}>{selectedClient.contactPhone || '-'}</div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
                {(['contacts', 'contracts', 'billing'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    style={{ flex: 1, padding: '12px', background: 'transparent', border: 'none', borderBottom: activeTab === tab ? '2px solid var(--accent-primary)' : '2px solid transparent', color: activeTab === tab ? '#fff' : 'var(--text-muted)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', textTransform: 'uppercase' }}>
                    {tab}
                  </button>
                ))}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
                {activeTab === 'contacts' && <ContactsPanel clientId={selectedClient.id} contacts={contacts} setContacts={setContacts} />}
                {activeTab === 'contracts' && <ContractsPanel clientId={selectedClient.id} contracts={contracts} setContracts={setContracts} />}
                {activeTab === 'billing' && <BillingPanel clientId={selectedClient.id} billing={billing} setBilling={setBilling} />}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
              <Building2 size={48} style={{ marginBottom: '16px', opacity: 0.5 }} />
              Select a client from the list to view details
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <CreateClientModal onClose={() => setShowCreateModal(false)} onCreated={loadClients} />
      )}
      {showLifecycleModal && selectedClient && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowLifecycleModal(false)}>
          <div className="glass-card" style={{ width: '400px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>Transition Lifecycle Status</h4>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              {selectedClient.displayName} — Current: <b>{selectedClient.lifecycleStatus}</b>
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <select value={targetLifecycle} onChange={(e) => setTargetLifecycle(e.target.value)}
                style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
                <option value="">-- Select target status --</option>
                {LIFECYCLE_OPTIONS[selectedClient.lifecycleStatus]?.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input type="text" placeholder="Reason (optional)" value={lifecycleReason} onChange={(e) => setLifecycleReason(e.target.value)}
                style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button onClick={() => setShowLifecycleModal(false)} className="btn btn-secondary">Cancel</button>
                <button onClick={handleLifecycleTransition} disabled={!targetLifecycle} className="btn btn-primary">Confirm Transition</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ContactsPanel: React.FC<{ clientId: string; contacts: ClientContact[]; setContacts: (c: ClientContact[]) => void }> = ({ clientId, contacts, setContacts }) => {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [designation, setDesignation] = useState(''); const [department, setDepartment] = useState(''); const [isPrimary, setIsPrimary] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadContacts = async () => {
    const data = await api.request<ClientContact[]>(`/clients/${clientId}/contacts`);
    setContacts(data);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      await api.request(`/clients/${clientId}/contacts`, {
        method: 'POST',
        body: JSON.stringify({ name, email, phone, designation, department: department || undefined, isPrimary }),
      });
      setShowForm(false); setName(''); setEmail(''); setPhone(''); setDesignation(''); setDepartment(''); setIsPrimary(false);
      loadContacts();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to add contact'); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (contactId: string) => {
    if (!confirm('Remove this contact?')) return;
    try { await api.request(`/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' }); loadContacts(); }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed to remove contact'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '14px', fontWeight: 600 }}>Contacts ({contacts.length})</span>
        <button onClick={() => setShowForm(true)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Plus size={12} /> Add
        </button>
      </div>
      {contacts.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          No contacts registered
        </div>
      ) : contacts.map(c => (
        <div key={c.id} style={{ padding: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px' }}>{c.name} {c.isPrimary && <span style={{ fontSize: '10px', color: 'var(--accent-secondary)', fontWeight: 700 }}>PRIMARY</span>}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{c.designation}{c.department ? ` • ${c.department}` : ''}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{c.email} • {c.phone}</div>
          </div>
          <button onClick={() => handleDelete(c.id)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}><X size={14} /></button>
        </div>
      ))}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }} onClick={() => setShowForm(false)}>
          <div className="glass-card" style={{ width: '450px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>Add Contact</h4>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <input placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Email *" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Phone *" value={phone} onChange={(e) => setPhone(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Designation *" value={designation} onChange={(e) => setDesignation(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)}
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary contact
                </label>
              </div>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save Contact'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

const ContractsPanel: React.FC<{ clientId: string; contracts: ClientContract[]; setContracts: (c: ClientContract[]) => void }> = ({ clientId, contracts, setContracts }) => {
  const [showForm, setShowForm] = useState(false);
  const [contractNumber, setContractNumber] = useState(''); const [title, setTitle] = useState('');
  const [description, setDescription] = useState(''); const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState(''); const [value, setValue] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const loadContracts = async () => {
    const data = await api.request<ClientContract[]>(`/clients/${clientId}/contracts`);
    setContracts(data);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      await api.request(`/clients/${clientId}/contracts`, {
        method: 'POST',
        body: JSON.stringify({ contractNumber, title, description: description || undefined, effectiveFrom, effectiveTo: effectiveTo || undefined, value, currency: 'INR' }),
      });
      setShowForm(false); setContractNumber(''); setTitle(''); setDescription(''); setEffectiveFrom(''); setEffectiveTo(''); setValue(0);
      loadContracts();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to add contract'); }
    finally { setSubmitting(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '14px', fontWeight: 600 }}>Contracts ({contracts.length})</span>
        <button onClick={() => setShowForm(true)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Plus size={12} /> Add
        </button>
      </div>
      {contracts.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          No contracts registered
        </div>
      ) : contracts.map(c => (
        <div key={c.id} style={{ padding: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600, fontSize: '14px' }}>{c.title}</div>
            <span className="badge" style={{ padding: '2px 8px', fontSize: '11px',
              background: c.status === 'ACTIVE' ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
              color: c.status === 'ACTIVE' ? 'var(--status-active)' : 'var(--text-secondary)' }}>
              {c.status}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {c.contractNumber} • {c.value ? `₹${c.value.toLocaleString()}` : 'N/A'} • {new Date(c.effectiveFrom).toLocaleDateString()} - {c.effectiveTo ? new Date(c.effectiveTo).toLocaleDateString() : 'Open'}
          </div>
        </div>
      ))}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }} onClick={() => setShowForm(false)}>
          <div className="glass-card" style={{ width: '480px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>Add Contract</h4>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <input placeholder="Contract Number *" value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Title *" value={title} onChange={(e) => setTitle(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Effective From *" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Effective To" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)}
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                <input placeholder="Value (₹)" type="number" value={value} onChange={(e) => setValue(Number(e.target.value))}
                  style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
              </div>
              <textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save Contract'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

const BillingPanel: React.FC<{ clientId: string; billing: ClientBilling | null; setBilling: (b: ClientBilling | null) => void }> = ({ clientId, billing, setBilling }) => {
  const [editing, setEditing] = useState(false);
  const [paymentTerms, setPaymentTerms] = useState(billing?.paymentTerms || '');
  const [currency, setCurrency] = useState(billing?.currency || 'INR');
  const [taxIdentifier, setTaxIdentifier] = useState(billing?.taxIdentifier || '');
  const [invoiceCycle, setInvoiceCycle] = useState(billing?.invoiceCycle || '');
  const [billingAddress, setBillingAddress] = useState(billing?.billingAddress || '');
  const [bankAccount, setBankAccount] = useState(billing?.bankAccount || '');
  const [bankName, setBankName] = useState(billing?.bankName || '');
  const [ifscCode, setIfscCode] = useState(billing?.ifscCode || '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (billing) {
      setPaymentTerms(billing.paymentTerms || '');
      setCurrency(billing.currency || 'INR');
      setTaxIdentifier(billing.taxIdentifier || '');
      setInvoiceCycle(billing.invoiceCycle || '');
      setBillingAddress(billing.billingAddress || '');
      setBankAccount(billing.bankAccount || '');
      setBankName(billing.bankName || '');
      setIfscCode(billing.ifscCode || '');
    }
  }, [billing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const data = await api.request<ClientBilling>(`/clients/${clientId}/billing`, {
        method: 'PUT',
        body: JSON.stringify({ paymentTerms: paymentTerms || undefined, currency, taxIdentifier: taxIdentifier || undefined, invoiceCycle: invoiceCycle || undefined, billingAddress: billingAddress || undefined, bankAccount: bankAccount || undefined, bankName: bankName || undefined, ifscCode: ifscCode || undefined }),
      });
      setBilling(data); setEditing(false);
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to save billing'); }
    finally { setSubmitting(false); }
  };

  if (!editing && billing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '14px', fontWeight: 600 }}>Billing Information</span>
          <button onClick={() => setEditing(true)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>Edit</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Payment Terms</div><div style={{ fontWeight: 600, fontSize: '13px' }}>{billing.paymentTerms || '-'}</div></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Currency</div><div style={{ fontWeight: 600, fontSize: '13px' }}>{billing.currency}</div></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Tax ID</div><div style={{ fontWeight: 600, fontSize: '13px' }}>{billing.taxIdentifier || '-'}</div></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Invoice Cycle</div><div style={{ fontWeight: 600, fontSize: '13px' }}>{billing.invoiceCycle || '-'}</div></div>
          {billing.bankAccount && <div style={{ gridColumn: '1 / -1' }}><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Bank</div><div style={{ fontWeight: 600, fontSize: '13px' }}>{billing.bankName} • {billing.bankAccount} • {billing.ifscCode}</div></div>}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span style={{ fontSize: '14px', fontWeight: 600 }}>{billing ? 'Edit Billing' : 'Add Billing'}</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
        <input placeholder="Payment Terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="Tax ID" value={taxIdentifier} onChange={(e) => setTaxIdentifier(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="Invoice Cycle" value={invoiceCycle} onChange={(e) => setInvoiceCycle(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="Billing Address" value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} style={{ gridColumn: '1 / -1', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="Bank Account" value={bankAccount} onChange={(e) => setBankAccount(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="Bank Name" value={bankName} onChange={(e) => setBankName(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
        <input placeholder="IFSC Code" value={ifscCode} onChange={(e) => setIfscCode(e.target.value)}
          style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
      </div>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => { setEditing(false); if (!billing) { } }} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save Billing'}</button>
      </div>
    </form>
  );
};

const CreateClientModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const [clientCode, setClientCode] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.request('/clients', {
        method: 'POST',
        body: JSON.stringify({ clientCode, name, displayName, contactPerson: contactPerson || undefined, contactEmail: contactEmail || undefined, contactPhone: contactPhone || undefined }),
      });
      onCreated();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create client');
    } finally { setSubmitting(false); }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="glass-card" style={{ width: '480px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Building2 size={18} /> Add New Client
        </h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <input placeholder="Client Code *" value={clientCode} onChange={(e) => setClientCode(e.target.value)} required
              style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            <input placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} required
              style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            <input placeholder="Display Name *" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required style={{ gridColumn: '1 / -1', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            <input placeholder="Contact Person" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
              style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            <input placeholder="Contact Email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
              style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            <input placeholder="Contact Phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
              style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Creating...' : 'Create Client'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};
