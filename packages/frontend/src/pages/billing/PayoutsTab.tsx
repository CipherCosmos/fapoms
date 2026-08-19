import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Banknote, PauseCircle, PlayCircle, Receipt } from 'lucide-react';
import { AssayerPayableStatus, PaymentMethod, payableStatusLabel, paymentMethodLabel } from '@fapoms/shared';
import { Modal, Pagination, Select, StyledInput, useConfirm, useToast } from '../../components/ui';
import { usePayouts, useApprovePayouts, usePayPayouts, useHoldPayout } from '../../hooks/useBilling';
import { BILLING_PAGE_SIZE } from '../../services/billing';
import type { PayoutRow } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { moneyTotal as money } from '../../utils/money';
import { Card, Empty, PayoutStatusPill, fmtDate, th, td, tdNum, inputStyle } from './shared';
import { ExpenseReview } from '../ExpenseReview';

/**
 * Payouts — what we owe assayers, and the one gate before paying it.
 *
 * One table, grouped by assayer. Tick rows, then Approve (Due → Approved) or Pay (Approved →
 * Paid, with a bank reference). Hold/release is per row. PAID is only ever reached by recording
 * a payment; there is no status dropdown. Reimbursements of expense claims appear in the same
 * table as their own rows, because an expense payout is the same act as a fee payout.
 */
export type PayoutFilter = 'ALL' | 'PENDING' | 'APPROVED' | 'PAID' | 'HELD';

