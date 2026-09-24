import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, RefreshCw, IndianRupee, Wrench } from 'lucide-react';
import { SystemRole, AssayerInvoiceStatus, InvoiceStatus } from '@fapoms/shared';
import { Modal, StyledInput, useToast, PageHeader } from '../components/ui';
import { useQueuedExcelExport } from '../hooks/useQueuedExcelExport';
import { useCurrentRoles, useCurrentPermissions, hasAnyRole, canGiveFinalBillingApproval } from '../hooks/useCurrentRoles';
import { useReconcile, useReconcilePreview, useAssayerInvoices, useBillingInvoices, useBillingOverview, useFinalApprovalQueue } from '../hooks/useBilling';
import { queryKeys } from '../hooks/queryKeys';
import { getPendingExpenses } from '../services/expenses';
import { billingApi } from '../services/billing';
import { userMessage } from '../services/errors';
import { LoadFailure } from '../components/LoadFailure';
import { loadFailed } from '../queryClient';
import { TodoTab } from './billing/TodoTab';
import { PayoutsTab } from './billing/PayoutsTab';
import { InvoicesTab, type InvoiceFilter } from './billing/InvoicesTab';
import { AssayerInvoicesTab, type AssayerInvoiceFilter } from './billing/AssayerInvoicesTab';
import { FinalApprovalTab } from './billing/FinalApprovalTab';
import { ExpenseReview } from './ExpenseReview';
import { Card } from './billing/shared';
import { JOBS, jobFromParam, payoutStage, type BillingJob, type PayoutStage } from './billing/vocabulary';
import { Page } from '../components/ui/Page';

/**
 * Billing — five tabs, one per job the desk actually does, in the order the work happens.
 *
 * What this replaced, and why: the page opened on a row of three "hub" cards, which switched
 * between four tabs, one of which revealed a second row of two sub-tabs, one of WHICH held a
 * third switcher between two sub-views, above five status filters. Four levels of navigation to
 * reach a list, and the three cards did not map onto the four tabs — picking "Assayer Claims &
 * Payables" landed you somewhere different depending on which tab you happened to be on. The
 * same object was called six different things on the way down (see `vocabulary.ts`).
 *
 * Now: one flat strip. Every tab is a job, named as a job, with a count of what is waiting in
 * it. Expense claims — a gate that has to be passed before a payout exists at all — used to be
 * the deepest thing on the page and is now a tab of its own. Nothing is nested.
 *
 * Money still appears on its own when an assignment completes. Nothing on these screens is
 * typed by hand except a bank reference, an amount adjustment and a reason.
 */
