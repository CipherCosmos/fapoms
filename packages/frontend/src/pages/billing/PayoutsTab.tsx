import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Banknote, PauseCircle, PlayCircle, Receipt, FileDown, Percent, RotateCcw, Send } from 'lucide-react';
import { AssayerPayableStatus, PaymentMethod, payableStatusLabel, paymentMethodLabel } from '@fapoms/shared';
import type { AssayerInvoiceInviteOutcome } from '@fapoms/shared';
import { Modal, Pagination, Select, StyledInput, useConfirm, useToast } from '../../components/ui';
import {
  usePayouts, useApprovePayouts, usePayPayouts, useHoldPayout, useReopenAssignment,
  useInviteAssayerInvoice, useInviteAllAssayerInvoices, useAssayerInvoiceLookup,
} from '../../hooks/useBilling';
import { BILLING_PAGE_SIZE, billingApi, isInvoicingNotEnabled } from '../../services/billing';
import type { PayoutRow, AssayerInvoiceInviteAllResult } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { moneyTotal as money } from '../../utils/money';
import { visibleSelection } from '../../utils/selection';
import { downloadCsv, datedFilename } from '../../utils/csv';
import { Card, Empty, PayoutStatusPill, AssayerInvoiceStatusPill, fmtDate, th, td, tdNum, inputStyle } from './shared';
import { ExpenseReview } from '../ExpenseReview';
import { TdsReportModal } from './TdsReportModal';

/**
 * Payouts — what we owe assayers, and the one gate before paying it.
 *
 * One table, grouped by assayer. Tick rows, then Approve (Due → Approved) or Pay (Approved →
 * Paid, with a bank reference). Hold/release is per row. PAID is only ever reached by recording
 * a payment; there is no status dropdown. Reimbursements of expense claims appear in the same
 * table as their own rows, because an expense payout is the same act as a fee payout.
 *
 * This tab is also where the assayer-invoicing round STARTS: "Invite all to invoice" (the
 * periodic bulk gesture) and the per-assayer invite put unbilled payouts in front of the
 * assayer — their first sight of money — for confirmation; the invoices themselves are
 * reviewed and approved on the Assayer Invoices tab. A payout riding an active invoice wears
 * its invoice as a chip, and per-payout Approve is refused for it (the server says so, and the
 * refusal is shown verbatim) because approving the invoice is the one gesture that approves
 * its lines.
 */
export type PayoutFilter = 'ALL' | 'PENDING' | 'APPROVED' | 'PAID' | 'HELD';

/**
 * The client's mirror of `ASSAYER_INVOICE_ELIGIBLE_SQL` — which rows the invite would pick up:
 * due or approved-unpaid, not held, not already riding an invoice, and not pre-invoicing-era
 * history (revealed and often paid under the old rules; inviting it would bill history twice).
 * Keyed on exactly what the payout rows carry (`status`/`onHold`/`assayerInvoiceId`/
 * `preInvoicingEra`); the server re-derives this under lock, so this only decides whether the
 * button is worth pressing, never what the invoice contains.
 */
export const isInviteEligible = (r: PayoutRow): boolean =>
  (r.status === AssayerPayableStatus.PENDING || r.status === AssayerPayableStatus.APPROVED) &&
  !r.onHold && !r.assayerInvoiceId && !r.preInvoicingEra;