export const PayoutsTab: React.FC<{ filter: PayoutFilter; onFilter: (f: PayoutFilter) => void; canAct: boolean; canReviewClaims: boolean }> = ({ filter, onFilter, canAct, canReviewClaims }) => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  const [holding, setHolding] = useState<PayoutRow | null>(null);

  const params = {
    status: filter === 'PENDING' || filter === 'APPROVED' || filter === 'PAID' ? (filter as AssayerPayableStatus) : undefined,
    onHold: filter === 'HELD' ? true : undefined,
    page, limit: BILLING_PAGE_SIZE,
  };
  const payouts = usePayouts(params);
  const approve = useApprovePayouts();
  const pay = usePayPayouts();
  const hold = useHoldPayout();

  const rows = payouts.data?.items ?? [];
  const total = payouts.data?.total ?? 0;

  const groups = useMemo(() => {
    const m = new Map<string, { assayerId: string; assayerName: string; assayerCode: string | null; rows: PayoutRow[]; owed: number }>();
    for (const r of rows) {
      const g = m.get(r.assayerId) ?? { assayerId: r.assayerId, assayerName: r.assayerName ?? 'Unknown assayer', assayerCode: r.assayerCode, rows: [], owed: 0 };
      g.rows.push(r);
      if (r.status !== AssayerPayableStatus.PAID && !r.onHold) g.owed += Number(r.totalAmount) - Number(r.paidAmount);
      m.set(r.assayerId, g);
    }
    return [...m.values()];
  }, [rows]);

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const approvable = selectedRows.filter((r) => r.status === AssayerPayableStatus.PENDING && !r.onHold);
  const payable = selectedRows.filter((r) => r.status === AssayerPayableStatus.APPROVED && !r.onHold);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleGroup = (ids: string[]) => setSelected((s) => {
    const n = new Set(s);
    const all = ids.every((id) => n.has(id));
    ids.forEach((id) => (all ? n.delete(id) : n.add(id)));
    return n;
  });

  /**
   * Approve is the gate before money leaves: an approved payout is the one thing Pay will
   * accept, so approving is the decision, and paying is the paperwork that follows it.
   *
   * It had no confirmation at all. The billing rebuild replaced the old PayableModals, which
   * asked "Approve this payable? This authorizes disbursement and is not easily reversed."
   * before every approval, with a single toolbar button wired straight to the mutation — so
   * one click on a header checkbox (which ticks a whole assayer's rows) followed by one click
   * on Approve authorised every selected payout with nothing in between. There is no un-approve
   * in this UI; the only way back is a hold, row by row, before someone pays them.
   *
   * A second click would not have fixed that — it is the same reflex as the first. So the
   * dialog states the count and the rupee total being authorised and makes the user type the
   * total, which cannot be done by reflex and forces them to read the number they are
   * committing to. Nothing about the request itself changes: the same ids, the same call.
   */
  const runApprove = async () => {
    const totalAmount = approvable.reduce((s, p) => s + Number(p.totalAmount), 0);
    const assayers = new Set(approvable.map((p) => p.assayerId)).size;
    const amountText = money(totalAmount);
    // Typed as plain digits, not the formatted "₹1,23,456": the rupee sign and the Indian
    // grouping are awkward to reproduce on a keyboard, and a phrase people cannot type is a
    // phrase they route around. The digits are still the number they must read to type it.
    const amountPhrase = String(Math.round(totalAmount));
    const ok = await confirm({
      title: `Approve ${approvable.length} payout${approvable.length === 1 ? '' : 's'}?`,
      message: (
        <>
          This authorises <strong>{amountText}</strong> to be paid to {assayers} assayer{assayers === 1 ? '' : 's'},
          across {approvable.length} payout{approvable.length === 1 ? '' : 's'}. Approved payouts are the ones finance
          can pay out, so this is the approval to disburse the money.
        </>
      ),
      confirmLabel: `Approve ${amountText}`,
      reversible: false,
      reversibleNote: 'Approving cannot be undone here. To stop one afterwards, you must put it on hold before it is paid.',
      tone: 'danger',
      confirmPhrase: amountPhrase,
    });
    if (!ok) return;
    try {
      const r = await approve.mutateAsync(approvable.map((p) => p.id));
      if (r.refused.length) toast({ type: 'warning', title: `${r.done.length} approved, ${r.refused.length} refused`, message: r.refused.map((x) => x.reason).join(' · ') });
      else toast('success', `${r.done.length} payout${r.done.length === 1 ? '' : 's'} approved`);
      setSelected(new Set());
    } catch (e) { toast({ type: 'error', title: 'Approval failed', message: userMessage(e) }); }
  };

  const changeFilter = (f: PayoutFilter) => { onFilter(f); setPage(1); setSelected(new Set()); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['ALL', 'PENDING', 'APPROVED', 'PAID', 'HELD'] as PayoutFilter[]).map((f) => (
          <button key={f} onClick={() => changeFilter(f)} style={{
            padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
            background: filter === f ? 'var(--status-pending-bg)' : 'transparent', color: filter === f ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: `1px solid ${filter === f ? 'var(--accent-primary)' : 'var(--border-color)'}`,
          }}>
            {f === 'ALL' ? 'All' : f === 'HELD' ? 'On hold' : payableStatusLabel(f)}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{total} payout{total === 1 ? '' : 's'}</span>
        <Link to="/billing/statement" style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>Assayer statements →</Link>
      </div>

      {canAct && selected.size > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selected.size} selected</span>
          <button className="btn btn-primary" disabled={!approvable.length || approve.isPending} onClick={runApprove} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <CheckCircle2 size={14} /> Approve {approvable.length ? `(${approvable.length} · ${money(approvable.reduce((s, p) => s + Number(p.totalAmount), 0))})` : ''}
          </button>
          {/*
            Gated on `pay.isPending` as well as on there being something payable — Approve
            beside it already was, and Pay is the button that actually disburses money. Without
            the in-flight guard the toolbar stayed live while a payment request was on the wire,
            so a slow response invited a second click: the modal reopened over the same
            selection and a second batch of disbursements went out against the same payouts.
            Double-paying is the one mistake on this screen the product cannot walk back.
          */}
          <button className="btn btn-primary" disabled={!payable.length || pay.isPending} onClick={() => setPayOpen(true)} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Banknote size={14} /> Pay {payable.length ? `(${payable.length} · ${money(payable.reduce((s, p) => s + Number(p.totalAmount) - Number(p.paidAmount), 0))})` : ''}
          </button>
          <button className="btn btn-secondary" onClick={() => setSelected(new Set())}>Clear</button>
          {selectedRows.length > approvable.length + payable.length && (
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Held and already-paid rows are skipped.</span>
          )}
        </div>
      )}

      {payouts.isLoading ? <Empty>Loading payouts…</Empty> : groups.length === 0 ? (
        <Empty>{filter === 'ALL' ? 'No payouts yet. They appear here the moment an assignment completes.' : 'Nothing here.'}</Empty>
      ) : (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {canAct && <th style={{ ...th, width: 28 }} />}
                <th style={th}>Assignment</th><th style={th}>Client · Branch</th><th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Fee</th><th style={{ ...th, textAlign: 'right' }}>Travel</th>
                <th style={{ ...th, textAlign: 'right' }}>TDS</th><th style={{ ...th, textAlign: 'right' }}>To pay</th>
                <th style={th}>Booked</th>{canAct && <th style={th} />}
              </tr></thead>
              <tbody>
                {groups.map((g) => (
                  <React.Fragment key={g.assayerId}>
                    <tr style={{ background: 'var(--bg-tertiary)' }}>
                      {canAct && <td style={td}><input type="checkbox" checked={g.rows.every((r) => selected.has(r.id))} onChange={() => toggleGroup(g.rows.map((r) => r.id))} /></td>}
                      <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }} colSpan={2}>
                        <Link to={`/billing/statement?assayer=${g.assayerId}`} style={{ color: 'inherit', textDecoration: 'none' }}>{g.assayerName}</Link>
                        {g.assayerCode && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>{g.assayerCode}</span>}
                      </td>
                      <td style={td} colSpan={4} />
                      <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{money(g.owed)}</td>
                      <td style={td} colSpan={canAct ? 2 : 1} />
                    </tr>
                    {g.rows.map((r) => {
                      const toPay = Number(r.totalAmount) - Number(r.paidAmount);
                      const isReimb = !!r.expenseId;
                      return (
                        <tr key={r.id} style={{ opacity: r.status === AssayerPayableStatus.PAID ? 0.7 : 1 }}>
                          {canAct && <td style={td}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                          <td style={td}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                              {isReimb && <Receipt size={12} style={{ color: 'var(--text-muted)' }} />}{r.assignmentNumber ?? '—'}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{isReimb ? 'Expense reimbursement' : r.payableNumber}</div>
                          </td>
                          <td style={td}>{[r.clientName, r.branchName].filter(Boolean).join(' · ') || '—'}</td>
                          <td style={td}><PayoutStatusPill status={r.status} onHold={r.onHold} holdReason={r.holdReason} /></td>
                          <td style={tdNum}>{money(r.baseAmount)}</td>
                          <td style={tdNum}>{Number(r.travelAmount) ? money(r.travelAmount) : '—'}</td>
                          <td style={tdNum}>{Number(r.tdsAmount) ? `−${money(r.tdsAmount)}` : '—'}</td>
                          <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{money(toPay)}</td>
                          <td style={td}>{fmtDate(r.createdAt)}</td>
                          {canAct && (
                            <td style={{ ...td, whiteSpace: 'nowrap' }}>
                              {r.status !== AssayerPayableStatus.PAID && (
                                <button onClick={() => setHolding(r)} title={r.onHold ? 'Release hold' : 'Put on hold'} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: r.onHold ? 'var(--success)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                                  {r.onHold ? <><PlayCircle size={13} /> Release</> : <><PauseCircle size={13} /> Hold</>}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <Pagination page={page} totalPages={Math.ceil(total / BILLING_PAGE_SIZE)} total={total} pageSize={BILLING_PAGE_SIZE} onPageChange={(p) => { setPage(p); setSelected(new Set()); }} />
          </div>
        </Card>
      )}

      {canReviewClaims && (
        <Card title="Expense claims to review">
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
            Approving a claim books it as a payout for the assayer in the same step; it then appears above, due for approval to pay.
          </div>
          <ExpenseReview />
        </Card>
      )}

      {payOpen && (
        <PayModal
          payables={payable}
          busy={pay.isPending}
          onClose={() => setPayOpen(false)}
          onPay={async (dto) => {
            try {
              const r = await pay.mutateAsync({ payableIds: payable.map((p) => p.id), ...dto });
              if (r.refused.length) toast({ type: 'warning', title: `${r.done.length} paid, ${r.refused.length} refused`, message: r.refused.map((x) => x.reason).join(' · ') });
              else toast('success', `${r.done.length} payout${r.done.length === 1 ? '' : 's'} paid`);
              setPayOpen(false); setSelected(new Set());
            } catch (e) { toast({ type: 'error', title: 'Payment failed', message: userMessage(e) }); }
          }}
        />
      )}

      {holding && (
        <HoldModal
          row={holding}
          busy={hold.isPending}
          onClose={() => setHolding(null)}
          onSubmit={async (reason) => {
            try {
              await hold.mutateAsync({ id: holding.id, onHold: !holding.onHold, reason });
              toast('success', holding.onHold ? 'Hold released' : 'Payout on hold');
              setHolding(null);
            } catch (e) { toast({ type: 'error', title: 'Could not change hold', message: userMessage(e) }); }
          }}
        />
      )}

      {confirmDialog}
    </div>
  );
};

// The dropdown lists the enum's own values, but never its own spelling of them: de-casing
// `BANK_TRANSFER` reads as "BANK TRANSFER" and shouts a database value at the user, while the
// shared label layer already knows this vocabulary and keeps the Indian rails' initialisms
// (NEFT, RTGS, UPI) upper-case where de-casing would have broken them.
const METHODS = Object.values(PaymentMethod);

const PayModal: React.FC<{
  payables: PayoutRow[]; busy: boolean; onClose: () => void;
  onPay: (dto: { paymentReference: string; method: PaymentMethod; paidDate?: string; notes?: string }) => Promise<void>;
}> = ({ payables, busy, onClose, onPay }) => {
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.NEFT);
  const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const total = payables.reduce((s, p) => s + Number(p.totalAmount) - Number(p.paidAmount), 0);
  const assayers = new Set(payables.map((p) => p.assayerId)).size;
  return (
    <Modal open onClose={onClose} title={<><Banknote size={18} /> Pay {payables.length} payout{payables.length === 1 ? '' : 's'}</>} width="520px" asForm
      onSubmit={(e) => { e.preventDefault(); if (!reference.trim()) return; void onPay({ paymentReference: reference.trim(), method, paidDate: paidDate || undefined, notes: notes || undefined }); }}
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--text-secondary)' }}>Total <strong>{money(total)}</strong> to {assayers} assayer{assayers === 1 ? '' : 's'}</span>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={busy || !reference.trim()} className="btn btn-primary">{busy ? 'Paying…' : 'Record payment'}</button>
      </>}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        Each payout is paid in full and recorded as a disbursement. One bank reference may cover the whole batch.
      </div>
      <StyledInput placeholder="Bank / UTR reference *" value={reference} onChange={(e) => setReference(e.target.value)} style={{ width: '100%' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Select value={method} onChange={(v) => setMethod(v as PaymentMethod)} options={METHODS.map((m) => ({ value: m, label: paymentMethodLabel(m) }))} style={{ width: '100%' }} />
        <StyledInput type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} style={{ width: '100%' }} />
      </div>
      <StyledInput placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: '100%' }} />
    </Modal>
  );
};

/**
 * The everyday reasons a payout gets held, offered as one-click options.
 *
 * The reason is mandatory and was free text only, so a finance clerk holding a dozen rows in a
 * morning had to type the same sentence a dozen times — and typed reasons drifted ("bank dtls
 * wrong", "wrong acct") until the assayer statement, where this text is shown, read like a
 * different person wrote each line. These cover what is actually typed; "Other…" keeps the free
 * text for everything else, so nothing that could be said before can no longer be said.
 */
const HOLD_REASONS = [
  'Bank details missing or incorrect',
  'Waiting for the assayer\u2019s invoice',
  'Report still being checked',
  'Client has disputed this assignment',
  'Duplicate of another payout',
];

const HoldModal: React.FC<{ row: PayoutRow; busy: boolean; onClose: () => void; onSubmit: (reason?: string) => Promise<void> }> = ({ row, busy, onClose, onSubmit }) => {
  const [preset, setPreset] = useState('');
  const [reason, setReason] = useState('');
  const releasing = row.onHold;
  // A preset stands on its own; only "Other…" needs anything typed. The submitted value is
  // still a plain sentence either way, so what reaches the API and the statement is unchanged.
  const isOther = preset === '__other__';
  const effectiveReason = isOther ? reason.trim() : preset;
  const reasonReady = releasing || !!effectiveReason;
  return (
    <Modal open onClose={onClose} title={releasing ? 'Release hold' : 'Put payout on hold'} width="460px" asForm
      onSubmit={(e) => { e.preventDefault(); if (!reasonReady) return; void onSubmit(releasing ? undefined : effectiveReason); }}
      footer={<>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={busy || !reasonReady} className="btn btn-primary">{releasing ? 'Release' : 'Hold'}</button>
      </>}>
      <div style={{ fontSize: 13 }}>
        <strong>{row.assignmentNumber ?? row.payableNumber}</strong> · {row.assayerName} · {money(Number(r(row.totalAmount)) - Number(r(row.paidAmount)))}
      </div>
      {releasing ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Held for: <em>{row.holdReason}</em>. Releasing lets it be approved and paid again.</div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>A held payout cannot be approved or paid until released. The reason is shown to finance and on the assayer's statement.</div>
          <Select
            value={preset}
            onChange={(v) => setPreset(v)}
            options={[
              { value: '', label: 'Why is this on hold? *' },
              ...HOLD_REASONS.map((r) => ({ value: r, label: r })),
              { value: '__other__', label: 'Other\u2026' },
            ]}
            style={{ width: '100%' }}
          />
          {isOther && (
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this on hold? *" rows={3} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
          )}
        </>
      )}
    </Modal>
  );
};

const r = (v: unknown) => (v == null ? 0 : Number(v));