export const Billing: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const roles = useCurrentRoles();
  const { toast } = useToast();

  /**
   * Paying and invoicing are the same gate now, and that is worth saying out loud.
   *
   * These were two different lists — releasing cash was finance's, raising an invoice was
   * billing's — so the person who created the work was not the person who approved payment for
   * it. FINANCE_MANAGER folded into OPERATIONS in the role consolidation, which collapsed both
   * lists onto ADMIN + OPERATIONS and took that separation with it. See the note on
   * SystemRole.OPERATIONS: ADMIN remains on the disbursement path for exactly this reason.
   */
  const canPay = hasAnyRole(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS]);
  const canInvoice = canPay;
  const canReviewClaims = canInvoice;
  /**
   * The HOD (2026-09-24): whoever holds the final billing approval — Admin, or a role built in
   * Users & Roles with it. Only they see the Final approval tab; nobody else has anything to do there.
   */
  const isHod = canGiveFinalBillingApproval(roles, useCurrentPermissions());
  const jobs = JOBS.filter((j) => j.key !== 'final' || isHod);

  const requested = jobFromParam(params.get('tab'));
  const job: BillingJob = requested === 'final' && !isHod ? 'todo' : requested;
  const stage = payoutStage(params.get('stage'));
  const invoiceFilter = (params.get('invoices') as InvoiceFilter) || 'ALL';
  const billFilter = (params.get('bills') as AssayerInvoiceFilter) || 'ALL';

  /**
   * One place that writes the URL, so a tab change cannot leave another tab's filter behind.
   *
   * The old `go` kept every parameter it was not told about, which is how landing on Payouts
   * from a bookmark could silently carry an invoice filter that then applied the moment you
   * switched tabs. Each move now states the whole address.
   */
  const go = (next: BillingJob, opts: { stage?: PayoutStage; bills?: string; invoices?: string } = {}) => {
    const q = new URLSearchParams();
    if (next !== 'todo') q.set('tab', next);
    if (next === 'pay' && opts.stage) q.set('stage', opts.stage);
    if (next === 'bills' && opts.bills) q.set('bills', opts.bills);
    if (next === 'invoices' && opts.invoices) q.set('invoices', opts.invoices);
    setParams(q, { replace: false });
  };

  /**
   * The badge on each tab: how many things in there are waiting on THIS desk.
   *
   * Deliberately not "how many rows does this tab hold" — the pay tab holds hundreds of settled
   * payouts nobody needs to look at. A badge that counts those trains people to ignore badges.
   * Each of these is the same query its tab runs, so the number and the list agree, and a query
   * that fails shows no badge at all rather than a zero.
   */
  const claims = useQuery({ queryKey: queryKeys.billing.pendingExpenses(), queryFn: getPendingExpenses, staleTime: 30_000, enabled: canReviewClaims });
  const billsToApprove = useAssayerInvoices({ status: AssayerInvoiceStatus.SUBMITTED, page: 1, limit: 1 });
  const draftInvoices = useBillingInvoices({ status: InvoiceStatus.DRAFT, page: 1, limit: 1 });
  // Approved by the HOD and not yet marked sent — the office's next move on a client invoice.
  const readyToSend = useBillingInvoices({ status: InvoiceStatus.HOD_APPROVED, page: 1, limit: 1 });
  // Mounted for the HOD only: nobody else can read it, and nobody else acts on it.
  const finalQueue = useFinalApprovalQueue({ enabled: isHod });
  // Shares the To-do tab's cache entry, so opening the page costs one overview read, not two.
  const overview = useBillingOverview();
  const waiting: Partial<Record<BillingJob, number | undefined>> = {
    expenses: loadFailed(claims) ? undefined : claims.data?.length,
    bills: loadFailed(billsToApprove) ? undefined : billsToApprove.data?.total,
    // Ready to pay: approved by the office AND the HOD. Waiting for the HOD is not this desk's move.
    pay: loadFailed(overview) || !overview.data
      ? undefined
      : overview.data.payouts.approvedCount - (overview.data.payouts.awaitingHodCount ?? 0),
    invoices: loadFailed(draftInvoices) || loadFailed(readyToSend)
      ? undefined
      : (draftInvoices.data?.total ?? 0) + (readyToSend.data?.total ?? 0),
    final: isHod && !loadFailed(finalQueue) ? finalQueue.data?.total : undefined,
  };

  const { download: downloadExcel, busy: exporting } = useQueuedExcelExport();
  const [reconcileOpen, setReconcileOpen] = useState(false);

  return (
    <Page>
      <PageHeader
        icon={<IndianRupee size={20} />}
        title="Billing"
        subtitle="What we owe assayers, and what clients owe us. Both open by themselves when an assignment completes."
        actions={<>
          <button
            onClick={() => void downloadExcel('/reports/billing/jobs', {})}
            disabled={exporting}
            title="Download billing records to Excel"
            className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <FileSpreadsheet size={14} /> {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
          {/*
            Reconcile is a repair tool, not a step of anybody's day, and it used to sit in the
            header looking exactly like the export beside it. It is labelled as repair now and
            says what it is for before it does anything.
          */}
          {canInvoice && (
            <button onClick={() => setReconcileOpen(true)} className="btn btn-secondary" title="Repair: book any completed assignment whose money never got created"
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: 'var(--text-secondary)' }}>
              <Wrench size={14} /> Repair
            </button>
          )}
        </>}
      />

      <div role="tablist" aria-label="Billing jobs" style={{
        display: 'flex', gap: 4, marginBottom: 16, padding: 4, background: 'var(--bg-tertiary)',
        borderRadius: 'var(--radius-md)', overflowX: 'auto',
      }}>
        {jobs.map((t) => {
          const active = job === t.key;
          const n = waiting[t.key];
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => go(t.key)}
              title={t.hint}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', whiteSpace: 'nowrap',
                borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                background: active ? 'var(--bg-surface, var(--bg-secondary))' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                fontWeight: active ? 700 : 500, fontSize: 'var(--text-sm)',
              }}
            >
              {t.label}
              {!!n && (
                <span style={{
                  fontSize: 'var(--text-3xs, var(--text-2xs))', fontWeight: 700, lineHeight: 1, padding: '3px 6px',
                  borderRadius: 'var(--radius-full)', background: 'var(--accent-primary)', color: '#fff',
                }}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* One line under the strip saying what this tab is for, so the tab name never has to
          carry the whole explanation. */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 12 }}>
        {JOBS.find((t) => t.key === job)?.hint}
      </div>

      {job === 'todo' && <TodoTab onGo={go} />}
      {job === 'expenses' && (
        <Card>
          <ExpenseReview />
        </Card>
      )}
      {job === 'bills' && <AssayerInvoicesTab filter={billFilter} onFilter={(f) => go('bills', { bills: f === 'ALL' ? undefined : f })} canAct={canPay} />}
      {job === 'pay' && <PayoutsTab stage={stage} onStage={(s) => go('pay', { stage: s })} canAct={canPay} />}
      {job === 'invoices' && <InvoicesTab filter={invoiceFilter} onFilter={(f) => go('invoices', { invoices: f === 'ALL' ? undefined : f })} canAct={canInvoice} />}
      {job === 'final' && isHod && <FinalApprovalTab />}

      {reconcileOpen && <ReconcileModal onClose={() => setReconcileOpen(false)} onDone={(msg) => { toast('success', msg); setReconcileOpen(false); }} />}
    </Page>
  );
};

