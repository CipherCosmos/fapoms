import React, { useState } from 'react';
import { DetailDrawer, useToast } from '../../components/ui';
import { useBillingEntry, useTransitionBillingEntry, useAdjustBillingEntry, useSplitBillingEntry, useBillingHistory } from '../../hooks/useBilling';
import { BILLING_STATE_TRANSITIONS } from '@fapoms/shared';
import type { BillingState } from '@fapoms/shared';
import { BillingEntityType } from '@fapoms/shared';
import { userMessage } from '../../services/errors';

const fmt = (n?: number) => (n ?? 0).toLocaleString('en-IN');

const STATE_COLOR: Record<BillingState, string> = {
  NOT_BILLABLE: 'var(--text-muted)', PENDING_BILLING: 'var(--text-secondary)',
  READY_FOR_BILLING: 'var(--accent)', DRAFT: 'var(--accent)', SUBMITTED: 'var(--warning)',
  UNDER_REVIEW: 'var(--accent)', REJECTED: 'var(--danger)', APPROVED: 'var(--success)',
  INVOICED: 'var(--success)', PARTIALLY_PAID: 'var(--warning)', PAID: 'var(--success)',
  ON_HOLD: 'var(--text-muted)', DISPUTED: 'var(--danger)', CANCELLED: 'var(--text-muted)', ADJUSTED: 'var(--danger)',
};

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border-color)' }}>
    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</span>
  </div>
);

