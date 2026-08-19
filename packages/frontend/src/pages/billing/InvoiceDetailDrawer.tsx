import React, { useState } from 'react';
import { Send, Banknote, Ban, Undo2 } from 'lucide-react';
import { DetailDrawer, StyledInput, Select, useConfirm, useToast } from '../../components/ui';
import { useBillingInvoice, useSendInvoice, useRecordBillingPayment, useCancelInvoice, useReversePayment } from '../../hooks/useBilling';
import { InvoiceStatus, PaymentMethod, paymentMethodLabel } from '@fapoms/shared';
import { userMessage } from '../../services/errors';
import { todayDateKey } from '../../utils/statusLabels';
import { moneyExact as money } from '../../utils/money';
import { InvoiceStatusPill, LineStatePill, fmtDate, inputStyle, th, td, tdNum } from './shared';

// Named by the shared label layer, never by de-casing the enum — see the same note in
// PayoutsTab. "BANK TRANSFER" is a database value; "Bank Transfer" is a payment method.
const METHODS = Object.values(PaymentMethod);

const Row: React.FC<{ label: string; value: React.ReactNode; strong?: boolean }> = ({ label, value, strong }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border-color)' }}>
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: strong ? 700 : 600, color: strong ? 'var(--text-primary)' : undefined, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </div>
);

/**
 * One invoice: its lines (one per assignment), its payments, and the three things finance does
 * to it — send it, record what the client paid, cancel it (which returns its lines to unbilled).
 */
