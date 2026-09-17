import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, RefreshCw, IndianRupee, Building2, Receipt, Landmark, BarChart3 } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { Modal, StyledInput, useToast, PageHeader } from '../components/ui';
import { useQueuedExcelExport } from '../hooks/useQueuedExcelExport';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';
import { useReconcile, useReconcilePreview } from '../hooks/useBilling';
import { billingApi } from '../services/billing';
import { userMessage } from '../services/errors';
import { LoadFailure } from '../components/LoadFailure';
import { loadFailed } from '../queryClient';
import { OverviewTab } from './billing/OverviewTab';
import { PayoutsTab, type PayoutFilter } from './billing/PayoutsTab';
import { InvoicesTab, type InvoiceFilter } from './billing/InvoicesTab';
import { AssayerInvoicesTab, type AssayerInvoiceFilter } from './billing/AssayerInvoicesTab';
import { Page } from '../components/ui/Page';

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
    <Page>
      <PageHeader
        icon={<IndianRupee size={20} />}
        title="Billing & Payouts"
        subtitle="Manage client invoices, approve assayer bills, and track bank payouts."
        actions={<>
          <button
            onClick={() => void downloadExcel('/reports/billing/jobs', {})}
            disabled={exporting}
            title="Download billing records to Excel"
            className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <FileSpreadsheet size={14} /> {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
          {canInvoice && (
            <button onClick={() => setReconcileOpen(true)} className="btn btn-secondary" title="Sync any missing records" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <RefreshCw size={14} /> Reconcile
            </button>
          )}
        </>}
      />

      {/* Clean, Simple Top-Level Tabs */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid var(--border-color)',
        paddingBottom: 0,
        marginBottom: 12,
        gap: 8,
        overflowX: 'auto',
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => go('invoices')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              border: 'none',
              borderBottom: tab === 'invoices' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              background: 'transparent',
              color: tab === 'invoices' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: tab === 'invoices' ? 600 : 500,
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s ease',
            }}
          >
            <Building2 size={16} style={{ color: tab === 'invoices' ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
            <span>Client Invoices</span>
          </button>

          <button
            type="button"
            onClick={() => go('assayer-invoices')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              border: 'none',
              borderBottom: tab === 'assayer-invoices' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              background: 'transparent',
              color: tab === 'assayer-invoices' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: tab === 'assayer-invoices' ? 600 : 500,
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s ease',
            }}
          >
            <Receipt size={16} style={{ color: tab === 'assayer-invoices' ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
            <span>Assayer Bills</span>
          </button>

          <button
            type="button"
            onClick={() => go('payouts')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              border: 'none',
              borderBottom: tab === 'payouts' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              background: 'transparent',
              color: tab === 'payouts' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: tab === 'payouts' ? 600 : 500,
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s ease',
            }}
          >
            <Landmark size={16} style={{ color: tab === 'payouts' ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
            <span>Pay Assayers</span>
          </button>

          <button
            type="button"
            onClick={() => go('overview')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              border: 'none',
              borderBottom: tab === 'overview' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              background: 'transparent',
              color: tab === 'overview' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: tab === 'overview' ? 600 : 500,
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s ease',
            }}
          >
            <BarChart3 size={16} style={{ color: tab === 'overview' ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
            <span>Overview</span>
          </button>
        </div>
      </div>

      {tab === 'overview' && <OverviewTab onGo={(t, f) => go(t, f)} />}
      {tab === 'payouts' && <PayoutsTab filter={payoutFilter} onFilter={(f) => go('payouts', f === 'ALL' ? undefined : f)} canAct={canPay} canReviewClaims={canReviewClaims} />}
      {tab === 'invoices' && <InvoicesTab filter={invoiceFilter} onFilter={(f) => go('invoices', f === 'ALL' ? undefined : f)} canAct={canInvoice} />}
      {/* Everyone who can open Billing can READ assayer invoices (the auditor included); the
          approve/cancel gate is the same disbursement gate as Payouts — see `canPay` above. */}
      {tab === 'assayer-invoices' && <AssayerInvoicesTab filter={assayerInvoiceFilter} onFilter={(f) => go('assayer-invoices', f === 'ALL' ? undefined : f)} canAct={canPay} />}

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
    <Modal open onClose={onClose} title={<><RefreshCw size={18} /> Reconcile payouts</>} width="520px" footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
        <button type="button" onClick={run} disabled={!!jobId || reconcile.isPending || !count} className="btn btn-primary">
          {jobId ? 'Running…' : count ? `Book ${count} assignment${count === 1 ? '' : 's'}` : 'Nothing to book'}
        </button>
      </>
    }>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Every assignment books its payout and client line the moment it completes. Reconcile finds any <strong>completed</strong> assignment that is missing one and books it — the same way, at today's client rate and tax settings. Nothing already booked is touched.
      </div>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Only assignments completed on or after <span style={{ fontWeight: 400 }}>(blank = the whole book)</span>
        <StyledInput type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 200 }} />
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
