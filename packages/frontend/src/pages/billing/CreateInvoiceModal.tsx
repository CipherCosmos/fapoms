import React, { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { Modal, StyledInput, useToast } from '../../components/ui';
import { useCreateBillingInvoice } from '../../hooks/useBilling';
import type { InvoiceableClient } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { moneyTotal as money } from '../../utils/money';
import { HoldPill, fmtDate } from './shared';

/**
 * Invoice a client: tick the completed assignments to put on it. Totals are the server's line
 * totals; the due date comes from the client's payment terms unless overridden.
 */
export const CreateInvoiceModal: React.FC<{ client: InvoiceableClient; onClose: () => void; onCreated: (invoiceId: string) => void }> = ({ client, onClose, onCreated }) => {
  const { toast } = useToast();
  const create = useCreateBillingInvoice();
  const eligible = useMemo(() => client.lines.filter((l) => !l.onHold), [client.lines]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(eligible.map((l) => l.assignmentId)));
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');

  const chosen = eligible.filter((l) => selected.has(l.assignmentId));
  const subtotal = chosen.reduce((s, l) => s + l.taxableAmount, 0);
  const gst = chosen.reduce((s, l) => s + l.taxAmount, 0);
  const tds = chosen.reduce((s, l) => s + l.tdsAmount, 0);
  const total = chosen.reduce((s, l) => s + l.totalAmount, 0);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen.length) { toast('error', 'Pick at least one assignment'); return; }
    try {
      const inv = await create.mutateAsync({
        clientId: client.clientId, assignmentIds: chosen.map((l) => l.assignmentId),
        issueDate: issueDate || undefined, dueDate: dueDate || undefined, notes: notes || undefined,
      });
      toast('success', `${inv.invoiceNumber} created as a draft`);
      onCreated(inv.id);
    } catch (err) { toast({ type: 'error', title: 'Could not create the invoice', message: userMessage(err) }); }
  };

  return (
    <Modal open onClose={onClose} title={<><FileText size={18} /> Invoice {client.clientName}</>} width="680px" maxHeight="90vh" asForm onSubmit={submit} footer={
      <>
        <span style={{ marginRight: 'auto', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {chosen.length} of {eligible.length} · taxable {money(subtotal)} + GST {money(gst)} − TDS {money(tds)} = <strong style={{ color: 'var(--text-primary)' }}>{money(total)}</strong>
        </span>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={create.isPending || !chosen.length} className="btn btn-primary">{create.isPending ? 'Creating…' : 'Create draft invoice'}</button>
      </>
    }>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Completed assignments</label>
        <span style={{ fontSize: 12 }}>
          <button type="button" onClick={() => setSelected(new Set(eligible.map((l) => l.assignmentId)))} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>All</button>
          {' · '}
          <button type="button" onClick={() => setSelected(new Set())} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>None</button>
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
        {client.lines.map((l) => (
          <label key={l.entryId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', cursor: l.onHold ? 'not-allowed' : 'pointer', opacity: l.onHold ? 0.6 : 1 }}>
            <input type="checkbox" disabled={l.onHold} checked={!l.onHold && selected.has(l.assignmentId)} onChange={() => toggle(l.assignmentId)} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{l.assignmentNumber ?? l.entryNumber}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 8 }}>{[l.branchName, l.projectName, l.assayerName].filter(Boolean).join(' · ')}</span>
              {l.onHold && <span style={{ marginLeft: 8 }}><HoldPill reason={l.holdReason} /></span>}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(l.serviceDate)}</span>
            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{money(l.totalAmount)}</span>
          </label>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>Issue date
          <StyledInput type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>Due date <span style={{ fontWeight: 400 }}>(blank = client's payment terms)</span>
          <StyledInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ width: '100%' }} />
        </label>
      </div>
      <StyledInput placeholder="Notes for the invoice" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: '100%' }} />
    </Modal>
  );
};
