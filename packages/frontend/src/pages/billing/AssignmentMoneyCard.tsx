import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, PauseCircle, PlayCircle, SlidersHorizontal } from 'lucide-react';
import { AssignmentStatus, BillingState } from '@fapoms/shared';
import { Modal, useToast } from '../../components/ui';
import { useAssignmentMoney, useEditClientLine } from '../../hooks/useBilling';
import { userMessage } from '../../services/errors';
import { moneyExact as money } from '../../utils/money';
import { LineStatePill, PayoutStatusPill, InvoiceStatusPill, fmtDate, inputStyle } from './shared';

/**
 * The money line for one assignment — both ledgers, side by side, as the assignment detail
 * shows them. Every figure is the server's. The only edits here are the two a desk may make
 * before a line is invoiced: an adjustment with a reason, and a hold with a reason.
 */
export const AssignmentMoneyCard: React.FC<{ assignmentId: string; status: string; canEdit: boolean; compact?: boolean }> = ({ assignmentId, status, canEdit, compact }) => {
  const done = status === AssignmentStatus.COMPLETED;
  const { data, isLoading } = useAssignmentMoney(assignmentId, { enabled: done });
  const [editing, setEditing] = useState(false);

  if (!done) return null;
  if (isLoading || !data) {
    return <div style={wrap}><span style={title}><Wallet size={11} /> MONEY</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading…</span></div>;
  }

  if (!data.booked) {
    return (
      <div style={wrap}>
        <span style={title}><Wallet size={11} /> MONEY</span>
        <span style={{ fontSize: 11.5, color: 'var(--warning)' }}>
          {data.fee ? 'Completed but not booked yet — Billing → Reconcile will book it.' : 'Completed with no fee on the assignment — nothing to book.'}
        </span>
      </div>
    );
  }

  const p = data.payable;
  const e = data.entry;
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={title}><Wallet size={11} /> MONEY</span>
        <Link to="/billing" style={{ fontSize: 10.5, color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>Billing →</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 8 }}>
        {p && (
          <div style={box}>
            <div style={boxHead}><span>Assayer payout</span><PayoutStatusPill status={p.status} onHold={p.onHold} holdReason={p.holdReason} /></div>
            <Row k="Fee" v={money(p.baseAmount)} />
            {Number(p.travelAmount) > 0 && <Row k="Travel" v={money(p.travelAmount)} />}
            {Number(p.tdsAmount) > 0 && <Row k="TDS withheld" v={`−${money(p.tdsAmount)}`} />}
            <Row k="To pay" v={money(p.totalAmount)} strong />
            {Number(p.paidAmount) > 0 && <Row k="Paid" v={money(p.paidAmount)} />}
            {data.reimbursements.length > 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
                + {data.reimbursements.length} expense reimbursement{data.reimbursements.length === 1 ? '' : 's'} ({money(data.reimbursements.reduce((s, r) => s + Number(r.totalAmount), 0))})
              </div>
            )}
          </div>
        )}
        {e && (
          <div style={box}>
            <div style={boxHead}>
              <span>Client line</span>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <LineStatePill state={e.state} onHold={e.onHold} holdReason={e.holdReason} />
                {canEdit && e.state === BillingState.UNBILLED && (
                  <button onClick={() => setEditing(true)} title="Adjust or hold this line" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'inline-flex' }}><SlidersHorizontal size={12} /></button>
                )}
              </span>
            </div>
            <Row k="Base" v={money(e.baseAmount)} />
            {Number(e.travelAmount) > 0 && <Row k="Travel" v={money(e.travelAmount)} />}
            {Number(e.adjustmentAmount) !== 0 && <Row k={`Adjustment${e.adjustmentReason ? ` (${e.adjustmentReason})` : ''}`} v={money(e.adjustmentAmount)} />}
            <Row k="GST" v={`+${money(e.taxAmount)}`} />
            <Row k="TDS by client" v={`−${money(e.tdsAmount)}`} />
            <Row k="Total" v={money(e.totalAmount)} strong />
            {data.invoice && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                {data.invoice.invoiceNumber} <InvoiceStatusPill status={data.invoice.status} /> due {fmtDate(data.invoice.dueDate)}
              </div>
            )}
          </div>
        )}
      </div>
      {editing && e && <ClientLineModal assignmentId={assignmentId} entry={e} onClose={() => setEditing(false)} />}
    </div>
  );
};

