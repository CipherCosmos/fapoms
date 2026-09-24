import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Banknote, FileDown, Hourglass, Landmark, PauseCircle, Percent, PlayCircle, Receipt, RotateCcw, Send } from 'lucide-react';
import { AssayerPayableStatus, PaymentMethod, paymentMethodLabel, businessTodayDateKey, isBackgroundJobInFlight, AWAITING_HOD_MESSAGE } from '@fapoms/shared';
import { Modal, Pagination, Select, StyledInput, useToast } from '../../components/ui';
import {
  usePayouts, useApprovePayouts, usePayPayouts, useHoldPayout, useReopenAssignment,
  useInviteAssayerInvoice, useAssayerInvoiceLookup, useBillingOverview, usePayoutDestinationChecks,
} from '../../hooks/useBilling';
import { DestinationWarnings } from './DestinationWarnings';
import { useBackgroundJob } from '../../hooks/useBackgroundJob';
import { BILLING_PAGE_SIZE, billingApi, isInvoicingNotEnabled } from '../../services/billing';
import type { PayoutRow, PayoutActionResult, PayPayoutsResult, AssayerInvoiceInviteAllResult } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { QueuedJobTimeout } from '../../services/queued-job';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { moneyTotal as money } from '../../utils/money';
import { visibleSelection } from '../../utils/selection';
import { downloadCsv, datedFilename } from '../../utils/csv';
import { Card, Empty, PayoutStatusPill, AssayerInvoiceStatusPill, fmtDate, th, td, tdNum, inputStyle, tableScrollStyle } from './shared';
import { TdsReportModal } from './TdsReportModal';
import { PAYOUT_STAGES, type PayoutStage } from './vocabulary';

/**
 * Pay assayers — what we owe, arranged by what is holding each payout up.
 *
 * This tab used to filter by the payout's raw status, and its "Due" filter was the single most
 * misleading control on the money screens. "Due" holds two piles that need opposite handling:
 *
 *   - on a bill the assayer has not confirmed — the desk CANNOT approve these; the server throws
 *     "awaiting assayer invoice AINV-… — approve the invoice instead"
 *   - on no bill at all — approvable, but the assayer has not seen a rupee of it
 *
 * On the live book that was 20 rows and 19 rows, shown as one list of 39 with one Approve button
 * over it. Ticking the assayer's group header and pressing Approve authorised half a selection
 * and collected a screenful of refusals for the rest.
 *
 * So the filters are stages now — the question is "what is this waiting for", and each stage is a
 * real server-side query (see `PAYOUT_STAGES`), so the chip's count and the table under it cannot
 * disagree. Each stage offers only the actions that stage can accept, which is why there is no
 * checkbox at all on the two stages where nothing the desk does would be accepted.
 *
 * The normal road to APPROVED is through the assayer's bill, on the Assayer bills tab: they
 * confirm the amounts, the desk approves the bill, and every payout on it is approved in one
 * gesture with the assayer's agreement on the record. Some assayers cannot walk that road — no
 * smartphone, an app that will not install, someone who has already left — so "Not billed yet"
 * keeps a direct approval, presented as the exception it is and requiring a reason that is
 * written to the payout's history.
 */
export type { PayoutStage };

/**
 * The client's mirror of `ASSAYER_INVOICE_ELIGIBLE_SQL` — which rows an invite would pick up:
 * due or approved-unpaid, not held, not already riding a bill, and not pre-invoicing-era history
 * (revealed and often paid under the old rules; inviting it would bill history twice). Keyed on
 * exactly what the payout rows carry; the server re-derives this under lock, so this only decides
 * whether the button is worth pressing, never what the bill contains.
 */
/**
 * Ready to pay: approved by the office, given the HOD's final approval (2026-09-24), not held,
 * still owed. The server's own rule (`recordDisbursement`, the bank file); the screen only uses it
 * to decide what the pay buttons offer.
 */
export const isReadyToPay = (r: PayoutRow): boolean =>
  r.status === AssayerPayableStatus.APPROVED && !!r.hodApprovedAt && !r.onHold
  && (Number(r.totalAmount) - Number(r.paidAmount)) > 0;