export const InvoiceDetailDrawer: React.FC<{ invoiceId: string; onClose: () => void; canAct: boolean }> = ({ invoiceId, onClose, canAct }) => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const { data: invoice } = useBillingInvoice(invoiceId);
  const send = useSendInvoice();
  const pay = useRecordBillingPayment();
  const cancel = useCancelInvoice();
  const reverse = useReversePayment();

  const [payOpen, setPayOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.NEFT);
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  // todayDateKey() is the LOCAL calendar day. `new Date().toISOString().slice(0, 10)` is the UTC
  // day, so from 17:30 IST onwards it pre-filled tomorrow's date — finance recording an evening
  // receipt got a payment dated a day in the future, which lands in the wrong reconciliation
  // period and cannot be spotted after the fact.
  const [receivedDate, setReceivedDate] = useState(todayDateKey());
  const [payNote, setPayNote] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  if (!invoice) return <DetailDrawer open onClose={onClose} title="Loading…" width={640}><div /></DetailDrawer>;

  const outstanding = Number(invoice.outstandingAmount);
  const partPaid = Number(invoice.paidAmount) > 0 && outstanding > 0;

  /**
   * Marking an invoice sent is a one-way door: it leaves Draft for Sent, which is the state
   * the client is chased from and the point after which it can no longer be cancelled once any
   * payment lands. That was guarded by `window.confirm` — the browser's own pop-up, which looks
   * exactly like the notification and ad prompts office staff dismiss without reading, and whose
   * "OK" button is the Enter default, so the transition could be made by a keypress aimed at
   * something else. The in-app dialog names the action on its button and states plainly that it
   * cannot be taken back.
   */
  const doSend = async () => {
    const ok = await confirm({
      title: 'Mark this invoice as sent?',
      message: <>Mark <strong>{invoice.invoiceNumber}</strong> as sent to the client{invoice.clientName ? <> ({invoice.clientName})</> : null}. It moves out of Draft and becomes payable, and payments can then be recorded against it.</>,
      confirmLabel: 'Mark as sent',
      reversible: false,
    });
    if (!ok) return;
    try { await send.mutateAsync(invoice.id); toast('success', 'Invoice marked as sent'); }
    catch (e) { toast({ type: 'error', title: 'Could not send', message: userMessage(e) }); }
  };

  const doPay = async () => {
    const amt = parseFloat(amount);
    if (!reference.trim() || isNaN(amt) || amt <= 0) { toast('error', 'Enter the reference and a valid amount'); return; }
    try {
      await pay.mutateAsync({ invoiceId: invoice.id, paymentReference: reference.trim(), method, amount: amt, receivedDate: receivedDate || undefined, notes: payNote || undefined });
      toast('success', 'Payment recorded'); setPayOpen(false); setReference(''); setAmount(''); setPayNote('');
    } catch (e) { toast({ type: 'error', title: 'Could not record the payment', message: userMessage(e) }); }
  };

  const doCancel = async () => {
    if (!cancelReason.trim()) return;
    try {
      await cancel.mutateAsync({ id: invoice.id, reason: cancelReason.trim() });
      toast('success', 'Invoice cancelled — its assignments are invoiceable again'); setCancelOpen(false);
    } catch (e) { toast({ type: 'error', title: 'Could not cancel', message: userMessage(e) }); }
  };

  const doReverse = async (paymentId: string) => {
    const reason = window.prompt('Why is this payment being reversed?');
    if (!reason?.trim()) return;
    try { await reverse.mutateAsync({ paymentId, reason: reason.trim() }); toast('success', 'Payment reversed'); }
    catch (e) { toast({ type: 'error', title: 'Could not reverse', message: userMessage(e) }); }
  };

  return (
    <DetailDrawer
      open onClose={onClose} width={640}
      title={<span><strong style={{ fontSize: 15 }}>{invoice.invoiceNumber}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 6 }}>{invoice.clientName ?? ''}</span></span>}
      subtitle={<InvoiceStatusPill status={invoice.status} partPaid={partPaid} />}
      footer={canAct ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
          {(invoice.status === InvoiceStatus.DRAFT || (invoice.status === InvoiceStatus.ISSUED && Number(invoice.paidAmount) === 0)) && (
            <button onClick={() => setCancelOpen((o) => !o)} className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Ban size={14} /> Cancel invoice</button>
          )}
          {invoice.status === InvoiceStatus.DRAFT && (
            <button onClick={doSend} disabled={send.isPending} className="btn btn-primary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Send size={14} /> Mark as sent</button>
          )}
          {invoice.status === InvoiceStatus.ISSUED && (
            <button onClick={() => setPayOpen((o) => !o)} className="btn btn-primary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Banknote size={14} /> Record payment</button>
          )}
        </div>
      ) : undefined}
    >
      {cancelOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontSize: 12.5 }}>Cancelling returns every line to <strong>Unbilled</strong> so the work can be invoiced again. Say why:</div>
          <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} placeholder="Reason *" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setCancelOpen(false)} className="btn btn-secondary">Keep</button>
            <button onClick={doCancel} disabled={cancel.isPending || !cancelReason.trim()} className="btn btn-primary">Cancel invoice</button>
          </div>
        </div>
      )}

      {payOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <Select value={method} onChange={(v) => setMethod(v as PaymentMethod)} options={METHODS.map((m) => ({ value: m, label: paymentMethodLabel(m) }))} />
            <StyledInput placeholder="Payment reference *" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <StyledInput placeholder={`Amount (outstanding ${money(outstanding)}) *`} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <StyledInput type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
          </div>
          <StyledInput placeholder="Notes" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setAmount(String(outstanding))} className="btn btn-secondary">Full amount</button>
            <button onClick={doPay} disabled={pay.isPending} className="btn btn-primary">{pay.isPending ? 'Recording…' : 'Save payment'}</button>
          </div>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Amounts</h4>
        <Row label="Taxable (subtotal)" value={money(invoice.subtotal)} />
        <Row label="GST" value={`+${money(invoice.taxAmount)}`} />
        <Row label="TDS withheld by client" value={`−${money(invoice.tdsAmount)}`} />
        <Row label="Total" value={money(invoice.total)} strong />
        <Row label="Paid" value={money(invoice.paidAmount)} />
        <Row label="Outstanding" value={money(invoice.outstandingAmount)} strong />
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>Issued {fmtDate(invoice.issueDate)} · due {fmtDate(invoice.dueDate)}</div>
      </div>

      {invoice.entries && invoice.entries.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>Lines ({invoice.entries.length})</h4>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Assignment</th><th style={th}>Branch · Assayer</th><th style={th}>State</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={{ ...th, textAlign: 'right' }}>Paid</th></tr></thead>
              <tbody>
                {invoice.entries.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>{e.assignmentNumber ?? e.entryNumber}</td>
                    <td style={td}>{[e.branchName, e.assayerName].filter(Boolean).join(' · ') || '—'}</td>
                    <td style={td}><LineStatePill state={e.state} /></td>
                    <td style={tdNum}>{money(e.totalAmount)}</td>
                    <td style={tdNum}>{money(e.paidAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {invoice.payments && invoice.payments.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>Payments</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {invoice.payments.map((p) => (
              <div key={p.id} style={{ background: 'var(--bg-tertiary)', padding: 8, borderRadius: 'var(--radius-sm)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.paymentReference} · <span style={{ fontWeight: 700 }}>{money(p.amount)}</span></div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{paymentMethodLabel(p.method)} · {fmtDate(p.receivedDate)}{p.notes ? ` · ${p.notes}` : ''}</div>
                </div>
                {canAct && (
                  <button onClick={() => doReverse(p.id)} disabled={reverse.isPending} title="Reverse this payment" style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11.5 }}>
                    <Undo2 size={13} /> Reverse
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {invoice.notes && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{invoice.notes}</div>}

      {confirmDialog}
    </DetailDrawer>
  );
};