/**
 * The admin repair button, with a count before it does anything. The automatic path is the
 * event on completion; this exists for the day an event was lost or a database was restored.
 */
const ReconcileModal: React.FC<{ onClose: () => void; onDone: (msg: string) => void }> = ({ onClose, onDone }) => {
  const { toast } = useToast();
  const [since, setSince] = useState('');
  const preview = useReconcilePreview(since || undefined);
  const reconcile = useReconcile();
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await billingApi.jobStatus(jobId);
        if (cancelled) return;
        if (s.state === 'done') {
          const r = s.result;
          onDone(r ? `Repair finished: ${r.booked} booked, ${r.skipped} already booked, ${r.errors.length} could not be booked.` : 'Repair finished.');
          return;
        }
        if (s.state === 'failed') { toast({ type: 'error', title: 'Repair failed', message: s.error ?? 'Unknown error' }); setJobId(null); return; }
        setProgress(s.progress?.stage ?? (s.state === 'queued' ? 'Waiting in the queue…' : 'Running…'));
        setTimeout(tick, 1500);
      } catch (e) {
        if (!cancelled) { toast({ type: 'error', title: 'Lost the job', message: userMessage(e) }); setJobId(null); }
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [jobId, onDone, toast]);

  const run = async () => {
    try {
      const r = await reconcile.mutateAsync(since || undefined);
      setJobId(r.jobId);
      setProgress(r.deduplicated ? 'Joined a repair already running…' : 'Queued…');
    } catch (e) { toast({ type: 'error', title: 'Could not start', message: userMessage(e) }); }
  };

  const count = preview.data?.count;
  return (
      <Modal open onClose={onClose} title={<><RefreshCw size={18} /> Repair missing money records</>} width="520px" footer={
      <>
        <button type="button" onClick={onClose} title="Close without booking anything" className="btn btn-secondary">Close</button>
        <button type="button" onClick={run} disabled={!!jobId || reconcile.isPending || !count} title={count ? `Book ${count} missing money records now` : 'Nothing missing, nothing to book'} className="btn btn-primary">
          {jobId ? 'Running…' : count ? `Book ${count} assignment${count === 1 ? '' : 's'}` : 'Nothing to book'}
        </button>
      </>
    }>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        You should not normally need this. Every assignment books its payout and client line the moment it completes; this finds any <strong>completed</strong> assignment that is missing one and books it — the same way, at today&rsquo;s client rate and tax settings. Nothing already booked is touched.
      </div>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Only assignments completed on or after <span style={{ fontWeight: 400 }}>(blank = the whole book)</span>
        <StyledInput type="date" value={since} onChange={(e) => setSince(e.target.value)} title="Only check assignments completed on or after this date" style={{ width: 200 }} />
      </label>
      {/*
        "Could not count." was the whole of what this said when the preview failed — no reason, no
        way to tell a refusal from a timeout — and it sat next to a disabled button reading
        "Nothing to book", which is the opposite claim: one says it does not know, the other says
        it does. The count is what somebody decides on, so the failure states its reason.
      */}
      {loadFailed(preview) && <LoadFailure loads={[{ label: 'the count of assignments waiting to be booked', query: preview }]} />}
      <div style={{ fontSize: 'var(--text-sm)', padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        {loadFailed(preview)
          ? 'The count above could not be read, so nothing can be booked from here until it can.'
          : preview.isLoading ? 'Counting…' : count === undefined ? 'Could not count.' : count === 0 ? 'Every completed assignment is booked. Nothing to do.' : <>This will book <strong>{count}</strong> completed assignment{count === 1 ? '' : 's'}.</>}
        {jobId && <div style={{ marginTop: 6, color: 'var(--accent)' }}>{progress}</div>}
      </div>
    </Modal>
  );
};