export const PayoutsTab: React.FC<{ filter: PayoutFilter; onFilter: (f: PayoutFilter) => void; canAct: boolean; canReviewClaims: boolean }> = ({ filter, onFilter, canAct, canReviewClaims }) => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  const [holding, setHolding] = useState<PayoutRow | null>(null);
  const [reopeningRow, setReopeningRow] = useState<PayoutRow | null>(null);
  const [bankBusy, setBankBusy] = useState(false);
  const [tdsOpen, setTdsOpen] = useState(false);

  const params = {
    status: filter === 'PENDING' || filter === 'APPROVED' || filter === 'PAID' ? (filter as AssayerPayableStatus) : undefined,
    onHold: filter === 'HELD' ? true : undefined,
    page, limit: BILLING_PAGE_SIZE,
  };
  const payouts = usePayouts(params);
  const approve = useApprovePayouts();
  const pay = usePayPayouts();
  const hold = useHoldPayout();
  const reopen = useReopenAssignment();
  const inviteOne = useInviteAssayerInvoice();
  const inviteAll = useInviteAllAssayerInvoices();
  /**
   * Rollout gate (`billing.assayerInvoicingEnabled`): while the flag is off, the invite POSTs
   * answer 404 "not enabled" — a deployment state, not a mistake by whoever clicked. Remembered
   * here so the first click turns the buttons into a quiet banner instead of an error toast;
   * cleared implicitly on remount once the flag is flipped.
   */
  const [invoicingDark, setInvoicingDark] = useState(false);
  const [inviteOutcome, setInviteOutcome] = useState<AssayerInvoiceInviteAllResult | null>(null);

  // Memoised so the `?? []` fallback keeps a stable identity between renders.
  const rows = useMemo(() => payouts.data?.items ?? [], [payouts.data?.items]);
  const total = payouts.data?.total ?? 0;

  // The invoice each visible row rides, resolved by id — rows carry `assayerInvoiceId` only
  // (see the note on PayoutRow), so the page looks up the few distinct invoices it can see.
  const invoiceById = useAssayerInvoiceLookup(rows.map((r) => r.assayerInvoiceId));

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

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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

  /**
   * Export the selected approved-unpaid payouts as a NEFT bank file the finance team uploads to
   * the bank portal, instead of hand-keying each beneficiary. The visible-selection rule applies:
   * only ticked rows on screen right now are included, and any ticked-but-hidden rows are called
   * out rather than silently added.
   *
   * NOTE: the column order below is a common one that most Indian bank bulk-upload (NEFT) portals
   * accept, but banks differ — if the portal rejects the file, tailor these headers and their
   * order to the specific bank's template.
   */
  const downloadBankFile = async () => {
    const vis = visibleSelection(selected, rows, (r) => r.id);
    const eligible = vis.rows.filter(
      (r) => r.status === AssayerPayableStatus.APPROVED && !r.onHold && (Number(r.totalAmount) - Number(r.paidAmount)) > 0,
    );
    if (!eligible.length) { toast('error', 'Tick approved, unpaid payouts to include in a bank file.'); return; }
    setBankBusy(true);
    try {
      const res = await billingApi.getPayoutBankFile(eligible.map((r) => r.id));
      if (!res.rows.length) { toast('error', 'None of the selected payouts are payable right now.'); return; }
      const headers = ['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Txn Type', 'Reference / Narration', 'Assayer Code', 'PAN'];
      const csvRows = res.rows.map((r) => [
        r.beneficiaryName ?? r.assayerName ?? '', r.accountNumber ?? '', r.ifsc ?? '',
        r.netAmount.toFixed(2), 'NEFT', r.reference, r.assayerCode ?? '', r.pan ?? '',
      ]);
      downloadCsv(datedFilename('assayer_neft_bank_file'), headers, csvRows);
      const missing = res.rows.filter((r) => !r.hasBankDetails).length;
      const parts = [`${res.rows.length} payout${res.rows.length === 1 ? '' : 's'} in the file`];
      if (missing) parts.push(`${missing} missing bank account/IFSC — add them on the assayer record before uploading`);
      if (res.skipped.length) parts.push(`${res.skipped.length} not eligible were skipped`);
      if (vis.hiddenCount) parts.push(`${vis.hiddenCount} ticked but off screen, so not included`);
      toast({ type: missing || res.skipped.length ? 'warning' : 'success', title: 'Bank file downloaded', message: parts.join(' · ') });
    } catch (e) {
      toast({ type: 'error', title: 'Could not build the bank file', message: userMessage(e) });
    } finally {
      setBankBusy(false);
    }
  };

  /**
   * The invitation is the money REVEAL: the invited assayer sees, for the first time anywhere,
   * the fees on their completed work, and is asked to confirm them as one invoice. It moves no
   * money — approval later does — so the confirm here restates what the assayer will experience
   * rather than demanding a typed total.
   */
  const runInviteOne = async (g: { assayerId: string; assayerName: string }) => {
    const ok = await confirm({
      title: `Invite ${g.assayerName} to invoice?`,
      message: (
        <>
          This creates one invitation covering <strong>all</strong> of {g.assayerName}&rsquo;s eligible unbilled
          payouts — due or approved, not held, not already invited — and shows them those amounts for the
          first time. They confirm on their phone; the invoice then comes to Billing → Assayer Invoices for approval.
        </>
      ),
      confirmLabel: 'Invite to invoice',
      reversible: true,
      reversibleNote: 'An invitation can be cancelled from the Assayer Invoices tab, which releases its lines again.',
    });
    if (!ok) return;
    try {
      const inv = await inviteOne.mutateAsync(g.assayerId);
      toast('success', `${inv.invoiceNumber} created — ${inv.lineCount} line${inv.lineCount === 1 ? '' : 's'} for ${g.assayerName} to confirm`);
    } catch (e) {
      if (isInvoicingNotEnabled(e)) { setInvoicingDark(true); return; } // rollout gate — banner, not an error
      // 409 "already has an active invoice (AINV-…)" and friends arrive as human sentences — verbatim.
      toast({ type: 'error', title: 'Could not invite', message: userMessage(e) });
    }
  };

  /**
   * The cadence gesture (roughly every 15 days / monthly): one invitation per assayer with
   * eligible work, server-wide — not limited to this page. The server answers per-assayer
   * outcomes and never fails the round as a whole; the summary modal shows the counts and
   * lists any 'failed' rows distinctly, because an infrastructure error is not a business
   * outcome and must not hide inside "skipped".
   */
  const runInviteAll = async () => {
    const ok = await confirm({
      title: 'Invite every assayer with unbilled work?',
      message: (
        <>
          Every assayer with eligible unbilled payouts — across the whole book, not just this page — gets
          <strong> one</strong> invoice invitation covering all of theirs, and sees those amounts for the first
          time. Assayers already holding an active invitation are skipped, so running this again is safe.
        </>
      ),
      confirmLabel: 'Invite all',
      reversible: true,
      reversibleNote: 'Each invitation can be cancelled individually from the Assayer Invoices tab.',
    });
    if (!ok) return;
    try {
      setInviteOutcome(await inviteAll.mutateAsync());
    } catch (e) {
      if (isInvoicingNotEnabled(e)) { setInvoicingDark(true); return; } // rollout gate — banner, not an error
      toast({ type: 'error', title: 'The invitation round could not run', message: userMessage(e) });
    }
  };

  const changeFilter = (f: PayoutFilter) => { onFilter(f); setPage(1); setSelected(new Set()); };

  // The outcome rows are keyed by assayer id; name what this page can (its own rows), and let
  // the id stand for anyone outside the current page rather than pretending to know them.
  const assayerNameOf = (assayerId: string): string =>
    rows.find((r) => r.assayerId === assayerId)?.assayerName ?? `assayer ${assayerId.slice(0, 8)}…`;

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
        {canAct && (
          <button onClick={runInviteAll} disabled={inviteAll.isPending || invoicingDark} className="btn btn-primary"
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}
            title={invoicingDark
              ? 'Assayer invoicing is not enabled on this deployment yet'
              : 'One invoice invitation per assayer with unbilled work — the periodic (~15-day/monthly) billing round'}>
            <Send size={13} /> {inviteAll.isPending ? 'Inviting…' : 'Invite all to invoice'}
          </button>
        )}
        <button onClick={() => setTdsOpen(true)} className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}
          title="PAN-wise report of TDS withheld from field workers, downloadable as CSV">
          <Percent size={13} /> TDS report
        </button>
        <Link to="/billing/statement" style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>Assayer statements →</Link>
      </div>

      {/* Rollout gate: the backend answered "not enabled" to an invite. Deployment state, not an
          error — said once, quietly, and the invite buttons above/below stay disabled. */}
      {invoicingDark && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 12px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          Assayer invoicing is not enabled on this deployment yet, so invitations cannot be sent.
          Everything else on this tab works as usual; the invite buttons wake up when the
          <code style={{ margin: '0 4px' }}>billing.assayerInvoicingEnabled</code> setting is turned on.
        </div>
      )}

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
          {/* Exports the approved-unpaid selection as a NEFT bank file, so beneficiaries are not
              hand-keyed at the bank portal. It reads bank details but moves no money. */}
          <button className="btn btn-secondary" disabled={!payable.length || bankBusy} onClick={downloadBankFile}
            title="Download the selected approved, unpaid payouts as a NEFT bank-upload file (beneficiary, account, IFSC, amount)"
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <FileDown size={14} /> {bankBusy ? 'Preparing…' : 'Download bank file'}
          </button>
          <button className="btn btn-secondary" onClick={() => setSelected(new Set())}>Clear</button>
          {selectedRows.length > approvable.length + payable.length && (
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Held and already-paid rows are skipped.</span>
          )}
        </div>
      )}

      {payouts.isLoading ? <Empty>Loading payouts…</Empty> : payouts.isError ? (
        <Empty>Could not load payouts — this is not saying there are none. Check your connection and try again.</Empty>
      ) : groups.length === 0 ? (
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
                {groups.map((g) => {
                  const eligible = g.rows.filter(isInviteEligible);
                  return (
                  <React.Fragment key={g.assayerId}>
                    <tr style={{ background: 'var(--bg-tertiary)' }}>
                      {canAct && <td style={td}><input type="checkbox" checked={g.rows.every((r) => selected.has(r.id))} onChange={() => toggleGroup(g.rows.map((r) => r.id))} /></td>}
                      <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }} colSpan={2}>
                        <Link to={`/billing/statement?assayer=${g.assayerId}`} style={{ color: 'inherit', textDecoration: 'none' }}>{g.assayerName}</Link>
                        {g.assayerCode && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>{g.assayerCode}</span>}
                      </td>
                      <td style={td} colSpan={4}>
                        {canAct && (
                          /* Secondary to the header's bulk round: invites THIS assayer now.
                             Enabled off the rows on screen; the server re-checks under lock, so
                             at worst a stale page gets a clear refusal, never a wrong invoice. */
                          <button
                            onClick={() => runInviteOne(g)}
                            disabled={!eligible.length || inviteOne.isPending || invoicingDark}
                            title={invoicingDark
                              ? 'Assayer invoicing is not enabled on this deployment yet'
                              : eligible.length
                                ? `Invite ${g.assayerName} to confirm ${eligible.length} unbilled payout${eligible.length === 1 ? '' : 's'} as one invoice`
                                : 'No eligible payouts on screen — eligible rows are due or approved, not held, not already on an invoice, and not pre-invoicing history'}
                            style={{ background: 'transparent', border: 'none', cursor: eligible.length && !invoicingDark ? 'pointer' : 'default', color: eligible.length && !invoicingDark ? 'var(--accent)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, opacity: eligible.length && !invoicingDark ? 1 : 0.6 }}>
                            <Send size={12} /> Invite to invoice
                          </button>
                        )}
                      </td>
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
                          <td style={td}>
                            <PayoutStatusPill status={r.status} onHold={r.onHold} holdReason={r.holdReason} />
                            {r.assayerInvoiceId && (() => {
                              /* Same rendering as the client-invoice line on the money card:
                                 number as muted text, status as the pill. While the lookup is
                                 still resolving (or refused), say only that it rides one. */
                              const inv = invoiceById.get(r.assayerInvoiceId!);
                              return (
                                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, display: 'flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}
                                  title="This payout rides an assayer invoice. While it is invited or submitted, per-payout Approve is refused — approve or cancel the invoice on the Assayer Invoices tab.">
                                  {inv ? <>{inv.invoiceNumber} <AssayerInvoiceStatusPill status={inv.status} /></> : 'On assayer invoice'}
                                </div>
                              );
                            })()}
                          </td>
                          <td style={tdNum}>{money(r.baseAmount)}</td>
                          <td style={tdNum}>{Number(r.travelAmount) ? money(r.travelAmount) : '—'}</td>
                          <td style={tdNum}>{Number(r.tdsAmount) ? `−${money(r.tdsAmount)}` : '—'}</td>
                          <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{money(toPay)}</td>
                          <td style={td}>{fmtDate(r.createdAt)}</td>
                          {canAct && (
                            <td style={{ ...td, whiteSpace: 'nowrap' }}>
                              {r.status !== AssayerPayableStatus.PAID && r.status !== AssayerPayableStatus.VOIDED && (
                                <button onClick={() => setHolding(r)} title={r.onHold ? 'Release hold' : 'Put on hold'} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: r.onHold ? 'var(--success)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                                  {r.onHold ? <><PlayCircle size={13} /> Release</> : <><PauseCircle size={13} /> Hold</>}
                                </button>
                              )}
                              {/*
                                Expense reimbursements have no assignment to reopen — this is
                                the fee payable a completion booked, and the assignment it came
                                from is what actually gets reopened; the server refuses once a
                                payable is DISBURSED, which PAID/VOIDED already cover here.
                              */}
                              {!isReimb && r.status !== AssayerPayableStatus.PAID && r.status !== AssayerPayableStatus.VOIDED && (
                                <button onClick={() => setReopeningRow(r)} title="Reopen the assignment and void this payable" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, marginLeft: 8 }}>
                                  <RotateCcw size={13} /> Reopen
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                  );
                })}
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

      {reopeningRow && (
        <ReopenModal
          row={reopeningRow}
          busy={reopen.isPending}
          onClose={() => setReopeningRow(null)}
          onSubmit={async (reason) => {
            try {
              await reopen.mutateAsync({ assignmentId: reopeningRow.assignmentId, reason });
              toast('success', 'Assignment reopened and payable voided');
              setReopeningRow(null);
            } catch (e) { toast({ type: 'error', title: 'Could not reopen', message: userMessage(e) }); }
          }}
        />
      )}

      {tdsOpen && <TdsReportModal onClose={() => setTdsOpen(false)} />}

      {inviteOutcome && (
        <Modal open onClose={() => setInviteOutcome(null)} title={<><Send size={18} /> Invitation round finished</>} width="560px"
          footer={<button type="button" onClick={() => setInviteOutcome(null)} className="btn btn-primary">Close</button>}>
          <InviteOutcomeSummary result={inviteOutcome} nameOf={assayerNameOf} />
        </Modal>
      )}

      {confirmDialog}
    </div>
  );
};

/**
 * What the bulk invitation round did, per assayer, grouped by outcome.
 *
 * The two refusals — an active invoice already standing, nothing eligible left by that
 * assayer's turn — are expected states of the round and read as counts. 'failed' is neither: it
 * is an infrastructure error on ONE assayer that the round deliberately did not let abort the
 * other forty, so it is listed name by name with the server's error text, in the danger tone,
 * and told apart from "skipped" — those assayers were NOT invited and nothing about their book
 * decided that.
 */
export const InviteOutcomeSummary: React.FC<{
  result: AssayerInvoiceInviteAllResult;
  /** Assayer label for an id — the page names who it can see; ids stand in for the rest. */
  nameOf: (assayerId: string) => string;
}> = ({ result, nameOf }) => {
  const by = (o: AssayerInvoiceInviteOutcome['outcome']) => result.outcomes.filter((x) => x.outcome === o);
  const invited = by('invited');
  const skippedActive = by('skipped-active-invoice');
  const nothingEligible = by('nothing-eligible');
  const failed = by('failed');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5 }}>
      {result.outcomes.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No assayer has unbilled work right now — there was nobody to invite.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)' }}>
          <div><strong style={{ color: 'var(--text-primary)' }}>{invited.length}</strong> invited — each now sees their amounts and can confirm.</div>
          {skippedActive.length > 0 && (
            <div><strong>{skippedActive.length}</strong> skipped — they already hold an active invoice; approve or cancel it first.</div>
          )}
          {nothingEligible.length > 0 && (
            <div><strong>{nothingEligible.length}</strong> had nothing eligible left by their turn (a payout was held, voided or invited in the meantime).</div>
          )}
        </div>
      )}
      {failed.length > 0 && (
        <div style={{ border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ color: 'var(--danger)', fontWeight: 700 }}>
            {failed.length} failed — a system error, not a decision about their work. These assayers were <u>not</u> invited; run the round again, and tell an administrator if it repeats.
          </div>
          {failed.map((f) => (
            <div key={f.assayerId} style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{nameOf(f.assayerId)}</strong>
              {f.error ? <> — {f.error}</> : null}
            </div>
          ))}
        </div>
      )}
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
 *
 * Exported because `AssignmentMoneyCard`'s client-line hold is the other side of this same
 * action — the client line and the payout are held for the same reasons — so it imports this
 * list rather than keeping a second copy that could drift from it.
 */