const ClientLineModal: React.FC<{ assignmentId: string; entry: any; onClose: () => void }> = ({ assignmentId, entry, onClose }) => {
  const { toast } = useToast();
  const edit = useEditClientLine();
  const [adjustment, setAdjustment] = useState(String(Number(entry.adjustmentAmount) || ''));
  const [adjustmentReason, setAdjustmentReason] = useState(entry.adjustmentReason ?? '');
  const [holdReason, setHoldReason] = useState('');
  const busy = edit.isPending;

  const saveAdjustment = async () => {
    const amount = adjustment.trim() === '' ? 0 : Number(adjustment);
    if (!Number.isFinite(amount)) { toast('error', 'Enter a number'); return; }
    if (amount !== 0 && !adjustmentReason.trim()) { toast('error', 'Say why the line is being adjusted'); return; }
    try {
      await edit.mutateAsync({ assignmentId, patch: { adjustmentAmount: amount, adjustmentReason: adjustmentReason.trim() || undefined } });
      toast('success', 'Client line adjusted'); onClose();
    } catch (err) { toast({ type: 'error', title: 'Could not adjust', message: userMessage(err) }); }
  };
  const toggleHold = async () => {
    if (!entry.onHold && !holdReason.trim()) { toast('error', 'Say why the line is on hold'); return; }
    try {
      await edit.mutateAsync({ assignmentId, patch: { onHold: !entry.onHold, holdReason: holdReason.trim() || undefined } });
      toast('success', entry.onHold ? 'Hold released' : 'Line on hold'); onClose();
    } catch (err) { toast({ type: 'error', title: 'Could not change hold', message: userMessage(err) }); }
  };

  return (
    <Modal open onClose={onClose} title={<><SlidersHorizontal size={16} /> Client line · {entry.entryNumber}</>} width="480px" footer={<button type="button" onClick={onClose} className="btn btn-secondary">Close</button>}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Both edits apply only while the line is unbilled. An invoiced line is a record of what was billed — cancel the invoice to change it.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>Adjustment (₹, negative to reduce)</div>
        <input type="number" step="0.01" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="0" />
        <input value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="Reason (required unless 0)" />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={saveAdjustment} disabled={busy} className="btn btn-primary">Save adjustment</button></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>{entry.onHold ? <><PlayCircle size={13} /> Release hold</> : <><PauseCircle size={13} /> Put on hold</>}</div>
        {entry.onHold ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Held for: <em>{entry.holdReason}</em>. Releasing lets it be invoiced.</div>
        ) : (
          <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="Why is this line on hold? *" />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={toggleHold} disabled={busy} className="btn btn-secondary">{entry.onHold ? 'Release' : 'Hold'}</button></div>
      </div>
    </Modal>
  );
};

const Row: React.FC<{ k: string; v: string; strong?: boolean }> = ({ k, v, strong }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '2px 0' }}>
    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
    <span style={{ fontWeight: strong ? 700 : 600, color: strong ? 'var(--text-primary)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{v}</span>
  </div>
);

const wrap: React.CSSProperties = { padding: '10px 16px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 6 };
const title: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.3px', display: 'inline-flex', alignItems: 'center', gap: 4 };
const box: React.CSSProperties = { background: 'var(--bg-surface-2)', border: '1px solid var(--border-hair, var(--border-color))', borderRadius: 'var(--radius-sm)', padding: '7px 9px' };
const boxHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 };
