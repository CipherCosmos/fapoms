import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, PauseCircle, PlayCircle, SlidersHorizontal } from 'lucide-react';
import { AssignmentStatus, BillingState } from '@fapoms/shared';
import type { AssayerPayable } from '@fapoms/shared';
import { Modal, Select, useToast } from '../../components/ui';
import { useAssignmentMoney, useEditClientLine, useAssayerInvoiceLookup } from '../../hooks/useBilling';
import { userMessage } from '../../services/errors';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { moneyExact as money } from '../../utils/money';
import { LineStatePill, PayoutStatusPill, InvoiceStatusPill, AssayerInvoiceStatusPill, fmtDate, inputStyle } from './shared';
// The client line and the assayer payout are held for the same reasons — the same "put this on
// hold" action, seen from the client side rather than the assayer side — so this imports
// PayoutsTab's HOLD_REASONS rather than keeping a second list that could drift from it.
import { HOLD_REASONS } from './PayoutsTab';

/**
 * Preset reasons for adjusting a client line's amount (a different action from holding it — this
 * changes what is billed, rather than pausing billing). Seeded from context, the same way
 * HOLD_REASONS was originally: there is no real adjustment history in this dev database yet.
 */
const CLIENT_LINE_ADJUSTMENT_REASONS = [
  'Client disputed the fee',
  'Correcting a data-entry error',
  'Goodwill discount',
  'Contract rate change applied late',
];

/**
 * The money line for one assignment — both ledgers, side by side, as the assignment detail
 * shows them. Every figure is the server's. The only edits here are the two a desk may make
 * before a line is invoiced: an adjustment with a reason, and a hold with a reason.
 */
export const AssignmentMoneyCard: React.FC<{ assignmentId: string; status: string; canEdit: boolean; compact?: boolean }> = ({ assignmentId, status, canEdit, compact }) => {
  const done = status === AssignmentStatus.COMPLETED;
  const money$ = useAssignmentMoney(assignmentId, { enabled: done });
  const { data, isLoading } = money$;
  const [editing, setEditing] = useState(false);
  /**
   * The assayer invoice the fee payable rides, if any. The money line's payable is the raw
   * entity, which carries only `assayerInvoiceId` (the shared AssayerPayable type predates the
   * column, hence the cast); the number/status are looked up under the same cached key as the
   * Assayer Invoices drawer. Called before the early returns — hooks are unconditional.
   */
  const payableInvoiceId = (data?.payable as (AssayerPayable & { assayerInvoiceId?: string | null }) | null | undefined)?.assayerInvoiceId ?? null;
  const invoiceById = useAssayerInvoiceLookup(payableInvoiceId ? [payableInvoiceId] : []);
  const assayerInvoice = payableInvoiceId ? invoiceById.get(payableInvoiceId) : undefined;

  if (!done) return null;
  /**
   * The failed branch has to come before the `!data` branch, because they are the same shape.
   *
   * `isLoading || !data` printed "Loading…" — forever — for every way this fetch can end without
   * data: a 403 from a role that cannot see money, a 404 from a deleted assignment, a 500, a
   * paused retry. A spinner that never stops is the one state an operator cannot act on: they
   * wait, then reload, then call someone. Say which it was instead.
   */
  if (loadFailed(money$)) {
    return (
      <div style={wrap}>
        <span style={title}><Wallet size={11} /> MONEY</span>
        <LoadFailure loads={[{ label: "this assignment's money", query: money$ }]} />
      </div>
    );
  }
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
            {/* The assayer invoice this payout rides — the mirror of the client-invoice line in
                the other box. While it is invited/submitted, approving happens on the invoice,
                not on this payout. */}
            {assayerInvoice && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                {assayerInvoice.invoiceNumber} <AssayerInvoiceStatusPill status={assayerInvoice.status} />
              </div>
            )}
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