export const HOLD_REASONS = [
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

/**
 * The undo of a wrong completion — puts the assignment back to ACCEPTED and voids the payable
 * it booked. Free text, not a preset list like `HoldModal`: a hold is routine and its reasons
 * repeat, but a completion getting reopened is rare enough that each one is its own story, and
 * that story is what the assignment's history shows afterward.
 */
const ReopenModal: React.FC<{ row: PayoutRow; busy: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void> }> = ({ row, busy, onClose, onSubmit }) => {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length > 0;
  return (
    <Modal open onClose={onClose} title="Reopen assignment" width="460px" asForm
      onSubmit={(e) => { e.preventDefault(); if (!ready) return; void onSubmit(reason.trim()); }}
      footer={<>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={busy || !ready} className="btn btn-primary">Reopen</button>
      </>}>
      <div style={{ fontSize: 13 }}>
        <strong>{row.assignmentNumber ?? row.payableNumber}</strong> · {row.assayerName} · {money(Number(r(row.totalAmount)) - Number(r(row.paidAmount)))}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        This puts the assignment back to Accepted and voids this payable — it will not be paid
        until the assignment is completed again. Say why; it goes on the assignment's record.
      </div>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being reopened? *" rows={3} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
    </Modal>
  );
};

const r = (v: unknown) => (v == null ? 0 : Number(v));
