import React, { useMemo, useState } from 'react';
import { CheckCircle2, Ban, Receipt, FileText } from 'lucide-react';
import { AssayerInvoiceStatus } from '@fapoms/shared';
import type { AssayerPayableStatus } from '@fapoms/shared';
import { DetailDrawer, Pagination, Select, useConfirm, useToast } from '../../components/ui';
import { useAssayerInvoices, useAssayerInvoice, useApproveAssayerInvoice, useCancelAssayerInvoice } from '../../hooks/useBilling';
import { BILLING_PAGE_SIZE } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { moneyTotal as money, moneyExact } from '../../utils/money';
import { Card, Empty, AssayerInvoiceStatusPill, PayoutStatusPill, assayerInvoiceStatusLabel, fmtDate, inputStyle, th, td, tdNum } from './shared';

/**
 * Assayer Invoices — the consent loop, from the desk's side.
 *
 * An invoice here is not priced by anyone: it is the set of an assayer's unbilled payouts,
 * frozen at invite, that the assayer has been shown (their first sight of money anywhere) and
 * asked to confirm. Invited → the assayer's queue; Submitted → OURS — approving it approves
 * every pending payout on it in one step, which is why the approve dialog carries the same
 * typed-total friction as the Payouts tab's bulk approve. There is no reject: cancel with a
 * reason, fix the underlying payouts, re-invite from Payouts.
 */
export type AssayerInvoiceFilter = 'ALL' | AssayerInvoiceStatus;

const FILTERS: AssayerInvoiceFilter[] = [
  'ALL',
  AssayerInvoiceStatus.INVITED,
  AssayerInvoiceStatus.SUBMITTED,
  AssayerInvoiceStatus.APPROVED,
  AssayerInvoiceStatus.CANCELLED,
];

