import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, RefreshCw } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { Modal, StyledInput, useToast } from '../components/ui';
import { useExcelExport } from '../hooks/useExcelExport';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';
import { useReconcile, useReconcilePreview } from '../hooks/useBilling';
import { billingApi } from '../services/billing';
import { userMessage } from '../services/errors';
import { OverviewTab } from './billing/OverviewTab';
import { PayoutsTab, type PayoutFilter } from './billing/PayoutsTab';
import { InvoicesTab, type InvoiceFilter } from './billing/InvoicesTab';

/**
 * Billing — three tabs, because the business has three jobs: see the book (Overview), pay the
 * assayers (Payouts), bill the clients (Invoices). Money appears on its own when an assignment
 * completes; nothing here is typed by hand except a bank reference and a reason.
 */
type Tab = 'overview' | 'payouts' | 'invoices';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'invoices', label: 'Invoices' },
];

export const Billing: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const roles = useCurrentRoles();
  const { toast } = useToast();

  // Money leaving the business has one gate: finance or an administrator.
  const canPay = hasAnyRole(roles, [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.FINANCE_MANAGER]);
  // Invoicing is billing staff; operations raise invoices, they do not release cash.
  const canInvoice = hasAnyRole(roles, [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.FINANCE_MANAGER, SystemRole.OPERATIONS_MANAGER]);
  const canReviewClaims = canInvoice;

  const tab = (TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const payoutFilter = (params.get('payouts') as PayoutFilter) || 'ALL';
  const invoiceFilter = (params.get('invoices') as InvoiceFilter) || 'ALL';
  const go = (t: Tab, filter?: string) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    if (t === 'payouts') { if (filter) next.set('payouts', filter); else next.delete('payouts'); }
    if (t === 'invoices') { if (filter) next.set('invoices', filter); else next.delete('invoices'); }
    setParams(next, { replace: false });
  };

  const { download: downloadExcel } = useExcelExport();
  const [reconcileOpen, setReconcileOpen] = useState(false);

  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Billing</h1>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Every completed assignment books a payout to the assayer and a line to invoice the client.</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => void downloadExcel('/reports/billing', {})} className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <FileSpreadsheet size={14} /> Export
          </button>
          {canInvoice && (
            <button onClick={() => setReconcileOpen(true)} className="btn btn-secondary" title="Book any completed assignment that is missing a payout or client line" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <RefreshCw size={14} /> Reconcile
            </button>
          )}
        </div>
      </div>

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
