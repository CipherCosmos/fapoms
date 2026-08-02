import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { Modal, StyledInput, useToast } from '../../components/ui';
import { useCreateBillingInvoice } from '../../hooks/useBilling';
import { useClientsList } from '../../hooks/useClients';
import { api } from '../../services/api';
import { InvoiceType } from '@fapoms/shared';

const TYPES = Object.values(InvoiceType);

interface ApprovedEntry { id: string; entryNumber: string; clientId: string; totalAmount: number; }

export const CreateInvoiceModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { toast } = useToast();
  const create = useCreateBillingInvoice();
  const clients = useClientsList({ limit: 1000 });

  const [clientId, setClientId] = useState('');
  const [type, setType] = useState<InvoiceType>(InvoiceType.CONSOLIDATED);
  const [entries, setEntries] = useState<ApprovedEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [issueDate, setIssueDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [loadingEntries, setLoadingEntries] = useState(false);

  const clientOptions = clients.data?.items ?? [];

  const loadEntries = async (cid: string) => {
    if (!cid) { setEntries([]); setSelectedIds([]); return; }
    setLoadingEntries(true);
    try {
      const res = await api.request<{ data: ApprovedEntry[] }>(`/billing-engine/entries?clientId=${cid}&state=APPROVED`);
      setEntries(res.data ?? []);
      setSelectedIds([]);
    } catch {
      setEntries([]); setSelectedIds([]);
    } finally { setLoadingEntries(false); }
  };

  const toggle = (id: string) =>
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const total = entries.filter((e) => selectedIds.includes(e.id)).reduce((s, e) => s + e.totalAmount, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId) { toast('error', 'Select a client'); return; }
    if (selectedIds.length === 0) { toast('error', 'Select at least one approved entry'); return; }
    try {
      await create.mutateAsync({
        clientId, type, entryIds: selectedIds,
        issueDate: issueDate || undefined, dueDate: dueDate || undefined, notes: notes || undefined,
      });
      toast('success', 'Invoice created');
      onClose();
    } catch (err: any) { toast('error', err?.message || 'Failed to create invoice'); }
  };

  const selStyle: React.CSSProperties = {
    padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%',
  };

  return (
    <Modal open onClose={onClose} title={<><FileText size={18} /> Create Invoice</>} width="620px" maxHeight="90vh" asForm onSubmit={handleSubmit} footer={
      <>
        <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--text-secondary)' }}>Total: <strong>₹{total.toLocaleString('en-IN')}</strong> ({selectedIds.length} entries)</span>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={create.isPending} className="btn btn-primary">{create.isPending ? 'Creating...' : 'Create Invoice'}</button>
      </>
    }>
      <select value={clientId} onChange={(e) => { setClientId(e.target.value); loadEntries(e.target.value); }} style={selStyle}>
        <option value="">Select client…</option>
        {clientOptions.map((c) => <option key={c.id} value={c.id}>{c.displayName ?? c.name}</option>)}
      </select>
      <select value={type} onChange={(e) => setType(e.target.value as InvoiceType)} style={selStyle}>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Approved entries {loadingEntries && '(loading…)'}
        </label>
        {entries.length === 0 && !loadingEntries && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>No APPROVED entries for this client yet.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
          {entries.map((en) => (
            <label key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
              <input type="checkbox" checked={selectedIds.includes(en.id)} onChange={() => toggle(en.id)} />
              <span style={{ fontSize: 13, flex: 1 }}>{en.entryNumber}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>₹{en.totalAmount.toLocaleString('en-IN')}</span>
            </label>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StyledInput placeholder="Issue date" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={{ width: '100%' }} />
        <StyledInput placeholder="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ width: '100%' }} />
      </div>
      <StyledInput placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: '100%' }} />
    </Modal>
  );
};