/** Local mirror of `assignment-money.ts`'s `round2` — money arithmetic rounded once, no epsilon variants. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

const ClientLineModal: React.FC<{ assignmentId: string; entry: any; onClose: () => void }> = ({ assignmentId, entry, onClose }) => {
  const { toast } = useToast();
  const edit = useEditClientLine();
  const [adjustment, setAdjustment] = useState(String(Number(entry.adjustmentAmount) || ''));
  const [adjustmentReason, setAdjustmentReason] = useState(entry.adjustmentReason ?? '');

  /**
   * A live preview of what this adjustment does to the line, computed the same way the server
   * does (`assignment-money.ts`'s `applyTaxes`, mirrored here for display only — the server is
   * still the one source of truth and re-derives this itself).
   *
   * This field had no preview and no confirmation at all: type a number, click Save, done — the
   * one place on this screen a stray digit changes what a real bank client is billed, with none
   * of the friction `PayoutsTab`'s approve dialog deliberately adds for a payout of the same
   * size. The credit side already has a hard floor on the server (a credit cannot push the line
   * below zero); this surfaces that floor here too, before the click, rather than only as a 400
   * after it.
   */
  const preTaxBase = round2(Number(entry.baseAmount) + Number(entry.travelAmount));
  const adjustmentFloor = -preTaxBase;
  const parsedAmount = adjustment.trim() === '' ? 0 : Number(adjustment);
  const amountIsNumber = Number.isFinite(parsedAmount);
  const belowFloor = amountIsNumber && parsedAmount < adjustmentFloor - 0.005;
  const previewTaxable = amountIsNumber ? round2(Math.max(0, preTaxBase + parsedAmount)) : Number(entry.taxableAmount);
  const taxRate = Number(entry.taxRate) || 0;
  const tdsRate = Number(entry.tdsRate) || 0;
  const previewGst = round2(previewTaxable * (taxRate / 100));
  const previewTds = round2(previewTaxable * (tdsRate / 100));
  const previewTotal = round2(previewTaxable + previewGst - previewTds);
  const totalChanged = amountIsNumber && Math.abs(previewTotal - Number(entry.totalAmount)) > 0.005;
  // A line may already carry an adjustment reason from before this preset list existed (or one
  // typed as free text). If it matches a known preset, show that preset selected; otherwise land
  // on "Other…" with the existing text still in the box, rather than silently discarding it.
  const [adjustmentPreset, setAdjustmentPreset] = useState(() => {
    const existing = entry.adjustmentReason ?? '';
    if (!existing) return '';
    return CLIENT_LINE_ADJUSTMENT_REASONS.includes(existing) ? existing : '__other__';
  });
  const [holdReason, setHoldReason] = useState('');
  const [holdPreset, setHoldPreset] = useState('');
  const busy = edit.isPending;

  const isAdjustmentOther = adjustmentPreset === '__other__';
  const effectiveAdjustmentReason = isAdjustmentOther ? adjustmentReason.trim() : adjustmentPreset;
  const isHoldOther = holdPreset === '__other__';
  const effectiveHoldReason = isHoldOther ? holdReason.trim() : holdPreset;

  const saveAdjustment = async () => {
    const amount = adjustment.trim() === '' ? 0 : Number(adjustment);
    if (!Number.isFinite(amount)) { toast('error', 'Enter a number'); return; }
    if (amount !== 0 && !effectiveAdjustmentReason) { toast('error', 'Say why the line is being adjusted'); return; }
    if (belowFloor) { toast('error', `This credit exceeds the line. The most this line can be reduced by is ${money(preTaxBase)} (to zero).`); return; }
    try {
      await edit.mutateAsync({ assignmentId, patch: { adjustmentAmount: amount, adjustmentReason: effectiveAdjustmentReason || undefined } });
      toast('success', 'Client line adjusted'); onClose();
    } catch (err) { toast({ type: 'error', title: 'Could not adjust', message: userMessage(err) }); }
  };
  const toggleHold = async () => {
    if (!entry.onHold && !effectiveHoldReason) { toast('error', 'Say why the line is on hold'); return; }
    try {
      await edit.mutateAsync({ assignmentId, patch: { onHold: !entry.onHold, holdReason: effectiveHoldReason || undefined } });
      toast('success', entry.onHold ? 'Hold released' : 'Line on hold'); onClose();
    } catch (err) { toast({ type: 'error', title: 'Could not change hold', message: userMessage(err) }); }
  };

  return (
    <Modal open onClose={onClose} title={<><SlidersHorizontal size={16} /> Client line · {entry.entryNumber}</>} width="480px" footer={<button type="button" onClick={onClose} className="btn btn-secondary">Close</button>}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Both edits apply only while the line is unbilled. An invoiced line is a record of what was billed — cancel the invoice to change it.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>Adjustment (₹, negative to reduce)</div>
        <input type="number" step="0.01" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="0" />
        {/* Live preview, computed the same way the server will — so a stray extra digit is
            visible as "New total ₹50,300.00" before the click, not only after it. */}
        {!amountIsNumber ? (
          <div style={{ fontSize: 11, color: 'var(--danger)' }}>Enter a number.</div>
        ) : belowFloor ? (
          <div style={{ fontSize: 11, color: 'var(--danger)' }}>
            This credit exceeds the line. The most this line can be reduced by is {money(preTaxBase)} (to zero).
          </div>
        ) : totalChanged ? (
          <div style={{ fontSize: 11, color: 'var(--warning)' }}>
            New total for this line: <strong>{money(previewTotal)}</strong> (currently {money(entry.totalAmount)})
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No change to the current total of {money(entry.totalAmount)}.</div>
        )}
        <Select
          value={adjustmentPreset}
          onChange={setAdjustmentPreset}
          options={[
            { value: '', label: 'Reason (required unless 0) *' },
            ...CLIENT_LINE_ADJUSTMENT_REASONS.map((r) => ({ value: r, label: r })),
            { value: '__other__', label: 'Other…' },
          ]}
          style={{ width: '100%' }}
        />
        {isAdjustmentOther && (
          <input value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="Reason (required unless 0)" />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={saveAdjustment} disabled={busy || !amountIsNumber || belowFloor} className="btn btn-primary">Save adjustment</button></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>{entry.onHold ? <><PlayCircle size={13} /> Release hold</> : <><PauseCircle size={13} /> Put on hold</>}</div>
        {entry.onHold ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Held for: <em>{entry.holdReason}</em>. Releasing lets it be invoiced.</div>
        ) : (
          <>
            <Select
              value={holdPreset}
              onChange={setHoldPreset}
              options={[
                { value: '', label: 'Why is this line on hold? *' },
                ...HOLD_REASONS.map((r) => ({ value: r, label: r })),
                { value: '__other__', label: 'Other…' },
              ]}
              style={{ width: '100%' }}
            />
            {isHoldOther && (
              <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="Why is this line on hold? *" />
            )}
          </>
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
