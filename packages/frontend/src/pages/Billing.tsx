import React, { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, AlertTriangle, Banknote, FileText, RefreshCw, FileSpreadsheet } from 'lucide-react';
import {
  useBillingEntries,
  useBillingInvoices,
  useBillingPayables,
  useBillingConflicts,
  useBillingHistory,
  useSyncFromAssignments,
  useBillingClients,
} from '../hooks/useBilling';
import { billingApi, BILLING_PAGE_SIZE } from '../services/billing';
import type { BillingList } from '../services/billing';
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
import { Select, useToast } from '../components/ui';
import { userMessage } from '../services/errors';
import { useExcelExport } from '../hooks/useExcelExport';
import { formatRupees as money } from '@fapoms/shared';
import { SystemRole } from '@fapoms/shared';
import { ExpenseReview } from './ExpenseReview';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';


type Tab = 'finance' | 'hierarchy' | 'entries' | 'invoices' | 'payables' | 'conflicts' | 'history' | 'expenses';

/** The tables that take a page window, and so need a cursor of their own. */
type PagedTab = 'entries' | 'invoices' | 'payables' | 'history';

/**
 * Conflicts cannot be paged from here (the shared query key does not carry the params object), so
 * the request is capped rather than windowed. Set well above the 50-row page size because there is
 * no "next" to reach the remainder from — the cap exists to bound a whole-table GET, not to fill a
 * screen — and the table declares the shortfall whenever it bites.
 */
const CONFLICT_LIST_CAP = 200;

// Every hex literal below used to be a fixed color, locked to the default theme
// regardless of which of the app's 19 themes was active. Each is now the semantic
// token that already carried the same meaning elsewhere in the app — gold/"in
// draft or awaiting a decision" -> --accent, orange/"in progress" -> --warning,
// red/"blocked or reversed" -> --danger, green/"cleared" -> --success,
// gray/"parked, nothing pending" -> --text-muted — so these pills now repaint
// correctly under every theme instead of only the one they were written against.
const STATE_BADGE: Record<BillingState, string> = {
  NOT_BILLABLE: 'var(--text-muted)',
  PENDING_BILLING: 'var(--text-secondary)',
  READY_FOR_BILLING: 'var(--accent)',
  DRAFT: 'var(--accent)',
  SUBMITTED: 'var(--warning)',
  UNDER_REVIEW: 'var(--accent)',
  REJECTED: 'var(--danger)',
  APPROVED: 'var(--success)',
  INVOICED: 'var(--success)',
  PARTIALLY_PAID: 'var(--warning)',
  PAID: 'var(--success)',
  ON_HOLD: 'var(--text-muted)',
  DISPUTED: 'var(--danger)',
  CANCELLED: 'var(--text-muted)',
  ADJUSTED: 'var(--danger)',
};

const PAY_STATE_BADGE: Record<PaymentState, string> = {
  UNPAID: 'var(--text-secondary)',
  PARTIALLY_PAID: 'var(--warning)',
  PAID: 'var(--success)',
  REVERSED: 'var(--danger)',
};

const INV_BADGE: Record<InvoiceStatus, string> = {
  DRAFT: 'var(--accent)',
  ISSUED: 'var(--accent)',
  PARTIALLY_PAID: 'var(--warning)',
  PAID: 'var(--success)',
  DISPUTED: 'var(--danger)',
  CANCELLED: 'var(--text-muted)',
  VOID: 'var(--text-muted)',
};

const PAYABLE_BADGE: Record<AssayerPayableStatus, string> = {
  PENDING: 'var(--warning)',
  APPROVED: 'var(--accent)',
  PAID: 'var(--success)',
  DISPUTED: 'var(--danger)',
  ON_HOLD: 'var(--text-muted)',
};

const CONFLICT_BADGE: Record<BillingConflictSeverity, string> = {
  INFO: 'var(--accent)',
  WARNING: 'var(--warning)',
  CRITICAL: 'var(--danger)',
};

const CONFLICT_STATUS_BADGE: Record<BillingConflictStatus, string> = {
  OPEN: 'var(--warning)',
  RESOLVED: 'var(--success)',
  MERGED: 'var(--success)',
  SEPARATED: 'var(--accent)',
  REASSIGNED: 'var(--accent)',
  OVERRIDDEN: 'var(--accent)',
  REJECTED: 'var(--danger)',
  ON_HOLD: 'var(--text-muted)',
};

const Badge: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span style={{
    display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    // `color` is a CSS var() reference now, not a hex literal — string-concatenating an
    // alpha suffix onto it (the old `${color}22`) would no longer parse as a color.
    background: `color-mix(in srgb, ${color} 13%, transparent)`, color, fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
  }}>{children}</span>
);

