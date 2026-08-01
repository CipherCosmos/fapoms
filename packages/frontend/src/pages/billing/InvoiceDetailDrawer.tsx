import React, { useState } from 'react';
import { DetailDrawer, StyledInput, useToast } from '../../components/ui';
import { useBillingInvoice, useTransitionBillingInvoice, useRecordBillingPayment } from '../../hooks/useBilling';
import { INVOICE_TRANSITIONS, PaymentMethod } from '@fapoms/shared';
import type { InvoiceStatus } from '@fapoms/shared';

const fmt = (n?: number) => (n ?? 0).toLocaleString('en-IN');
const METHODS = Object.values(PaymentMethod);

const STATUS_COLOR: Record<InvoiceStatus, string> = {
  DRAFT: '#a78bfa', ISSUED: '#60a5fa', PARTIALLY_PAID: '#f59e0b', PAID: '#22c55e',
  DISPUTED: '#ef4444', CANCELLED: '#64748b', VOID: '#64748b',
};

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border-color)' }}>
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: 600 }}>{value}</span>
  </div>
);

export const InvoiceDetailDrawer: React.FC<{ invoiceId: string; onClose: () => void }> = ({ invoiceId, onClose }) => {
  const { toast } = useToast();
  const { data: invoice } = useBillingInvoice(invoiceId);
  const transition = useTransitionBillingInvoice();
  const pay = useRecordBillingPayment();

  const [payOpen, setPayOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.NEFT);
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [receivedDate, setReceivedDate] = useState('');
  const [payNote, setPayNote] = useState('');
  const [nextStatus, setNextStatus] = useState<InvoiceStatus | ''>('');
  const [reason, setReason] = useState('');

  if (!invoice) return <DetailDrawer open onClose={onClose} title="Loading…" width={600}><div /></DetailDrawer>;

  const next = INVOICE_TRANSITIONS[invoice.status] ?? [];

  const doTransition = async () => {
    if (!nextStatus) return;
    try {
      await transition.mutateAsync({ id: invoice.id, status: nextStatus, reason: reason || undefined });
      toast('success', `Invoice → ${nextStatus}`); setNextStatus(''); setReason('');
    } catch (e: any) { toast('error', e?.message || 'Transition failed'); }
  };

  const doPay = async () => {
    const amt = parseFloat(amount);
    if (!reference.trim() || isNaN(amt) || amt <= 0) { toast('error', 'Enter reference and valid amount'); return; }
    try {
      await pay.mutateAsync({
        invoiceId: invoice.id, paymentReference: reference.trim(), method, amount: amt,
        receivedDate: receivedDate || undefined, notes: payNote || undefined,
      });
      toast('success', 'Payment recorded'); setPayOpen(false); setReference(''); setAmount(''); setPayNote(''); setReceivedDate('');
    } catch (e: any) { toast('error', e?.message || 'Payment failed'); }
  };

  return (
    <DetailDrawer
      open onClose={onClose} width={600}
      title={<span><strong style={{ fontSize: 15 }}>{invoice.invoiceNumber}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({invoice.type})</span></span>}
      subtitle={<span style={{ color: STATUS_COLOR[invoice.status], fontWeight: 700 }}>{invoice.status}</span>}
      footer={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
          {next.length > 0 && (
            <>
              <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value as InvoiceStatus)} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff' }}>
                <option value="">Transition…</option>
                {next.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason" style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', width: 120 }} />
              <button onClick={doTransition} disabled={!nextStatus || transition.isPending} className="btn btn-primary">Apply</button>
            </>
          )}
          {invoice.status === 'ISSUED' && (
            <button onClick={() => setPayOpen((o) => !o)} className="btn btn-primary">Record Payment</button>
          )}
        </div>
      }
    >
      {payOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff' }}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <StyledInput placeholder="Payment reference *" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <StyledInput placeholder={`Amount (outstanding ₹${fmt(invoice.outstandingAmount)}) *`} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <StyledInput placeholder="Received date" type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
          </div>
          <StyledInput placeholder="Notes" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
          <button onClick={doPay} disabled={pay.isPending} className="btn btn-primary">{pay.isPending ? 'Recording...' : 'Save Payment'}</button>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Amounts</h4>
        <Row label="Subtotal" value={`₹${fmt(invoice.subtotal)}`} />
        {invoice.taxAmount ? <Row label="Tax" value={`₹${fmt(invoice.taxAmount)}`} /> : null}
        {invoice.discountAmount ? <Row label="Discount" value={`-₹${fmt(invoice.discountAmount)}`} /> : null}
        <Row label="Total" value={<span style={{ color: '#fff', fontWeight: 700 }}>₹{fmt(invoice.total)}</span>} />
        <Row label="Paid" value={`₹${fmt(invoice.paidAmount)}`} />
        <Row label="Outstanding" value={`₹${fmt(invoice.outstandingAmount)}`} />
      </div>

      {invoice.entryIds && invoice.entryIds.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>Entries ({invoice.entryIds.length})</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {invoice.entryIds.map((id) => <span key={id} style={{ fontSize: 12, background: 'var(--bg-tertiary)', padding: '3px 8px', borderRadius: 'var(--radius-sm)' }}>{id}</span>)}
          </div>
        </div>
      )}

      {invoice.payments && invoice.payments.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>Payments</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {invoice.payments.map((p) => (
              <div key={p.id} style={{ background: 'var(--bg-tertiary)', padding: 8, borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>{p.paymentReference}</span>
                  <span style={{ fontWeight: 700 }}>₹{fmt(p.amount)}</span>
                </div>
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{p.method} · {p.status} · {p.receivedDate ? new Date(p.receivedDate).toLocaleDateString() : new Date(p.updatedAt ?? p.createdAt ?? '').toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {invoice.notes && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{invoice.notes}</div>}
    </DetailDrawer>
  );
};
