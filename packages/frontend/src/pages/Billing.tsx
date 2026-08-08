import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, AlertTriangle, Banknote, FileText, RefreshCw } from 'lucide-react';
import {
  useBillingDashboard,
  useBillingEntries,
  useBillingInvoices,
  useBillingPayables,
  useBillingConflicts,
  useBillingHistory,
  useSyncFromAssignments,
  useBillingClients,
} from '../hooks/useBilling';
import { billingApi } from '../services/billing';
import { ClientHierarchyPanel } from './billing/ClientHierarchyPanel';
import { FinanceDashboard } from './billing/FinanceDashboard';
import type {
  BillingInvoice,
  BillingConflict,
} from '@fapoms/shared';
import {
  BillingLevel,
  BillingState,
  PaymentState,
  BillingPricingModel,
  InvoiceStatus,
  AssayerPayableStatus,
  BillingConflictSeverity,
  BillingConflictStatus,
  BILLING_STATE_TRANSITIONS,
} from '@fapoms/shared';
import { CreateBillingEntryModal } from './billing/CreateBillingEntryModal';
import { EntryDetailDrawer } from './billing/EntryDetailDrawer';
import { CreateInvoiceModal } from './billing/CreateInvoiceModal';
import { InvoiceDetailDrawer } from './billing/InvoiceDetailDrawer';
import { CreatePayableModal, PayableDetailDrawer } from './billing/PayableModals';
import { RaiseConflictModal, ConflictDetailDrawer } from './billing/ConflictModals';
import { useToast } from '../components/ui';
import { userMessage } from '../services/errors';
import { formatRupees as money } from '@fapoms/shared';


type Tab = 'finance' | 'overview' | 'hierarchy' | 'entries' | 'invoices' | 'payables' | 'conflicts' | 'history';

const STATE_BADGE: Record<BillingState, string> = {
  NOT_BILLABLE: 'var(--text-muted)',
  PENDING_BILLING: 'var(--text-secondary)',
  READY_FOR_BILLING: '#d8ae47',
  DRAFT: '#d8ae47',
  SUBMITTED: '#b8791f',
  UNDER_REVIEW: '#d8ae47',
  REJECTED: '#b14444',
  APPROVED: '#3f7d53',
  INVOICED: '#3f7d53',
  PARTIALLY_PAID: '#b8791f',
  PAID: '#3f7d53',
  ON_HOLD: '#7c6e59',
  DISPUTED: '#b14444',
  CANCELLED: '#7c6e59',
  ADJUSTED: '#b14444',
};

const PAY_STATE_BADGE: Record<PaymentState, string> = {
  UNPAID: 'var(--text-secondary)',
  PARTIALLY_PAID: '#b8791f',
  PAID: '#3f7d53',
  REVERSED: '#b14444',
};

const INV_BADGE: Record<InvoiceStatus, string> = {
  DRAFT: '#d8ae47',
  ISSUED: '#d8ae47',
  PARTIALLY_PAID: '#b8791f',
  PAID: '#3f7d53',
  DISPUTED: '#b14444',
  CANCELLED: '#7c6e59',
  VOID: '#7c6e59',
};

const PAYABLE_BADGE: Record<AssayerPayableStatus, string> = {
  PENDING: '#b8791f',
  APPROVED: '#d8ae47',
  PAID: '#3f7d53',
  DISPUTED: '#b14444',
  ON_HOLD: '#7c6e59',
};

const CONFLICT_BADGE: Record<BillingConflictSeverity, string> = {
  INFO: '#d8ae47',
  WARNING: '#b8791f',
  CRITICAL: '#b14444',
};

const CONFLICT_STATUS_BADGE: Record<BillingConflictStatus, string> = {
  OPEN: '#b8791f',
  RESOLVED: '#3f7d53',
  MERGED: '#3f7d53',
  SEPARATED: '#d8ae47',
  REASSIGNED: '#d8ae47',
  OVERRIDDEN: '#d8ae47',
  REJECTED: '#b14444',
  ON_HOLD: '#7c6e59',
};

const Badge: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span style={{
    display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    background: `${color}22`, color, fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
  }}>{children}</span>
);

const Card: React.FC<{ title?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, children, style }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '18px', ...style }}>
    {title && <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' }}>{title}</h3>}
    {children}
  </div>
);

const MoneyStat: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = 'var(--text-primary)' }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '16px 18px', flex: 1, minWidth: 150 }}>
    <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: '22px', fontWeight: 700, color, marginTop: 6, fontFamily: 'var(--font-display)' }}>{value}</div>
  </div>
);

const TabButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{
    padding: '8px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
    background: active ? 'var(--status-pending-bg)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
  }}>{children}</button>
);

export const Billing: React.FC = () => {
  const [tab, setTab] = useState<Tab>('finance');
  const [level, setLevel] = useState<BillingLevel | ''>('');
  // Every backend billing filter has always accepted a clientId; the page just
  // never offered a way to set one, so all figures were whole-book totals.
  const [clientId, setClientId] = useState<string>('');

  const [showEntryModal, setShowEntryModal] = useState(false);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showPayableModal, setShowPayableModal] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [openPayableId, setOpenPayableId] = useState<string | null>(null);
  const [openConflictId, setOpenConflictId] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<BillingState | ''>('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState<{ target: string; succeeded: number; skipped: number; failed: { id: string; reason: string }[] } | null>(null);

  const { toast } = useToast();
  const sync = useSyncFromAssignments();

  const handleSync = async () => {
    try {
      const res = await sync.mutateAsync();
      const parts = [`${res.created} receivable entr${res.created === 1 ? 'y' : 'ies'}`];
      if (res.payablesCreated) parts.push(`${res.payablesCreated} assayer payable(s)`);
      if (res.skipped) parts.push(`${res.skipped} already billed`);
      toast('success', `Synced from assignments: ${parts.join(', ')}`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Sync failed', message: userMessage(err) });
    }
  };

  const scope = clientId ? { clientId } : {};
  const clients = useBillingClients();
  const dashboard = useBillingDashboard(clientId || undefined);
  const entries = useBillingEntries({ ...scope, ...(level ? { level } : {}) });
  const invoices = useBillingInvoices(scope);
  const payables = useBillingPayables(scope);
  const conflicts = useBillingConflicts();
  const history = useBillingHistory(scope);

  const levelColor: Record<BillingLevel, string> = {
    CLIENT: '#d8ae47',
    PROJECT: '#d8ae47',
    ASSIGNMENT: '#b8791f',
  };
  const pricingModel: Record<BillingPricingModel, string> = {
    FLAT_RATE: 'Flat', PER_ASSIGNMENT: 'Per Assignment', PER_BRANCH: 'Per Branch',
    PER_PACKET: 'Per Packet', HOURLY: 'Hourly', RETAINER: 'Retainer',
  };

  const selectedEntries = entries.data?.filter((e) => selectedEntryIds.has(e.id)) ?? [];
  /** Target states reachable from any selected entry (union, mirrors the backend
   *  state machine) — so a mixed-state batch can all move to a common goal. */
  const bulkTargets = useMemo(() => {
    if (selectedEntries.length === 0) return [] as BillingState[];
    const reachable = new Set<BillingState>();
    for (const e of selectedEntries) {
      for (const s of BILLING_STATE_TRANSITIONS[e.state] ?? []) reachable.add(s);
    }
    return [...reachable];
  }, [selectedEntries]);

  const runBulkTransition = async () => {
    if (!bulkTarget || selectedEntryIds.size === 0) return;
    setBulkBusy(true);
    setBulkReport(null);
    try {
      const res = await billingApi.bulkTransitionEntries([...selectedEntryIds], bulkTarget);
      const { succeeded, skipped, failed } = res ?? { succeeded: [], skipped: [], failed: [] };
      setBulkReport({ target: bulkTarget, succeeded: succeeded.length, skipped: skipped.length, failed });
      toast('success', `${succeeded.length} entry(ies) moved to ${bulkTarget.replace(/_/g, ' ')}.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Bulk transition failed', message: userMessage(err) });
    } finally {
      setBulkBusy(false);
      setBulkTarget('');
      setSelectedEntryIds(new Set());
      entries.refetch();
    }
  };

  const toggleEntrySelect = (id: string) =>
    setSelectedEntryIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'var(--font-display)', margin: 0 }}>Billing Engine</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            The single financial system: client receivables, assayer payables, invoicing,
            payments and reporting.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={handleSync} disabled={sync.isPending} className="btn btn-secondary" title="Ingest real completed/checked-in assignments with agreed fees into billing"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}>
            <RefreshCw size={15} className={sync.isPending ? 'spin' : ''} /> {sync.isPending ? 'Syncing...' : 'Sync from Assignments'}
          </button>
          <button onClick={() => setShowEntryModal(true)} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}><Plus size={15} /> Entry</button>
          <button onClick={() => setShowInvoiceModal(true)} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}><FileText size={15} /> Invoice</button>
          <button onClick={() => setShowPayableModal(true)} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}><Banknote size={15} /> Payable</button>
          <button onClick={() => setShowConflictModal(true)} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}><AlertTriangle size={15} /> Conflict</button>
        </div>
      </div>
      {showEntryModal && <CreateBillingEntryModal onClose={() => setShowEntryModal(false)} />}
      {showInvoiceModal && <CreateInvoiceModal onClose={() => setShowInvoiceModal(false)} />}
      {showPayableModal && <CreatePayableModal onClose={() => setShowPayableModal(false)} />}
      {showConflictModal && <RaiseConflictModal onClose={() => setShowConflictModal(false)} />}
      {openEntryId && <EntryDetailDrawer entryId={openEntryId} onClose={() => setOpenEntryId(null)} />}
      {openInvoiceId && <InvoiceDetailDrawer invoiceId={openInvoiceId} onClose={() => setOpenInvoiceId(null)} />}
      {openPayableId && <PayableDetailDrawer payableId={openPayableId} onClose={() => setOpenPayableId(null)} />}
      {openConflictId && <ConflictDetailDrawer conflictId={openConflictId} onClose={() => setOpenConflictId(null)} />}

      {/* Scopes the whole workspace to one client — billing questions are almost
          always asked per client ("what does SBI owe us?"), not across the book. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Client:</label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{ padding: '7px 11px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 13, minWidth: 240 }}
        >
          <option value="">All clients</option>
          {clients.data?.map((c) => (
            <option key={c.clientId} value={c.clientId}>
              {c.clientName}{Number(c.entryCount) > 0 ? ` (${c.entryCount} lines)` : ''}
            </option>
          ))}
        </select>
        {clientId && (() => {
          const c = clients.data?.find((x) => x.clientId === clientId);
          return c ? (
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              Terms {c.paymentTerms ?? '—'} · GST {Number(c.gstRate ?? 0)}% · TDS {Number(c.tdsRate ?? 0)}%
            </span>
          ) : null;
        })()}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <TabButton active={tab === 'finance'} onClick={() => setTab('finance')}>Finance</TabButton>
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
        <TabButton active={tab === 'hierarchy'} onClick={() => setTab('hierarchy')}>Client → Projects → Assignments</TabButton>
        <TabButton active={tab === 'entries'} onClick={() => setTab('entries')}>Entries</TabButton>
        <TabButton active={tab === 'invoices'} onClick={() => setTab('invoices')}>Invoices</TabButton>
        <TabButton active={tab === 'payables'} onClick={() => setTab('payables')}>Assayer Payables</TabButton>
        <TabButton active={tab === 'conflicts'} onClick={() => setTab('conflicts')}>Conflicts</TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>History</TabButton>
        {/* New standalone pages surfacing capability the backend always had. */}
        <Link to={clientId ? `/billing/ledger?type=client&id=${clientId}` : '/billing/ledger'}
          style={{ padding: '7px 13px', fontSize: 13, fontWeight: 600, borderRadius: 8, textDecoration: 'none', color: 'var(--accent)', border: '1px solid var(--border-color)' }}>Ledger →</Link>
        <Link to={clientId ? `/billing/settings?client=${clientId}` : '/billing/settings'}
          style={{ padding: '7px 13px', fontSize: 13, fontWeight: 600, borderRadius: 8, textDecoration: 'none', color: 'var(--accent)', border: '1px solid var(--border-color)' }}>Rate cards →</Link>
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {dashboard.isLoading && <div style={{ color: 'var(--text-muted)' }}>Loading dashboard…</div>}
          {dashboard.data && (
            <>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                <MoneyStat label="Billed" value={`${money(dashboard.data.totals.billed)}`} color="var(--accent)" />
                <MoneyStat label="Paid" value={`${money(dashboard.data.totals.paid)}`} color="var(--success)" />
                <MoneyStat label="Outstanding" value={`${money(dashboard.data.totals.outstanding)}`} color="var(--warning)" />
                <MoneyStat label="Unbilled Revenue" value={`${money(dashboard.data.totals.unbilledRevenue ?? dashboard.data.totals.pending)}`} color="var(--accent)" />
                <MoneyStat label="Disputed" value={`${money(dashboard.data.totals.disputed)}`} color="var(--danger)" />
              </div>
              {/* Revenue vs what we owe assayers — the cost-per-audit question this
                  platform exists to answer, which billing could not previously show. */}
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                <MoneyStat label="Net Revenue" value={`${money(dashboard.data.totals.revenue)}`} color="var(--accent)" />
                <MoneyStat label="Assayer Cost" value={`${money(dashboard.data.totals.assayerCost)}`} color="var(--warning)" />
                <MoneyStat
                  label="Margin"
                  value={`${money(dashboard.data.totals.margin)}${dashboard.data.totals.marginPct != null ? ` (${dashboard.data.totals.marginPct}%)` : ''}`}
                  color={(dashboard.data.totals.margin ?? 0) < 0 ? 'var(--danger)' : 'var(--success)'}
                />
              </div>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                <MoneyStat label="Invoices Issued" value={String(dashboard.data.invoices.issued)} color="var(--accent)" />
                <MoneyStat label="Open Conflicts" value={String(dashboard.data.openConflicts)} color={dashboard.data.openConflicts > 0 ? 'var(--danger)' : 'var(--success)'} />
              </div>
              <Card title="By Level">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(Object.keys(dashboard.data.byLevel) as BillingLevel[]).map((lvl) => {
                    const d = dashboard.data!.byLevel[lvl];
                    return (
                      <div key={lvl} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Badge color={levelColor[lvl]}>{lvl}</Badge>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {money(d.billed)} billed · {money(d.paid)} paid · {money(d.outstanding)} outstanding
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Card>
              <Card title="Assayer Payables">
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                  <MoneyStat label="Pending" value={`${money(dashboard.data.payable.pending)}`} color="var(--warning)" />
                  <MoneyStat label="Approved" value={`${money(dashboard.data.payable.approved)}`} color="var(--accent)" />
                  <MoneyStat label="Paid" value={`${money(dashboard.data.payable.paid)}`} color="var(--success)" />
                  <MoneyStat label="Disputed" value={`${money(dashboard.data.payable.disputed)}`} color="var(--danger)" />
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {tab === 'finance' && <FinanceDashboard onNavigate={(t) => setTab(t as Tab)} />}

      {tab === 'hierarchy' && <ClientHierarchyPanel clientId={clientId || null} />}

      {tab === 'entries' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Filter level:</label>
            <select value={level} onChange={(e) => setLevel(e.target.value as BillingLevel | '')}
              style={{ padding: '6px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '13px' }}>
              <option value="">All levels</option>
              {(Object.keys(BillingLevel) as BillingLevel[]).map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          {/* "Billed for" replaces a column set that showed no client, project or
              branch at all — the first thing anyone needs to identify a money line. */}
          {selectedEntryIds.size > 0 && (
            <div style={{
              display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: '8px',
              background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.3)',
            }}>
              <strong style={{ fontSize: '13px' }}>{selectedEntryIds.size} selected</strong>
              {bulkTargets.length > 0 ? (
                <>
                  <select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value as BillingState | '')}
                    style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}>
                    <option value="">Move all to…</option>
                    {bulkTargets.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                  <button onClick={runBulkTransition} disabled={!bulkTarget || bulkBusy} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }}>
                    {bulkBusy ? 'Applying…' : 'Apply'}
                  </button>
                </>
              ) : (
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No state is reachable from the selected entries.</span>
              )}
              <button onClick={() => setSelectedEntryIds(new Set())} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px', marginLeft: 'auto' }}>Clear</button>
            </div>
          )}
          {bulkReport && (
            <div style={{ padding: '12px 14px', borderRadius: '8px', fontSize: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: 600, marginBottom: '8px' }}>
                <span style={{ color: 'var(--status-active-text)' }}>{bulkReport.succeeded} moved</span>
                <span style={{ color: 'var(--text-muted)' }}>{bulkReport.skipped} skipped</span>
                {bulkReport.failed.length > 0 && <span style={{ color: 'var(--status-danger-text)' }}>{bulkReport.failed.length} failed</span>}
                <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
              </div>
              {bulkReport.failed.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  {bulkReport.failed.map((f) => (
                    <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                      <span>{f.id.slice(0, 8)}</span><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {f.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <Table
            columns={['Number', 'Billed For', 'Level', 'State', 'Net', 'GST', 'TDS', 'Total', 'Outstanding']}
            rowIds={entries.data?.map((e) => e.id)}
            onRowClick={(id) => setOpenEntryId(id)}
            selectable
            selected={selectedEntryIds}
            onToggleSelect={toggleEntrySelect}
            onSelectAll={(checked) => setSelectedEntryIds(checked ? new Set(entries.data?.map((e) => e.id)) : new Set())}
            rows={entries.data?.map((e) => [
              <span key={e.id}><strong>{e.entryNumber}</strong><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{pricingModel[e.pricingModel]}</div></span>,
              <span key={e.id} style={{ fontSize: '12px' }}>
                <div style={{ fontWeight: 600 }}>{e.clientName ?? '—'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {[e.projectName, e.branchName].filter(Boolean).join(' · ') || e.description || '—'}
                </div>
                {e.assayerName && <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>Assayer: {e.assayerName}</div>}
              </span>,
              <Badge key={e.id} color={levelColor[e.level]}>{e.level}</Badge>,
              <span key={e.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                <Badge color={STATE_BADGE[e.state]}>{e.state}</Badge>
                <Badge color={PAY_STATE_BADGE[e.paymentState]}>{e.paymentState}</Badge>
              </span>,
              <span key={e.id}>{money(e.taxableAmount ?? e.baseAmount)}</span>,
              <span key={e.id} style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{money(e.taxAmount)}</span>,
              <span key={e.id} style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>−{money(e.tdsAmount)}</span>,
              <span key={e.id} style={{ fontWeight: 600 }}>{money(e.totalAmount)}</span>,
              <span key={e.id} style={{ color: 'var(--warning)' }}>{money(e.outstandingAmount)}</span>,
            ])}
            empty={entries.data && entries.data.length === 0}
            loading={entries.isLoading}
          />
        </div>
      )}

      {tab === 'invoices' && (
        <Table
          columns={['Invoice #', 'Status', 'Type', 'Subtotal', 'GST', 'TDS', 'Total', 'Paid', 'Outstanding']}
          rowIds={invoices.data?.map((i) => i.id)}
          onRowClick={(id) => setOpenInvoiceId(id)}
          rows={invoices.data?.map((inv: BillingInvoice) => [
            <strong key={inv.id}>{inv.invoiceNumber}</strong>,
            <Badge key={inv.id} color={INV_BADGE[inv.status]}>{inv.status}</Badge>,
            <span key={inv.id} style={{ fontSize: '12px' }}>{inv.type}</span>,
            <span key={inv.id}>{money(inv.subtotal)}</span>,
            <span key={inv.id}>{money(inv.taxAmount)}</span>,
            <span key={inv.id} style={{ color: 'var(--text-muted)' }}>−{money(inv.tdsAmount)}</span>,
            <span key={inv.id} style={{ fontWeight: 600 }}>{money(inv.total)}</span>,
            <span key={inv.id} style={{ color: 'var(--success)' }}>{money(inv.paidAmount)}</span>,
            <span key={inv.id} style={{ color: 'var(--warning)' }}>{money(inv.outstandingAmount)}</span>,
          ])}
          empty={invoices.data && invoices.data.length === 0}
          loading={invoices.isLoading}
        />
      )}

      {/* The Assayer column used to render a raw UUID, and the work it was for
          another. Both are now resolved names. */}
      {tab === 'payables' && (
        <Table
          columns={['Assayer', 'For', 'Status', 'Fee', 'Travel', 'TDS', 'Net Payable', 'Paid']}
          rowIds={payables.data?.map((p) => p.id)}
          onRowClick={(id) => setOpenPayableId(id)}
          rows={payables.data?.map((p) => [
            <span key={p.id}>
              <strong>{p.assayerName ?? 'Unknown assayer'}</strong>
              {p.assayerCode && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{p.assayerCode}</div>}
              {p.assayerId && (
                <Link to={`/billing/statement?assayer=${p.assayerId}`} onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: '11px', color: 'var(--accent)', textDecoration: 'none' }}>Statement →</Link>
              )}
            </span>,
            <span key={p.id} style={{ fontSize: '12px' }}>
              <div>{p.assignmentNumber ?? '—'}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{p.projectName ?? ''}</div>
            </span>,
            <Badge key={p.id} color={PAYABLE_BADGE[p.status]}>{p.status}</Badge>,
            <span key={p.id}>{money(p.baseAmount)}</span>,
            <span key={p.id}>{money(p.travelAmount)}</span>,
            <span key={p.id} style={{ color: 'var(--text-secondary)' }}>−{money(p.tdsAmount)}</span>,
            <span key={p.id} style={{ fontWeight: 600 }}>{money(p.totalAmount)}</span>,
            <span key={p.id} style={{ color: 'var(--success)' }}>{money(p.paidAmount)}</span>,
          ])}
          empty={payables.data && payables.data.length === 0}
          loading={payables.isLoading}
        />
      )}

      {tab === 'conflicts' && (
        <Table
          columns={['Conflict #', 'Severity', 'Status', 'Entity', 'Description', 'Resolved']}
          rowIds={conflicts.data?.map((c) => c.id)}
          onRowClick={(id) => setOpenConflictId(id)}
          rows={conflicts.data?.map((c: BillingConflict) => [
            <strong key={c.id}>{c.conflictNumber}</strong>,
            <Badge key={c.id} color={CONFLICT_BADGE[c.severity]}>{c.severity}</Badge>,
            <Badge key={c.id} color={CONFLICT_STATUS_BADGE[c.status]}>{c.status}</Badge>,
            <span key={c.id} style={{ fontSize: '12px' }}>{c.entityType}</span>,
            <span key={c.id} style={{ fontSize: '12px' }}>{c.description}</span>,
            <span key={c.id} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{c.resolvedAt ? new Date(c.resolvedAt).toLocaleDateString() : '—'}</span>,
          ])}
          empty={conflicts.data && conflicts.data.length === 0}
          loading={conflicts.isLoading}
        />
      )}

      {tab === 'history' && (
        <Table
          columns={['Entity', 'Action', 'From', 'To', 'User', 'When', 'Reason']}
          rows={history.data?.map((h) => [
            <span key={h.id}><strong>{h.entityType}</strong><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{h.entityId}</div></span>,
            <span key={h.id} style={{ fontSize: '12px' }}>{h.action}</span>,
            <span key={h.id} style={{ fontSize: '12px' }}>{h.fromState ?? '—'}</span>,
            <span key={h.id} style={{ fontSize: '12px' }}>{h.toState ?? '—'}</span>,
            <span key={h.id} style={{ fontSize: '12px' }}>{h.userName ?? h.userId ?? '—'}</span>,
            <span key={h.id} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{new Date(h.occurredAt).toLocaleString()}</span>,
            <span key={h.id} style={{ fontSize: '12px' }}>{h.reason ?? '—'}</span>,
          ])}
          empty={history.data && history.data.length === 0}
          loading={history.isLoading}
        />
      )}
    </div>
  );
};

const Table: React.FC<{
  columns: string[];
  rows?: React.ReactNode[][];
  rowIds?: string[];
  onRowClick?: (id: string) => void;
  empty?: boolean;
  loading?: boolean;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onSelectAll?: (checked: boolean) => void;
}> = ({ columns, rows, rowIds, onRowClick, empty, loading, selectable, selected, onToggleSelect, onSelectAll }) => (
  <Card>
    {loading && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
    {!loading && empty && (
      <div style={{ padding: '28px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
        <FileText size={26} style={{ opacity: 0.4, marginBottom: 2 }} />
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>No records found</div>
        <div style={{ fontSize: 12 }}>Entries and invoices will appear here as they are recorded.</div>
      </div>
    )}
    {!loading && !empty && (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: '34px', padding: '8px 10px' }}>
                <input
                  type="checkbox"
                  checked={selected ? selected.size > 0 && selected.size === (rows ?? []).length : false}
                  onChange={(e) => onSelectAll?.(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
              </th>
            )}
            {columns.map((c) => (
              <th key={c} style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r, i) => (
            <tr
              key={i}
              onClick={onRowClick && rowIds ? () => onRowClick(rowIds[i]) : undefined}
              style={{
                borderBottom: '1px solid var(--border-color)',
                cursor: onRowClick ? 'pointer' : 'default',
                background: selectable && selected?.has(rowIds?.[i] ?? '') ? 'var(--status-pending-bg)' : undefined,
                transition: 'background var(--transition-fast)',
              }}
              onMouseEnter={(e) => { if (onRowClick) e.currentTarget.style.background = selectable && selected?.has(rowIds?.[i] ?? '') ? 'var(--status-pending-bg)' : 'var(--bg-tertiary)'; }}
              onMouseLeave={(e) => { if (onRowClick) e.currentTarget.style.background = selectable && selected?.has(rowIds?.[i] ?? '') ? 'var(--status-pending-bg)' : 'transparent'; }}
            >
              {selectable && rowIds && (
                <td style={{ padding: '10px', verticalAlign: 'middle' }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected?.has(rowIds[i]) ?? false} onChange={() => onToggleSelect?.(rowIds[i])} style={{ cursor: 'pointer' }} />
                </td>
              )}
              {r.map((cell, j) => (
                <td key={j} style={{ padding: '10px', verticalAlign: 'middle' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Card>
);
