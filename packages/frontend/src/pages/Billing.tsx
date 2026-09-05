import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, RefreshCw, IndianRupee } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { Modal, StyledInput, useToast, PageHeader } from '../components/ui';
import { useQueuedExcelExport } from '../hooks/useQueuedExcelExport';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';
import { useReconcile, useReconcilePreview } from '../hooks/useBilling';
import { billingApi } from '../services/billing';
import { userMessage } from '../services/errors';
import { OverviewTab } from './billing/OverviewTab';
import { PayoutsTab, type PayoutFilter } from './billing/PayoutsTab';
import { InvoicesTab, type InvoiceFilter } from './billing/InvoicesTab';
import { AssayerInvoicesTab, type AssayerInvoiceFilter } from './billing/AssayerInvoicesTab';

/**
 * Billing — four tabs, because the business has four jobs: see the book (Overview), pay the
 * assayers (Payouts), bill the clients (Invoices), and approve what assayers have confirmed
 * they are owed (Assayer Invoices — the consent step that first shows an assayer their money).
 * Money appears on its own when an assignment completes; nothing here is typed by hand except
 * a bank reference and a reason.
 */
type Tab = 'overview' | 'payouts' | 'invoices' | 'assayer-invoices';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'invoices', label: 'Invoices' },
  // Notification links deep-link here as `/billing?tab=assayer-invoices` — the key is part of
  // the catalog's contract, not just this file's routing.
  { key: 'assayer-invoices', label: 'Assayer Invoices' },
];

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

  const tab = (TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const payoutFilter = (params.get('payouts') as PayoutFilter) || 'ALL';
  const invoiceFilter = (params.get('invoices') as InvoiceFilter) || 'ALL';
  const assayerInvoiceFilter = (params.get('assayer-invoices') as AssayerInvoiceFilter) || 'ALL';
  const go = (t: Tab, filter?: string) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    if (t === 'payouts') { if (filter) next.set('payouts', filter); else next.delete('payouts'); }
    if (t === 'invoices') { if (filter) next.set('invoices', filter); else next.delete('invoices'); }
    if (t === 'assayer-invoices') { if (filter) next.set('assayer-invoices', filter); else next.delete('assayer-invoices'); }
    setParams(next, { replace: false });
  };

  const { download: downloadExcel, busy: exporting } = useQueuedExcelExport();
  const [reconcileOpen, setReconcileOpen] = useState(false);

  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        icon={<IndianRupee size={20} />}
        title="Billing"
        subtitle="Every completed assignment books a payout to the assayer and a line to invoice the client."
        actions={<>
          {/* The billing sheet is built over the whole book, so it can take a while — now on a
              queue rather than blocking the request, and capped at the first 5,000 client lines
              (the sheet's own "Notice" tab says so if a filter combination is that wide).
              Disabled while it runs — a second click used to start a second full build. */}
          <button
            onClick={() => void downloadExcel('/reports/billing/jobs', {})}
            disabled={exporting}
            title="Excel export, capped at the first 5,000 client lines. Narrow the filters if your book is larger."
            className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <FileSpreadsheet size={14} /> {exporting ? 'Preparing…' : 'Export'}
          </button>
          {canInvoice && (
            <button onClick={() => setReconcileOpen(true)} className="btn btn-secondary" title="Book any completed assignment that is missing a payout or client line" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <RefreshCw size={14} /> Reconcile
            </button>
          )}
        </>}
      />

      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => go(t.key)} style={{
            padding: '8px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            background: tab === t.key ? 'var(--status-pending-bg)' : 'transparent', color: tab === t.key ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: `1px solid ${tab === t.key ? 'var(--accent-primary)' : 'transparent'}`,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab onGo={(t, f) => go(t, f)} />}
      {tab === 'payouts' && <PayoutsTab filter={payoutFilter} onFilter={(f) => go('payouts', f === 'ALL' ? undefined : f)} canAct={canPay} canReviewClaims={canReviewClaims} />}
      {tab === 'invoices' && <InvoicesTab filter={invoiceFilter} onFilter={(f) => go('invoices', f === 'ALL' ? undefined : f)} canAct={canInvoice} />}
      {/* Everyone who can open Billing can READ assayer invoices (the auditor included); the
          approve/cancel gate is the same disbursement gate as Payouts — see `canPay` above. */}
      {tab === 'assayer-invoices' && <AssayerInvoicesTab filter={assayerInvoiceFilter} onFilter={(f) => go('assayer-invoices', f === 'ALL' ? undefined : f)} canAct={canPay} />}

      {reconcileOpen && <ReconcileModal onClose={() => setReconcileOpen(false)} onDone={(msg) => { toast('success', msg); setReconcileOpen(false); }} />}
    </div>
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
          onDone(r ? `Reconcile finished: ${r.booked} booked, ${r.skipped} already booked, ${r.errors.length} could not be booked.` : 'Reconcile finished.');
          return;
        }
        if (s.state === 'failed') { toast({ type: 'error', title: 'Reconcile failed', message: s.error ?? 'Unknown error' }); setJobId(null); return; }
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
      setProgress(r.deduplicated ? 'Joined a reconcile already running…' : 'Queued…');
    } catch (e) { toast({ type: 'error', title: 'Could not start', message: userMessage(e) }); }
  };

  const count = preview.data?.count;
  return (
    <Modal open onClose={onClose} title={<><RefreshCw size={18} /> Reconcile the book</>} width="520px" footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
        <button type="button" onClick={run} disabled={!!jobId || reconcile.isPending || !count} className="btn btn-primary">
          {jobId ? 'Running…' : count ? `Book ${count} assignment${count === 1 ? '' : 's'}` : 'Nothing to book'}
        </button>
      </>
    }>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Every assignment books its payout and client line the moment it completes. Reconcile finds any <strong>completed</strong> assignment that is missing one and books it — the same way, at today's client rate and tax settings. Nothing already booked is touched.
      </div>
      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Only assignments completed on or after <span style={{ fontWeight: 400 }}>(blank = the whole book)</span>
        <StyledInput type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 200 }} />
      </label>
      <div style={{ fontSize: 13, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
        {preview.isLoading ? 'Counting…' : count === undefined ? 'Could not count.' : count === 0 ? 'Every completed assignment is booked. Nothing to do.' : <>This will book <strong>{count}</strong> completed assignment{count === 1 ? '' : 's'}.</>}
        {jobId && <div style={{ marginTop: 6, color: 'var(--accent)' }}>{progress}</div>}
      </div>
    </Modal>
  );
};