export const EntryDetailDrawer: React.FC<{ entryId: string; onClose: () => void }> = ({ entryId, onClose }) => {
  const { toast } = useToast();
  const { data: entry } = useBillingEntry(entryId);
  const { data: history } = useBillingHistory({ entityType: BillingEntityType.ENTRY });
  const transition = useTransitionBillingEntry();
  const adjust = useAdjustBillingEntry();
  const split = useSplitBillingEntry();

  const [splitOpen, setSplitOpen] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState('');
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [reason, setReason] = useState('');
  const [selectedNext, setSelectedNext] = useState<BillingState | ''>('');

  if (!entry) return <DetailDrawer open onClose={onClose} title="Loading…" width={620}><div /></DetailDrawer>;

  const entryHistory = (history ?? []).filter((h) => h.entityId === entry.id);
  const nextStates = BILLING_STATE_TRANSITIONS[entry.state] ?? [];

  const doTransition = async () => {
    if (!selectedNext) return;
    if (['APPROVED', 'INVOICED', 'PAID'].includes(selectedNext) && !window.confirm(`Move this entry to ${selectedNext}? This locks the amount and cannot be undone.`)) return;
    try {
      await transition.mutateAsync({ id: entry.id, status: selectedNext, reason: reason || undefined });
      toast('success', `Moved to ${selectedNext}`);
      setSelectedNext(''); setReason('');
    } catch (e: any) { toast({ type: 'error', title: 'Transition failed', message: userMessage(e) }); }
  };

  const doAdjust = async () => {
    const delta = parseFloat(adjustDelta);
    if (isNaN(delta) || !adjustReason.trim()) { toast('error', 'Enter delta and reason'); return; }
    try {
      await adjust.mutateAsync({ id: entry.id, delta, reason: adjustReason });
      toast('success', 'Entry adjusted'); setAdjustOpen(false); setAdjustDelta(''); setAdjustReason('');
    } catch (e: any) { toast({ type: 'error', title: 'Adjust failed', message: userMessage(e) }); }
  };

  const doSplit = async () => {
    const amounts = splitAmounts.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
    if (amounts.length < 2) { toast('error', 'Enter 2+ comma-separated amounts'); return; }
    try {
      await split.mutateAsync({ id: entry.id, amounts });
      toast('success', 'Entry split'); setSplitOpen(false); setSplitAmounts('');
    } catch (e: any) { toast({ type: 'error', title: 'Split failed', message: userMessage(e) }); }
  };

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width={620}
      title={<span><strong style={{ fontSize: 15 }}>{entry.entryNumber}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({entry.level})</span></span>}
      subtitle={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: STATE_COLOR[entry.state], fontWeight: 700 }}>{entry.state}</span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>payment: {entry.paymentState}</span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entry.pricingModel}</span>
        </span>
      }
      footer={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
          {nextStates.length > 0 && (
            <>
              <select value={selectedNext} onChange={(e) => setSelectedNext(e.target.value as BillingState)} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}>
                <option value="">Transition…</option>
                {nextStates.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)" style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', width: 140 }} />
              <button onClick={doTransition} disabled={!selectedNext || transition.isPending} className="btn btn-primary">Apply</button>
            </>
          )}
          <button onClick={() => setAdjustOpen((o) => !o)} className="btn btn-secondary">Adjust</button>
          <button onClick={() => setSplitOpen((o) => !o)} className="btn btn-secondary">Split</button>
        </div>
      }
    >
      {adjustOpen && (
        <div style={{ display: 'flex', gap: 8, background: 'var(--bg-tertiary)', padding: 10, borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
          <input value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} placeholder="delta (+/-)" type="number" style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', flex: 1 }} />
          <input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="reason *" style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', flex: 1 }} />
          <button onClick={doAdjust} disabled={adjust.isPending} className="btn btn-primary">Save</button>
        </div>
      )}
      {splitOpen && (
        <div style={{ display: 'flex', gap: 8, background: 'var(--bg-tertiary)', padding: 10, borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
          <input value={splitAmounts} onChange={(e) => setSplitAmounts(e.target.value)} placeholder="e.g. 5000, 3000, 2000" style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', flex: 1 }} />
          <button onClick={doSplit} disabled={split.isPending} className="btn btn-primary">Split</button>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Money</h4>
        <Row label="Base amount" value={`₹${fmt(entry.baseAmount)}`} />
        {entry.travelAmount ? <Row label="Travel" value={`₹${fmt(entry.travelAmount)}`} /> : null}
        {entry.adjustmentAmount ? <Row label="Adjustment" value={`₹${fmt(entry.adjustmentAmount)}`} /> : null}
        {entry.discountAmount ? <Row label="Discount" value={`-₹${fmt(entry.discountAmount)}`} /> : null}
        {entry.taxAmount ? <Row label={`Tax (${entry.taxRate ?? ''}%)`} value={`₹${fmt(entry.taxAmount)}`} /> : null}
        {entry.tdsAmount ? <Row label="TDS" value={`-₹${fmt(entry.tdsAmount)}`} /> : null}
        <Row label="Total" value={<span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>₹{fmt(entry.totalAmount)}</span>} />
        <Row label="Billed" value={`₹${fmt(entry.billedAmount)}`} />
        <Row label="Paid" value={`₹${fmt(entry.paidAmount)}`} />
        <Row label="Outstanding" value={`₹${fmt(entry.outstandingAmount)}`} />
      </div>

      {entry.rate != null && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Pricing</h4>
          <Row label="Model" value={entry.pricingModel} />
          <Row label="Rate" value={`₹${fmt(entry.rate)}`} />
          {entry.quantity != null ? <Row label="Quantity" value={String(entry.quantity)} /> : null}
        </div>
      )}

      {entry.description && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Description</h4>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>{entry.description}</p>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px', color: 'var(--text-primary)' }}>History</h4>
        {entryHistory.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No history yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entryHistory.map((h) => (
            <div key={h.id} style={{ background: 'var(--bg-tertiary)', padding: 10, borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{h.action}</span>
                <span style={{ color: 'var(--text-muted)' }}>{new Date(h.occurredAt).toLocaleString()}</span>
              </div>
              {(h.fromState || h.toState) && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {h.fromState && <span style={{ color: STATE_COLOR[h.fromState as BillingState] }}>{h.fromState}</span>}
                  {h.fromState && h.toState && <span> → </span>}
                  {h.toState && <span style={{ color: STATE_COLOR[h.toState as BillingState] }}>{h.toState}</span>}
                </div>
              )}
              {h.reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{h.reason}</div>}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{h.userName ?? h.userId ?? ''}</div>
            </div>
          ))}
        </div>
      </div>
    </DetailDrawer>
  );
};