export const isInviteEligible = (r: PayoutRow): boolean =>
  (r.status === AssayerPayableStatus.PENDING || r.status === AssayerPayableStatus.APPROVED) &&
  !r.onHold && !r.assayerInvoiceId && !r.preInvoicingEra;

export const PayoutsTab: React.FC<{ stage: PayoutStage; onStage: (s: PayoutStage) => void; canAct: boolean }> = ({ stage, onStage, canAct }) => {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [holding, setHolding] = useState<PayoutRow | null>(null);
  const [reopeningRow, setReopeningRow] = useState<PayoutRow | null>(null);
  const [bankBusy, setBankBusy] = useState(false);
  const [tdsOpen, setTdsOpen] = useState(false);

  const current = PAYOUT_STAGES.find((s) => s.key === stage) ?? PAYOUT_STAGES[0];
  const payouts = usePayouts({ ...current.query, page, limit: BILLING_PAGE_SIZE });
  /** Chip counts. Shared cache entry with the To-do queue and the tab badges — one read. */
  const overview = useBillingOverview();
  const approve = useApprovePayouts();
  const pay = usePayPayouts();
  const hold = useHoldPayout();
  const reopen = useReopenAssignment();
  const inviteOne = useInviteAssayerInvoice();

  /**
   * Rollout gate (`billing.assayerInvoicingEnabled`): while the flag is off, the invite POSTs
   * answer 404 "not enabled" — a deployment state, not a mistake by whoever clicked. Remembered
   * here so the first click turns the button into a quiet banner instead of an error toast.
   */
  const [invoicingDark, setInvoicingDark] = useState(false);
  /**
   * Approve and pay are ACCEPTED by the server and run on its queue: run in the request, a
   * realistic batch outlived this client's 30 s, so the screen said "failed" while the server kept
   * writing and a second press started it again. While one runs this holds the server's own stage
   * line ("Approving payouts (7/20)…"); non-null also means "a run is going".
   */
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  /**
   * An approve or pay run this page did NOT start — pressed before a refresh, or in another tab.
   * The runs are tracked on the server (the Jobs tray), so the tab can still say one is going and
   * hold the buttons: "did my payment go through?" answered with a second press is how a batch
   * gets paid under two references. Runs started from this page load are followed above instead.
   */
  const approveRuns = useBackgroundJob('BILLING_APPROVE_PAYOUTS');
  const payRuns = useBackgroundJob('BILLING_PAY_PAYOUTS');
  const ownRuns = useRef(new Set<string>());
  const remember = (started: { backgroundJobId?: string | null }) => { if (started.backgroundJobId) ownRuns.current.add(started.backgroundJobId); };
  const serverRun = [...approveRuns.active, ...payRuns.active]
    .find((j) => isBackgroundJobInFlight(j.status) && !ownRuns.current.has(j.id)) ?? null;
  const serverRunLine = serverRun
    ? `${serverRun.title} is still running on the server (${serverRun.progress.stage})… The list updates when it finishes.`
    : null;
  const bulkBusy = bulkProgress !== null || serverRun !== null;
  const followProgress = { onProgress: (p: { stage: string }) => setBulkProgress(`${p.stage}…`) };
  /** A run still going after the give-up time is not a failure — it carries on, and says so. */
  const toastRunError = (title: string, e: unknown) => (e instanceof QueuedJobTimeout
    ? toast({ type: 'info', title: 'Still running on the server', message: e.message })
    : toast({ type: 'error', title, message: userMessage(e) }));

  const serverRunId = serverRun?.id ?? null;
  const lastServerRun = useRef<string | null>(null);
  useEffect(() => {
    if (lastServerRun.current && !serverRunId) void payouts.refetch();
    lastServerRun.current = serverRunId;
  }, [serverRunId]); // eslint-disable-line react-hooks/exhaustive-deps -- refetch on the run finishing only

  const rows = useMemo(() => payouts.data?.items ?? [], [payouts.data?.items]);
  const total = payouts.data?.total ?? 0;

  // The bill each visible row rides, resolved by id — rows carry `assayerInvoiceId` only, so the
  // page looks up the few distinct bills it can see.
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

  /**
   * Which stages let the desk do anything at all.
   *
   * "With the assayer" and "Paid" get no checkbox column, because every bulk action on them
   * would be refused by the server — and a control that can only fail is worse than no control:
   * it invites the attempt, then blames the person who made it.
   */
  const selectable = canAct && (stage === 'NOT_BILLED' || stage === 'TO_PAY' || stage === 'AWAITING_HOD');
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const approvable = stage === 'NOT_BILLED' ? selectedRows.filter((r) => r.status === AssayerPayableStatus.PENDING && !r.onHold && !r.assayerInvoiceId) : [];
  // Payable means approved by the office AND given the HOD's final approval (2026-09-24) — the
  // server refuses anything else ("Waiting for HOD approval"), so the button never offers it.
  const payable = stage === 'TO_PAY' ? selectedRows.filter((r) => isReadyToPay(r)) : [];

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleGroup = (ids: string[]) => setSelected((s) => {
    const n = new Set(s);
    const all = ids.every((id) => n.has(id));
    ids.forEach((id) => (all ? n.delete(id) : n.add(id)));
    return n;
  });

  const changeStage = (s: PayoutStage) => { onStage(s); setPage(1); setSelected(new Set()); };

  /**
   * Approving without the assayer's confirmation — the exception, and it behaves like one.
   *
   * Two things are asked for and neither can be given by reflex: the rupee total, typed, so the
   * number being authorised has to be read; and a reason, which is written to the payout's
   * history row and its audit remark. There is no un-approve in this UI — the only way back is a
   * hold, row by row, before somebody pays them — so this is the last cheap moment to stop.
   */
  const runApprove = async (reason: string) => {
    setApproveOpen(false);
    setBulkProgress(`Approving ${approvable.length} payout${approvable.length === 1 ? '' : 's'}…`);
    try {
      const started = await approve.mutateAsync({ payableIds: approvable.map((p) => p.id), reason });
      remember(started);
      const r = await billingApi.followBulkJob<PayoutActionResult>(started, followProgress);
      if (r.refused.length) toast({ type: 'warning', title: `${r.done.length} approved, ${r.refused.length} refused`, message: r.refused.map((x) => x.reason).join(' · ') });
      else toast('success', `${r.done.length} payout${r.done.length === 1 ? '' : 's'} approved — now waiting for the HOD's final approval`);
      // Approved, but on a bank account nothing verifies (audit F3) — said after the fact too, so it
      // is on screen when the approval lands and not only in the dialog that preceded it.
      if (r.warnings?.length) {
        toast({ type: 'warning', title: `${r.warnings.length} approved to an unverified bank account`, message: [...new Set(r.warnings.map((w) => w.warning))].join(' · ') });
      }
      setSelected(new Set());
      void payouts.refetch();
    } catch (e) { toastRunError('Approval failed', e); } finally { setBulkProgress(null); }
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
    const eligible = vis.rows.filter((r) => isReadyToPay(r));
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
      const changed = res.rows.filter((r) => r.destinationDiffersFromRecord);
      const parts = [`${res.rows.length} payout${res.rows.length === 1 ? '' : 's'} in the file`];
      if (missing) parts.push(`${missing} missing bank account/IFSC — add them on the assayer record before uploading`);
      // The file pays the account frozen at approval; say so where the record now says otherwise (F2).
      if (changed.length) parts.push(...changed.map((r) => r.warning ?? `${r.payableNumber}: bank details changed since approval`));
      if (res.skipped.length) parts.push(`${res.skipped.length} not eligible were skipped`);
      if (vis.hiddenCount) parts.push(`${vis.hiddenCount} ticked but off screen, so not included`);
      toast({ type: missing || changed.length || res.skipped.length ? 'warning' : 'success', title: 'Bank file downloaded', message: parts.join(' · ') });
    } catch (e) {
      toast({ type: 'error', title: 'Could not build the bank file', message: userMessage(e) });
    } finally {
      setBankBusy(false);
    }
  };

  /** Send one assayer their bill — the normal road, offered next to the people who need it. */
  const runInviteOne = async (g: { assayerId: string; assayerName: string }) => {
    try {
      const inv = await inviteOne.mutateAsync(g.assayerId);
      toast('success', `${inv.invoiceNumber} sent — ${inv.lineCount} line${inv.lineCount === 1 ? '' : 's'} for ${g.assayerName} to confirm`);
      void payouts.refetch();
    } catch (e) {
      if (isInvoicingNotEnabled(e)) { setInvoicingDark(true); return; } // rollout gate — banner, not an error
      // 409 "already has an active invoice (AINV-…)" and friends arrive as human sentences — verbatim.
      toast({ type: 'error', title: 'Could not send the bill', message: userMessage(e) });
    }
  };

  const stageCount = (key: PayoutStage): number | undefined => {
    const p = overview.data?.payouts;
    if (!p || loadFailed(overview)) return undefined;
    return key === 'WITH_ASSAYER' ? p.inClaimReviewCount
      : key === 'NOT_BILLED' ? p.unbilledCount
      : key === 'AWAITING_HOD' ? p.awaitingHodCount
      : key === 'TO_PAY' ? p.approvedCount - (p.awaitingHodCount ?? 0)
      : key === 'HELD' ? p.heldCount
      : undefined; // Paid is history, and a count of history is not a call to action.
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {PAYOUT_STAGES.map((s) => {
          const active = stage === s.key;
          const n = stageCount(s.key);
          return (
            <button key={s.key} onClick={() => changeStage(s.key)} title={s.waitingOn} style={{
              padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: active ? 700 : 600,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: active ? 'var(--status-pending-bg)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            }}>
              {s.label}
              {n !== undefined && n > 0 && (
                <span style={{ fontSize: 'var(--text-3xs, var(--text-2xs))', padding: '1px 6px', borderRadius: 10, background: active ? 'var(--accent-primary)' : 'var(--bg-tertiary)', color: active ? '#fff' : 'var(--text-muted)', fontWeight: 700 }}>{n}</span>
              )}
            </button>
          );
        })}
        <button onClick={() => setTdsOpen(true)} className="btn btn-secondary" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-xs)' }}
          title="Download the PAN-wise TDS report as CSV">
          <Percent size={13} /> TDS report
        </button>
      </div>

      {/* What this stage is waiting for, in one sentence. The chip names the state; this says
          what it means and whose move it is. */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        {stage === 'WITH_ASSAYER' ? <Hourglass size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-muted)' }} /> : <Landmark size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-muted)' }} />}
        <span>{current.waitingOn}</span>
      </div>

      {/* Rollout gate: the backend answered "not enabled" to an invite. Deployment state, not an
          error — said once, quietly, and the invite buttons stay disabled. */}
      {invoicingDark && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: '8px 12px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          Assayer bills are not enabled on this deployment yet, so bills cannot be sent. Everything
          else on this tab works as usual; the button wakes up when the
          <code style={{ margin: '0 4px' }}>billing.assayerInvoicingEnabled</code> setting is turned on.
        </div>
      )}

      {/* A queued approve / pay run, in the server's own words. It carries on if this page is
          closed; the lists update as it writes. */}
      {(bulkProgress ?? serverRunLine) && (
        <div role="status" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          {bulkProgress ?? serverRunLine}
        </div>
      )}

      {selectable && selected.size > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{selected.size} selected</span>
          {stage === 'NOT_BILLED' && (
            <button className="btn btn-secondary" disabled={!approvable.length || approve.isPending || bulkBusy} onClick={() => setApproveOpen(true)}
              title="Approve these without waiting for the assayer to confirm a bill. The exception, not the rule."
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', borderColor: 'var(--warning)', color: 'var(--warning)' }}>
              <AlertTriangle size={14} /> Approve without a bill {approvable.length ? `(${approvable.length} · ${money(approvable.reduce((s, p) => s + Number(p.totalAmount), 0))})` : ''}
            </button>
          )}
          {stage === 'AWAITING_HOD' && <>
            {/* Shown, and disabled with the reason, so nobody wonders where "pay" went. */}
            <button className="btn btn-primary" disabled title={`${AWAITING_HOD_MESSAGE} — these were approved by the office and cannot be paid until the HOD gives the final approval.`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Banknote size={14} /> Record payment
            </button>
            <button className="btn btn-secondary" disabled title={`${AWAITING_HOD_MESSAGE} — the bank file includes only payouts the HOD has approved.`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <FileDown size={14} /> Download bank file
            </button>
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{AWAITING_HOD_MESSAGE}</span>
          </>}
          {stage === 'TO_PAY' && <>
            <button className="btn btn-primary" disabled={!payable.length || pay.isPending || bulkBusy} onClick={() => setPayOpen(true)} title={payable.length ? `Record payment for ${payable.length} payout${payable.length === 1 ? '' : 's'}` : 'Tick an approved, unpaid payout first'} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Banknote size={14} /> Record payment {payable.length ? `(${payable.length} · ${money(payable.reduce((s, p) => s + Number(p.totalAmount) - Number(p.paidAmount), 0))})` : ''}
            </button>
            <button className="btn btn-secondary" disabled={!payable.length || bankBusy} onClick={downloadBankFile}
              title="Download the selected approved, unpaid payouts as a NEFT bank-upload file (beneficiary, account, IFSC, amount)"
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <FileDown size={14} /> {bankBusy ? 'Preparing…' : 'Download bank file'}
            </button>
          </>}
          <button className="btn btn-secondary" onClick={() => setSelected(new Set())} title="Untick everything">Clear</button>
          {selectedRows.length > approvable.length + payable.length && (
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>Held and already-paid rows are skipped.</span>
          )}
        </div>
      )}

      {loadFailed(payouts) ? (
        <LoadFailure loads={[{ label: 'payouts', query: payouts }]} />
      ) : payouts.isLoading ? <Empty>Loading payouts…</Empty> : groups.length === 0 ? (
        // Short on purpose: the sentence explaining this stage is already in the band directly
        // above, and repeating it here printed it twice, one line apart.
        <Empty>Nothing at this stage.</Empty>
      ) : (
        <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Landmark size={14} /> {current.label} ({total})</span>}>
          <div style={tableScrollStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {selectable && <th style={{ ...th, width: 28 }} />}
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
                        {selectable && <td style={td}><input type="checkbox" checked={g.rows.every((r) => selected.has(r.id))} onChange={() => toggleGroup(g.rows.map((r) => r.id))} /></td>}
                        <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }} colSpan={2}>
                          <Link to={`/billing/statement?assayer=${g.assayerId}`} style={{ color: 'inherit', textDecoration: 'none' }}>{g.assayerName}</Link>
                          {g.assayerCode && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>{g.assayerCode}</span>}
                        </td>
                        <td style={td} colSpan={4}>
                          {/*
                            The normal road, offered exactly where the people who need it are
                            listed: on "Not billed yet", beside each assayer with work no bill
                            has reached. It is not on the other stages, where it would only be
                            refused — a bill already covers those rows, or they are settled.
                          */}
                          {canAct && stage === 'NOT_BILLED' && (
                            <button
                              onClick={() => runInviteOne(g)}
                              disabled={!eligible.length || inviteOne.isPending || invoicingDark}
                              title={invoicingDark
                                ? 'Assayer bills are not enabled on this deployment yet'
                                : `Send ${g.assayerName} a bill for ${eligible.length} unbilled payout${eligible.length === 1 ? '' : 's'} to confirm`}
                              className="btn btn-secondary"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-2xs)', padding: '4px 10px' }}>
                              <Send size={12} /> Send bill
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
                            {selectable && <td style={td}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} title={`Tick ${r.assignmentNumber ?? r.payableNumber ?? 'this payout'} for the bulk action`} /></td>}
                            <td style={td}>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                {isReimb && <Receipt size={12} style={{ color: 'var(--text-muted)' }} />}{r.assignmentNumber ?? '—'}
                              </div>
                              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{isReimb ? 'Expense reimbursement' : r.payableNumber}</div>
                            </td>
                            <td style={td}>{[r.clientName, r.branchName].filter(Boolean).join(' · ') || '—'}</td>
                            <td style={td}>
                              <PayoutStatusPill status={r.status} onHold={r.onHold} holdReason={r.holdReason}
                                hodApproved={r.status === AssayerPayableStatus.APPROVED ? !!r.hodApprovedAt : undefined} />
                              {r.status === AssayerPayableStatus.PENDING && r.hodRejectReason && (
                                <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--warning)', marginTop: 3 }} title="The HOD sent this back to the office">
                                  Sent back by the HOD: {r.hodRejectReason}
                                </div>
                              )}
                              {r.assayerInvoiceId && (() => {
                                const inv = invoiceById.get(r.assayerInvoiceId!);
                                return (
                                  <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginTop: 3, display: 'flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}
                                    title="This payout is on an assayer bill. While the bill is out or confirmed, approving the payout on its own is refused — approve the bill instead.">
                                    {inv ? (
                                      <Link to="/billing?tab=bills" style={{ color: 'inherit', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        {inv.invoiceNumber} <AssayerInvoiceStatusPill status={inv.status} />
                                      </Link>
                                    ) : 'On an assayer bill'}
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
                                  <button onClick={() => setHolding(r)} title={r.onHold ? 'Release hold' : 'Put on hold'} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: r.onHold ? 'var(--success)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-2xs)' }}>
                                    {r.onHold ? <><PlayCircle size={13} /> Release</> : <><PauseCircle size={13} /> Hold</>}
                                  </button>
                                )}
                                {!isReimb && r.status !== AssayerPayableStatus.PAID && r.status !== AssayerPayableStatus.VOIDED && (
                                  <button onClick={() => setReopeningRow(r)} title="Reopen the assignment and void this payable" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-2xs)', marginLeft: 8 }}>
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

      {approveOpen && (
        <ApproveWithoutBillModal
          payables={approvable}
          busy={approve.isPending || bulkBusy}
          onClose={() => setApproveOpen(false)}
          onApprove={runApprove}
        />
      )}

      {payOpen && (
        <PayModal
          payables={payable}
          busy={pay.isPending || bulkBusy}
          progress={bulkProgress}
          onClose={() => setPayOpen(false)}
          onPay={async (dto) => {
            setBulkProgress(`Paying ${payable.length} payout${payable.length === 1 ? '' : 's'}…`);
            try {
              const started = await pay.mutateAsync({ payableIds: payable.map((p) => p.id), ...dto });
              remember(started);
              const r = await billingApi.followBulkJob<PayPayoutsResult>(started, followProgress);
              if (r.refused.length) toast({ type: 'warning', title: `${r.done.length} paid, ${r.refused.length} refused`, message: r.refused.map((x) => x.reason).join(' · ') });
              else toast('success', `${r.done.length} payout${r.done.length === 1 ? '' : 's'} paid`);
              setPayOpen(false); setSelected(new Set());
              void payouts.refetch();
            } catch (e) { toastRunError('Payment failed', e); } finally { setBulkProgress(null); }
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
    </div>
  );
};

/**
 * The reasons an assayer cannot confirm their own bill, offered as one-click options.
 *
 * Seeded from what the owner described when this path was kept open: "in real world several
 * don't have things". A free-text box alone would have been filled with "ok" and "as
 * discussed", which records nothing; a fixed list alone would have blocked the case nobody
 * thought of. "Other…" keeps that case sayable.
 */
/** The server's own minimum (`DIRECT_APPROVAL_REASON_MIN` in billing-engine.service.ts, audit F6). */
export const DIRECT_APPROVAL_REASON_MIN = 10;

export const APPROVE_WITHOUT_BILL_REASONS = [
  'Assayer has no smartphone, or the app will not run on theirs',
  'Assayer has left; settling their final dues',
  'Assayer confirmed the amounts by phone or in person',
  'Bill was sent and they did not respond; agreed to proceed',
  'Urgent payment agreed with management',
];

/**
 * Approving without the assayer's confirmation.
 *
 * It asks for two things, and neither can be produced by reflex. The rupee total must be typed —
 * not the formatted "₹1,23,456", which is awkward on a keyboard and so gets routed around, but
 * the plain digits, which are still the number the person has to read in order to type. And a
 * reason, which goes onto every approved payout's history row.
 *
 * The wording states plainly what is being skipped. That matters more than the friction: the
 * person doing this is usually right to do it, and should be able to, but they should know they
 * are stepping off the normal road rather than discovering later that they were.
 */
const ApproveWithoutBillModal: React.FC<{
  payables: PayoutRow[]; busy: boolean; onClose: () => void; onApprove: (reason: string) => void;
}> = ({ payables, busy, onClose, onApprove }) => {
  const [preset, setPreset] = useState('');
  const [other, setOther] = useState('');
  const [typed, setTyped] = useState('');
  const total = payables.reduce((s, p) => s + Number(p.totalAmount), 0);
  const assayers = new Set(payables.map((p) => p.assayerId)).size;
  const phrase = String(Math.round(total));
  const reason = preset === '__other__' ? other.trim() : preset;
  // The server refuses a shorter reason (audit F6); say so here rather than after the run.
  const reasonShort = preset === '__other__' && reason.length > 0 && reason.length < DIRECT_APPROVAL_REASON_MIN;
  const ready = reason.length >= DIRECT_APPROVAL_REASON_MIN && typed.trim() === phrase;
  // Where the money would go: shared with another record (refused), unverified (allowed, said).
  const checks = usePayoutDestinationChecks(payables.map((p) => p.id));
  return (
    <Modal open onClose={onClose} width="540px" asForm
      title={<><AlertTriangle size={18} style={{ color: 'var(--warning)' }} /> Approve without the assayer&rsquo;s confirmation</>}
      onSubmit={(e) => { e.preventDefault(); if (ready) onApprove(reason); }}
      footer={<>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={busy || !ready} className="btn btn-primary">{busy ? 'Approving…' : `Approve ${money(total)}`}</button>
      </>}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Normally the assayer is sent a bill, confirms the amounts, and approving that bill approves
        these payouts with their agreement recorded. This skips that: <strong>{money(total)}</strong> to{' '}
        {assayers} assayer{assayers === 1 ? '' : 's'}, across {payables.length} payout{payables.length === 1 ? '' : 's'},
        approved for payment without {assayers === 1 ? 'them' : 'any of them'} having seen it.
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        Approving cannot be undone here. To stop one afterwards you must put it on hold before it is paid.
      </div>
      <DestinationWarnings checks={checks.data} />
      <Select
        value={preset}
        onChange={(v) => setPreset(v)}
        options={[
          { value: '', label: 'Why can this assayer not confirm? *' },
          ...APPROVE_WITHOUT_BILL_REASONS.map((r) => ({ value: r, label: r })),
          { value: '__other__', label: 'Other…' },
        ]}
        style={{ width: '100%' }}
      />
      {preset === '__other__' && (
        <textarea value={other} onChange={(e) => setOther(e.target.value)} rows={2} placeholder="Why can this assayer not confirm? *" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
      )}
      {reasonShort && (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)' }}>
          Say a little more — at least {DIRECT_APPROVAL_REASON_MIN} characters. It is written to each payout&rsquo;s history.
        </div>
      )}
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Type <strong style={{ color: 'var(--text-primary)' }}>{phrase}</strong> to confirm the amount
        <StyledInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} style={{ width: 200 }} />
      </label>
    </Modal>
  );
};

/**
 * What a bulk invitation round did, per assayer, grouped by outcome.
 *
 * The two refusals — an active bill already standing, nothing eligible left by that assayer's
 * turn — are expected states of the round and read as counts. 'failed' is neither: it is an
 * infrastructure error on ONE assayer that the round deliberately did not let abort the other
 * forty, so it is listed name by name with the server's error text, in the danger tone, and told
 * apart from "skipped" — those assayers were NOT invited and nothing about their book decided that.
 */
export const InviteOutcomeSummary: React.FC<{
  result: AssayerInvoiceInviteAllResult;
  /** Assayer label for an id — the page names who it can see; ids stand in for the rest. */
  nameOf: (assayerId: string) => string;
}> = ({ result, nameOf }) => {
  const by = (o: string) => result.outcomes.filter((x) => x.outcome === o);
  const invited = by('invited');
  const skippedActive = by('skipped-active-invoice');
  const nothingEligible = by('nothing-eligible');
  const failed = by('failed');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 'var(--text-xs)' }}>
      {result.outcomes.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No assayer has unbilled work right now — there was nobody to invite.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)' }}>
          <div><strong style={{ color: 'var(--text-primary)' }}>{invited.length}</strong> invited — each now sees their amounts and can confirm.</div>
          {skippedActive.length > 0 && (
            <div><strong>{skippedActive.length}</strong> skipped — they already hold an active bill; approve or cancel it first.</div>
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
  /** The queued payment run's stage line while it runs — see `bulkProgress` in the tab. */
  progress?: string | null;
  onPay: (dto: { paymentReference: string; method: PaymentMethod; paidDate?: string; notes?: string }) => Promise<void>;
}> = ({ payables, busy, progress, onClose, onPay }) => {
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.NEFT);
  const [paidDate, setPaidDate] = useState(businessTodayDateKey());
  const [notes, setNotes] = useState('');
  const total = payables.reduce((s, p) => s + Number(p.totalAmount) - Number(p.paidAmount), 0);
  const assayers = new Set(payables.map((p) => p.assayerId)).size;
  // A bank account that changed after approval is still paid on the frozen one (audit F2): say so.
  const checks = usePayoutDestinationChecks(payables.map((p) => p.id));
  return (
    <Modal open onClose={onClose} title={<><Banknote size={18} /> Record payment of {payables.length} payout{payables.length === 1 ? '' : 's'}</>} width="520px" asForm
      onSubmit={(e) => { e.preventDefault(); if (!reference.trim()) return; void onPay({ paymentReference: reference.trim(), method, paidDate: paidDate || undefined, notes: notes || undefined }); }}
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Total <strong>{money(total)}</strong> to {assayers} assayer{assayers === 1 ? '' : 's'}</span>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={busy || !reference.trim()} className="btn btn-primary">{busy ? 'Paying…' : 'Record payment'}</button>
      </>}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
        This records money the bank has already sent — it does not move any. Each payout is settled in full. One bank reference may cover the whole batch.
      </div>
      <DestinationWarnings checks={checks.data} />
      <StyledInput placeholder="Bank / UTR reference *" value={reference} onChange={(e) => setReference(e.target.value)} style={{ width: '100%' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Select value={method} onChange={(v) => setMethod(v as PaymentMethod)} options={METHODS.map((m) => ({ value: m, label: paymentMethodLabel(m) }))} style={{ width: '100%' }} />
        <StyledInput type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} style={{ width: '100%' }} />
      </div>
      <StyledInput placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: '100%' }} />
      {progress && <div role="status" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{progress}</div>}
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
  'Waiting for the assayer’s invoice',
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
      <div style={{ fontSize: 'var(--text-sm)' }}>
        <strong>{row.assignmentNumber ?? row.payableNumber}</strong> · {row.assayerName} · {money(Number(r(row.totalAmount)) - Number(r(row.paidAmount)))}
      </div>
      {releasing ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>Held for: <em>{row.holdReason}</em>. Releasing lets it be approved and paid again.</div>
      ) : (
        <>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>A held payout cannot be approved or paid until released. The reason is shown to finance and on the assayer's statement.</div>
          <Select
            value={preset}
            onChange={(v) => setPreset(v)}
            options={[
              { value: '', label: 'Why is this on hold? *' },
              ...HOLD_REASONS.map((r) => ({ value: r, label: r })),
              { value: '__other__', label: 'Other…' },
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
      <div style={{ fontSize: 'var(--text-sm)' }}>
        <strong>{row.assignmentNumber ?? row.payableNumber}</strong> · {row.assayerName} · {money(Number(r(row.totalAmount)) - Number(r(row.paidAmount)))}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
        This puts the assignment back to Accepted and voids this payable — it will not be paid
        until the assignment is completed again. Say why; it goes on the assignment's record.
      </div>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being reopened? *" rows={3} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
    </Modal>
  );
};

const r = (v: unknown) => (v == null ? 0 : Number(v));