export const AssayerInvoicesTab: React.FC<{ filter: AssayerInvoiceFilter; onFilter: (f: AssayerInvoiceFilter) => void; canAct: boolean }> = ({ filter, onFilter, canAct }) => {
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const invoices = useAssayerInvoices({ status: filter === 'ALL' ? undefined : filter, page, limit: BILLING_PAGE_SIZE });
  const total = invoices.data?.total ?? 0;

  /**
   * SUBMITTED first: a submitted invoice is the one thing on this list waiting on OPS (the
   * assayer has confirmed and can do nothing more), so it outranks the newest invite. Stable
   * within each half, keeping the server's newest-first order. Sorted over the fetched page —
   * the SUBMITTED filter button is the complete action lane when the book outgrows one page.
   */
  const rows = useMemo(() => {
    const items = invoices.data?.items ?? [];
    const rank = (s: AssayerInvoiceStatus) => (s === AssayerInvoiceStatus.SUBMITTED ? 0 : 1);
    return [...items].sort((a, b) => rank(a.status) - rank(b.status));
  }, [invoices.data?.items]);

  const changeFilter = (f: AssayerInvoiceFilter) => { onFilter(f); setPage(1); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f} onClick={() => changeFilter(f)} style={{
            padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
            background: filter === f ? 'var(--status-pending-bg)' : 'transparent', color: filter === f ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: `1px solid ${filter === f ? 'var(--accent-primary)' : 'var(--border-color)'}`,
          }}>
            {f === 'ALL' ? 'All' : assayerInvoiceStatusLabel(f)}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{total} invoice{total === 1 ? '' : 's'}</span>
      </div>

      {invoices.isLoading ? <Empty>Loading assayer invoices…</Empty> : invoices.isError ? (
        <Empty>Could not load assayer invoices — this is not saying there are none. Check your connection and try again.</Empty>
      ) : rows.length === 0 ? (
        <Empty>
          {filter === 'ALL'
            ? 'No assayer invoices yet. Invite assayers from Payouts; submitted invoices appear here for approval.'
            : filter === AssayerInvoiceStatus.SUBMITTED
              ? 'Nothing waiting for approval. Invite assayers from Payouts; submitted invoices appear here for approval.'
              : 'Nothing here.'}
        </Empty>
      ) : (
        <Card title={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FileText size={14} /> Assayer invoices</span>}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Invoice</th><th style={th}>Assayer</th><th style={th}>Status</th>
                <th style={th}>Invited</th><th style={th}>Submitted</th>
                <th style={{ ...th, textAlign: 'right' }}>Lines</th><th style={{ ...th, textAlign: 'right' }}>Total</th>
              </tr></thead>
              <tbody>
                {rows.map((inv) => (
                  <tr key={inv.id} onClick={() => setOpenId(inv.id)} style={{ cursor: 'pointer', opacity: inv.status === AssayerInvoiceStatus.CANCELLED ? 0.7 : 1 }}>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>{inv.invoiceNumber}</td>
                    <td style={td}>
                      {inv.assayerName ?? '—'}
                      {inv.assayerCode && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{inv.assayerCode}</span>}
                    </td>
                    <td style={td}><AssayerInvoiceStatusPill status={inv.status} /></td>
                    <td style={td}>{fmtDate(inv.invitedAt)}</td>
                    <td style={td}>{fmtDate(inv.submittedAt)}</td>
                    <td style={tdNum}>{inv.lineCount}</td>
                    <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{money(inv.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <Pagination page={page} totalPages={Math.ceil(total / BILLING_PAGE_SIZE)} total={total} pageSize={BILLING_PAGE_SIZE} onPageChange={setPage} />
          </div>
        </Card>
      )}

      {openId && <AssayerInvoiceDrawer invoiceId={openId} onClose={() => setOpenId(null)} canAct={canAct} />}
    </div>
  );
};

/**
 * Preset reasons for cancelling an invitation, seeded from what actually sends ops back to fix
 * things — same preset+Other shape as the client-invoice cancel, so the API still receives one
 * plain required sentence. Cancelling is also the "reject" path: there is no REJECTED state.
 */
const CANCEL_ASSAYER_INVOICE_REASONS = [
  'A payout on it needs correcting first',
  'Assayer reported a problem with the figures',
  'Wrong or missing lines — will re-invite',
  'Invited by mistake',
];

const AmountRow: React.FC<{ label: string; value: string; strong?: boolean }> = ({ label, value, strong }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border-color)' }}>
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: strong ? 700 : 600, color: strong ? 'var(--text-primary)' : undefined, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </div>
);

/**
 * One assayer invoice: header, per-line review (fee vs expense lines labelled, with each line's
 * own base/travel/TDS/net), and the two things ops does to it — approve, or cancel with a
 * reason. Every refusal the server sends (a held line, totals drift, an already-moved status)
 * is a sentence written for a human and is shown verbatim.
 */
export const AssayerInvoiceDrawer: React.FC<{ invoiceId: string; onClose: () => void; canAct: boolean }> = ({ invoiceId, onClose, canAct }) => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const { data: invoice } = useAssayerInvoice(invoiceId);
  const approve = useApproveAssayerInvoice();
  const cancel = useCancelAssayerInvoice();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPreset, setCancelPreset] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  // A preset stands on its own; only "Other…" needs anything typed — same rule as the client
  // invoice's cancel panel, so what reaches the API is a plain sentence either way.
  const isCancelOther = cancelPreset === '__other__';
  const effectiveCancelReason = isCancelOther ? cancelReason.trim() : cancelPreset;

  if (!invoice) return <DetailDrawer open onClose={onClose} title="Loading…" width={680}><div /></DetailDrawer>;

  const heldLines = invoice.lines.filter((l) => l.onHold);

  /**
   * Approving is TWO approvals in one gesture: the invoice, and every still-pending payout on
   * it — after this, the amounts count as the assayer's visible earnings and the payouts are
   * what finance pays. Same friction as PayoutsTab's bulk approve, for the same reason: a
   * second click is the same reflex as the first, so the dialog restates the line count and
   * the rupee total and makes the user type the total's digits.
   */
  const doApprove = async () => {
    const amountText = money(invoice.totalAmount);
    const amountPhrase = String(Math.round(Number(invoice.totalAmount)));
    const ok = await confirm({
      title: `Approve ${invoice.invoiceNumber}?`,
      message: (
        <>
          This accepts what {invoice.assayerName ?? 'the assayer'} confirmed: <strong>{invoice.lineCount} line{invoice.lineCount === 1 ? '' : 's'}</strong> totalling{' '}
          <strong>{amountText}</strong>. Every pending payout on it is approved in the same step, and these
          amounts then appear as the assayer&rsquo;s earnings.
        </>
      ),
      confirmLabel: `Approve ${amountText}`,
      reversible: false,
      reversibleNote: 'Approving cannot be undone here. To stop a payout afterwards, put it on hold before it is paid.',
      tone: 'danger',
      confirmPhrase: amountPhrase,
    });
    if (!ok) return;
    try {
      await approve.mutateAsync(invoice.id);
      toast('success', `${invoice.invoiceNumber} approved — its payouts are approved with it`);
    } catch (e) {
      // The server's refusals here carry the whole story (which payable is held, what drifted
      // by how much, what to do next) — shown verbatim, never paraphrased.
      toast({ type: 'error', title: 'Could not approve', message: userMessage(e) });
    }
  };

  const doCancel = async () => {
    if (!effectiveCancelReason) return;
    try {
      await cancel.mutateAsync({ id: invoice.id, reason: effectiveCancelReason });
      toast('success', 'Invitation cancelled — its payouts can be invited again');
      setCancelOpen(false); setCancelPreset(''); setCancelReason('');
    } catch (e) { toast({ type: 'error', title: 'Could not cancel', message: userMessage(e) }); }
  };

  const canApprove = canAct && invoice.status === AssayerInvoiceStatus.SUBMITTED;
  const canCancel = canAct && (invoice.status === AssayerInvoiceStatus.INVITED || invoice.status === AssayerInvoiceStatus.SUBMITTED);

  return (
    <DetailDrawer
      open onClose={onClose} width={680}
      title={<span><strong style={{ fontSize: 15 }}>{invoice.invoiceNumber}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 6 }}>{[invoice.assayerName, invoice.assayerCode].filter(Boolean).join(' · ')}</span></span>}
      subtitle={<AssayerInvoiceStatusPill status={invoice.status} />}
      footer={(canApprove || canCancel) ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
          {canCancel && (
            <button onClick={() => setCancelOpen((o) => !o)} className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Ban size={14} /> Cancel invoice</button>
          )}
          {canApprove && (
            <button onClick={doApprove} disabled={approve.isPending} className="btn btn-primary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <CheckCircle2 size={14} /> Approve ({invoice.lineCount} · {money(invoice.totalAmount)})
            </button>
          )}
        </div>
      ) : undefined}
    >
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
        Invited {fmtDate(invoice.invitedAt)}
        {invoice.submittedAt && <> · submitted {fmtDate(invoice.submittedAt)}</>}
        {invoice.approvedAt && <> · approved {fmtDate(invoice.approvedAt)}</>}
        {invoice.cancelledAt && <> · cancelled {fmtDate(invoice.cancelledAt)}</>}
      </div>

      {invoice.status === AssayerInvoiceStatus.INVITED && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Waiting on the assayer — this is their first sight of these amounts, and they have not confirmed them yet. Approval opens once they submit.
        </div>
      )}
      {invoice.status === AssayerInvoiceStatus.CANCELLED && invoice.cancelReason && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Cancelled: <em>{invoice.cancelReason}</em></div>
      )}
      {heldLines.length > 0 && invoice.status !== AssayerInvoiceStatus.CANCELLED && (
        <div style={{ fontSize: 12, color: 'var(--warning)' }}>
          {heldLines.map((l) => l.payableNumber).join(', ')} on hold — the server will refuse approval until the hold is released or this invoice is cancelled.
        </div>
      )}

      {cancelOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontSize: 12.5 }}>
            Cancelling releases every line back to the unbilled pool, so the work can be invited again once fixed. The assayer&rsquo;s confirmation, if given, is discarded. Say why:
          </div>
          <Select
            value={cancelPreset}
            onChange={setCancelPreset}
            options={[
              { value: '', label: 'Reason *' },
              ...CANCEL_ASSAYER_INVOICE_REASONS.map((r) => ({ value: r, label: r })),
              { value: '__other__', label: 'Other…' },
            ]}
            style={{ width: '100%' }}
          />
          {isCancelOther && (
            <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} placeholder="Reason *" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setCancelOpen(false); setCancelPreset(''); setCancelReason(''); }} className="btn btn-secondary">Keep</button>
            <button onClick={doCancel} disabled={cancel.isPending || !effectiveCancelReason} className="btn btn-primary">Cancel invoice</button>
          </div>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Amounts</h4>
        <AmountRow label="Fees" value={moneyExact(invoice.subtotalBase)} />
        <AmountRow label="Travel" value={moneyExact(invoice.subtotalTravel)} />
        <AmountRow label="TDS withheld" value={`−${moneyExact(invoice.tdsAmount)}`} />
        <AmountRow label="Total" value={moneyExact(invoice.totalAmount)} strong />
      </div>

      <div>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>Lines ({invoice.lines.length})</h4>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Line</th><th style={th}>Branch</th><th style={th}>Completed</th><th style={th}>Payout</th>
              <th style={{ ...th, textAlign: 'right' }}>Base</th><th style={{ ...th, textAlign: 'right' }}>Travel</th>
              <th style={{ ...th, textAlign: 'right' }}>TDS</th><th style={{ ...th, textAlign: 'right' }}>Net</th>
            </tr></thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.payableId}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {l.kind === 'EXPENSE' && <Receipt size={12} style={{ color: 'var(--text-muted)' }} />}{l.assignmentNumber ?? l.payableNumber}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {l.kind === 'EXPENSE' ? `Expense reimbursement${l.expenseCategory ? ` · ${l.expenseCategory}` : ''}` : 'Audit fee'}
                    </div>
                  </td>
                  <td style={td}>{l.branchName ?? '—'}</td>
                  <td style={td}>{fmtDate(l.serviceDate)}</td>
                  {/* `payableStatus` arrives as the raw enum string; the pill de-jargons it and
                      carries the hold marker approve will refuse on. */}
                  <td style={td}><PayoutStatusPill status={l.payableStatus as AssayerPayableStatus} onHold={l.onHold} /></td>
                  <td style={tdNum}>{moneyExact(l.baseAmount)}</td>
                  <td style={tdNum}>{Number(l.travelAmount) ? moneyExact(l.travelAmount) : '—'}</td>
                  <td style={tdNum}>{Number(l.tdsAmount) ? `−${moneyExact(l.tdsAmount)}` : '—'}</td>
                  <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{moneyExact(l.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {invoice.notes && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{invoice.notes}</div>}

      {confirmDialog}
    </DetailDrawer>
  );
};