const Card: React.FC<{ title?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, children, style }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '18px', ...style }}>
    {title && <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' }}>{title}</h3>}
    {children}
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
  // Each concern is a real URL (?tab=entries), so a finance page is linkable, bookmarkable, and
  // survives back/forward — the receivables view and an invoice's entries can point at each
  // other. Kept as query-param tabs rather than separate route components because the modals,
  // drawers and client scope are shared across all of them; splitting the money screen's state
  // apart carries more risk than the addressability is worth.
  const [params, setParams] = useSearchParams();
  const roles = useCurrentRoles();
  // Reimbursement approval is narrower than viewing billing (RO auditors can see billing but
  // cannot act on a claim), so the Assayer Expenses tab only shows for the roles the backend
  // lets act on /expenses/:id/review.
  const canReviewExpenses = hasAnyRole(roles, [
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.FINANCE_MANAGER,
  ]);
  const VALID_TABS: Tab[] = ['finance', 'hierarchy', 'entries', 'invoices', 'payables', 'conflicts', 'history', 'expenses'];
  const tab = (VALID_TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'finance') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'finance') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: false });
  };
  // Client scope also lives in the URL, so it holds when following a Ledger/Statement link out
  // and coming back, and matches how those pages read ?client=.
  const clientId = params.get('client') ?? '';
  const setClientId = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('client', id); else next.delete('client');
    setParams(next, { replace: true });
  };
  const [level, setLevel] = useState<BillingLevel | ''>('');
  // Every backend billing filter has always accepted a clientId; the page just
  // never offered a way to set one, so all figures were whole-book totals.

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

  /**
   * One page cursor per table, in component state rather than the URL: the client scope and the
   * tab are worth linking to and bookmarking, "page 4 of the payables table" is not, and hanging
   * four more params off every link out of this screen buys nothing.
   */
  const [pages, setPages] = useState<Record<PagedTab, number>>({ entries: 1, invoices: 1, payables: 1, history: 1 });
  const setPage = (list: PagedTab, next: number) => {
    // The bulk bar acts on the ids in `selectedEntryIds`, not on what is visible, so a selection
    // carried across a page change would move the state of rows the operator can no longer see —
    // "3 selected" meaning three rows two pages back. Selection is per page.
    if (list === 'entries') setSelectedEntryIds(new Set());
    setPages((p) => ({ ...p, [list]: next }));
  };
  // Changing the client scope or the level filter produces a different result set; holding page 4
  // of the old one lands on an empty table, which reads as "this client has no billing" rather
  // than "there is no page 4 here". Runs on back/forward too, since ?client= is URL state.
  useEffect(() => {
    setPages({ entries: 1, invoices: 1, payables: 1, history: 1 });
    setSelectedEntryIds(new Set());
  }, [clientId, level]);

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
  const { download: downloadExcel } = useExcelExport();
  const handleExportBilling = () => {
    void downloadExcel('/reports/billing', { clientId: clientId || undefined });
  };
  /**
   * Only the tab on screen fetches.
   *
   * All eight queries used to mount unconditionally, five of them unpaginated whole-table GETs.
   * Every billing socket event invalidates `queryKeys.billing.all`, so one entry moving state
   * refetched the entire book — entries, invoices, payables, conflicts and history — for an
   * operator looking at a single table. Gating on the active tab is what stops that, both at
   * mount and on every event afterwards: React Query treats a disabled query as inactive and
   * leaves it alone. Landing on Finance now costs the client list plus the finance summary
   * instead of eight requests, and each tab thereafter costs exactly one, cached for 30s.
   *
   * One of these stays ungated on purpose: `clients` feeds the client <select> above the tab
   * strip, which is always on screen. The old `dashboard` query (Overview-only) is gone —
   * its two unique figures (by-client-tier, invoices issued) now live inside
   * <FinanceDashboard/>, which fetches them itself.
   */
  const clients = useBillingClients();
  // The entries query also backs the bulk-selection bar (`selectedEntries` -> reachable states,
  // merge eligibility), but every one of those is rendered inside the Entries tab and there is no
  // way to select a row from anywhere else, so tab-gating it costs no behaviour.
  const entries = useBillingEntries(
    { ...scope, ...(level ? { level } : {}), page: pages.entries, limit: BILLING_PAGE_SIZE },
    { enabled: tab === 'entries' },
  );
  const invoices = useBillingInvoices({ ...scope, page: pages.invoices, limit: BILLING_PAGE_SIZE }, { enabled: tab === 'invoices' });
  const payables = useBillingPayables({ ...scope, page: pages.payables, limit: BILLING_PAGE_SIZE }, { enabled: tab === 'payables' });
  // Conflicts is the one list without a pager — see the note on `useBillingConflicts`. It is
  // capped instead, and the table says so whenever the cap actually hides anything. A larger cap
  // than the paged tables because there is no second page to reach the remainder from.
  const conflicts = useBillingConflicts(undefined, { enabled: tab === 'conflicts', limit: CONFLICT_LIST_CAP });
  const history = useBillingHistory({ ...scope, page: pages.history, limit: BILLING_PAGE_SIZE }, { enabled: tab === 'history' });

  const levelColor: Record<BillingLevel, string> = {
    CLIENT: 'var(--accent)',
    PROJECT: 'var(--accent)',
    ASSIGNMENT: 'var(--warning)',
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

  /**
   * Consolidate the selected entries into one. The backend refuses a cross-client merge or one
   * that touches an invoiced/part-paid line, so the button is only offered when the selection
   * already satisfies both — a disabled button with a silent 400 is worse than no button.
   */
  const canMergeSelected = (() => {
    if (selectedEntries.length < 2) return false;
    const oneClient = new Set(selectedEntries.map((e) => e.clientId)).size === 1;
    const noneLocked = selectedEntries.every((e) => e.state !== BillingState.INVOICED
      && e.state !== BillingState.PAID && e.state !== BillingState.PARTIALLY_PAID);
    return oneClient && noneLocked;
  })();

  const runMerge = async () => {
    if (!canMergeSelected || bulkBusy) return;
    setBulkBusy(true); setBulkReport(null);
    try {
      const merged = await billingApi.mergeEntries([...selectedEntryIds]);
      toast('success', `Merged ${selectedEntryIds.size} entries into ${merged.entryNumber ?? 'one line'}.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Merge failed', message: userMessage(err) });
    } finally {
      setBulkBusy(false);
      setSelectedEntryIds(new Set());
      entries.refetch();
    }
  };

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
          <button onClick={handleExportBilling} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700, color: 'var(--success)' }}><FileSpreadsheet size={15} /> Export</button>
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
        <Select
          value={clientId}
          onChange={setClientId}
          options={[
            { value: '', label: 'All clients' },
            ...(clients.data ?? []).map((c) => ({
              value: c.clientId,
              label: `${c.clientName}${Number(c.entryCount) > 0 ? ` (${c.entryCount} lines)` : ''}`,
            })),
          ]}
          compact
          style={{ minWidth: 240 }}
        />
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
        <TabButton active={tab === 'hierarchy'} onClick={() => setTab('hierarchy')}>Client → Projects → Assignments</TabButton>
        <TabButton active={tab === 'entries'} onClick={() => setTab('entries')}>Entries</TabButton>
        <TabButton active={tab === 'invoices'} onClick={() => setTab('invoices')}>Invoices</TabButton>
        <TabButton active={tab === 'payables'} onClick={() => setTab('payables')}>Assayer Payables</TabButton>
        <TabButton active={tab === 'conflicts'} onClick={() => setTab('conflicts')}>Conflicts</TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>History</TabButton>
        {canReviewExpenses && (
          <TabButton active={tab === 'expenses'} onClick={() => setTab('expenses')}>Assayer Expenses</TabButton>
        )}
        {/* New standalone pages surfacing capability the backend always had. */}
        <Link to={clientId ? `/billing/ledger?type=client&id=${clientId}` : '/billing/ledger'}
          style={{ padding: '7px 13px', fontSize: 13, fontWeight: 600, borderRadius: 8, textDecoration: 'none', color: 'var(--accent)', border: '1px solid var(--border-color)' }}>Ledger →</Link>
        <Link to={clientId ? `/billing/settings?client=${clientId}` : '/billing/settings'}
          style={{ padding: '7px 13px', fontSize: 13, fontWeight: 600, borderRadius: 8, textDecoration: 'none', color: 'var(--accent)', border: '1px solid var(--border-color)' }}>Rate cards →</Link>
      </div>

      {tab === 'finance' && <FinanceDashboard onNavigate={(t) => setTab(t as Tab)} clientId={clientId || undefined} />}
      {tab === 'expenses' && canReviewExpenses && <ExpenseReview />}

      {tab === 'hierarchy' && <ClientHierarchyPanel clientId={clientId || null} />}

      {tab === 'entries' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Filter level:</label>
            <Select
              value={level}
              onChange={(v) => setLevel(v as BillingLevel | '')}
              options={[
                { value: '', label: 'All levels' },
                ...(Object.keys(BillingLevel) as BillingLevel[]).map((l) => ({ value: l, label: l })),
              ]}
              compact
            />
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
                  <Select
                    value={bulkTarget}
                    onChange={(v) => setBulkTarget(v as BillingState | '')}
                    placeholder="Move all to…"
                    options={bulkTargets.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
                    compact
                  />
                  <button onClick={runBulkTransition} disabled={!bulkTarget || bulkBusy} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }}>
                    {bulkBusy ? 'Applying…' : 'Apply'}
                  </button>
                </>
              ) : (
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No state is reachable from the selected entries.</span>
              )}
              {canMergeSelected && (
                <button onClick={runMerge} disabled={bulkBusy} className="btn btn-secondary"
                  title="Consolidate the selected entries for this client into one billable line"
                  style={{ fontSize: '12px', padding: '6px 12px' }}>
                  Merge {selectedEntryIds.size} →
                </button>
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
          <Pager page={pages.entries} list={entries.data} onPage={(p) => setPage('entries', p)} />
        </div>
      )}

      {tab === 'invoices' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
          <Pager page={pages.invoices} list={invoices.data} onPage={(p) => setPage('invoices', p)} />
        </div>
      )}

      {/* The Assayer column used to render a raw UUID, and the work it was for
          another. Both are now resolved names. */}
      {tab === 'payables' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
          <Pager page={pages.payables} list={payables.data} onPage={(p) => setPage('payables', p)} />
        </div>
      )}

      {tab === 'conflicts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Never truncate a list of unresolved money disputes silently: an operator who reads
              "6 conflicts" off a capped table and clears them believes the book is clean. */}
          {conflicts.data && conflicts.data.total > conflicts.data.length && (
            <div style={{ padding: '10px 14px', borderRadius: '8px', fontSize: 12, background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.3)' }}>
              Showing the first {conflicts.data.length} of {conflicts.data.total} conflicts. Resolve these to see the rest.
            </div>
          )}
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
        </div>
      )}

      {tab === 'history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Table
            columns={['Entity', 'Action', 'From', 'To', 'User', 'When', 'Reason']}
            rows={history.data?.map((h) => [
              <span key={h.id}><strong>{h.entityType}</strong><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{h.entityId}</div></span>,
              <span key={h.id} style={{ fontSize: '12px' }}>{h.action}</span>,
              <span key={h.id} style={{ fontSize: '12px' }}>{h.fromState ?? '—'}</span>,
              <span key={h.id} style={{ fontSize: '12px' }}>{h.toState ?? '—'}</span>,
              <span key={h.id} style={{ fontSize: '12px' }}>{h.userName ?? h.userId ?? '—'}</span>,
              // Billing history rows carry `createdAt`, not `occurredAt` — the whole WHEN column
              // read "Invalid Date" while the correct timestamp sat unused in the response.
              <span key={h.id} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{new Date(h.createdAt).toLocaleString()}</span>,
              <span key={h.id} style={{ fontSize: '12px' }}>{h.reason ?? '—'}</span>,
            ])}
            empty={history.data && history.data.length === 0}
            loading={history.isLoading}
          />
          <Pager page={pages.history} list={history.data} onPage={(p) => setPage('history', p)} />
        </div>
      )}
    </div>
  );
};

/**
 * Page control for the billing tables.
 *
 * Renders nothing while there is a single short page, so a small book looks exactly as it did
 * before pagination existed. The count is read off the response instead of being derived here:
 * only the service layer knows whether the server reported a real total or we are counting what
 * arrived, and the "+" marks that second case rather than presenting a floor as the whole number.
 */
const Pager: React.FC<{
  page: number;
  list?: BillingList<unknown>;
  onPage: (page: number) => void;
}> = ({ page, list, onPage }) => {
  if (!list || (page === 1 && !list.hasMore)) return null;
  const from = (page - 1) * BILLING_PAGE_SIZE + 1;
  const to = from + list.length - 1;
  const btn: React.CSSProperties = { fontSize: '12px', padding: '5px 11px' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, fontSize: '12px', color: 'var(--text-muted)' }}>
      <span>
        {list.length > 0
          ? `Showing ${from}–${to} of ${list.total}${list.hasMore && list.total <= to ? '+' : ''}`
          : `Page ${page} is empty`}
      </span>
      <button onClick={() => onPage(page - 1)} disabled={page <= 1} className="btn btn-secondary" style={btn}>Previous</button>
      <button onClick={() => onPage(page + 1)} disabled={!list.hasMore} className="btn btn-secondary" style={btn}>Next</button>
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
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: 640 }}>
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
      </div>
    )}
  </Card>
);
