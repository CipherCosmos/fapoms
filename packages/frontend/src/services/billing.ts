import { api } from './api';
import type {
  BillingEntry,
  BillingInvoice,
  BillingPayment,
  AssayerPayable,
  BillingConflict,
  BillingHistoryEvent,
  BillingDashboardSummary,
  BillingLevel,
  BillingState,
  BillingPricingModel,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  AssayerPayableStatus,
  BillingConflictSeverity,
  BillingConflictStatus,
  BillingConflictAction,
  BillingEntityType,
} from '@fapoms/shared';

export interface CreateEntryPayload {
  level: BillingLevel;
  clientId: string;
  projectId?: string;
  assignmentId?: string;
  assayerId?: string;
  pricingModel?: BillingPricingModel;
  rate?: number;
  quantity?: number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  description?: string;
  baseAmount?: number;
  travelAmount?: number;
  adjustmentAmount?: number;
  discountAmount?: number;
  taxRate?: number;
  tdsRate?: number;
  currency?: string;
  initialState?: BillingState;
}

export interface CreateInvoicePayload {
  clientId: string;
  projectId?: string;
  type: InvoiceType;
  entryIds: string[];
  issueDate?: string;
  dueDate?: string;
  notes?: string;
}

export interface RecordPaymentPayload {
  invoiceId: string;
  paymentReference: string;
  method: PaymentMethod;
  amount: number;
  receivedDate?: string;
  allocatedToEntryIds?: string[];
  notes?: string;
}

export interface CreatePayablePayload {
  assayerId: string;
  clientId?: string;
  projectId?: string;
  assignmentId?: string;
  baseAmount: number;
  travelAmount?: number;
  taxRate?: number;
  tdsRate?: number;
  rateSnapshot?: Record<string, unknown>;
  remarks?: string;
}

export interface RaiseConflictPayload {
  severity: BillingConflictSeverity;
  entityType: BillingEntityType;
  entryIds: string[];
  description: string;
  reason?: string;
  blocksBilling?: boolean;
}

/** Receivables ageing buckets, keyed by days past the invoice due date. */
export interface BillingAging {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

export interface BillingAssignmentRollup {
  assignmentId: string;
  assignmentNumber: string | null;
  branchName: string | null;
  assayerId: string | null;
  assayerName: string | null;
  /** Net of GST — what we actually earn on the job. */
  revenue: number;
  /** Gross incl. GST, less TDS — what the client is asked to pay. */
  billedToClient: number;
  /** Assayer fee + travel. */
  cost: number;
  margin: number;
  marginPct: number | null;
  state: BillingState;
  payableStatus?: AssayerPayableStatus;
  entryIds: string[];
}

export interface BillingProjectRollup {
  projectId: string | null;
  projectName: string;
  projectNumber: string | null;
  billed: number;
  paid: number;
  outstanding: number;
  pending: number;
  entryCount: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  assignments: BillingAssignmentRollup[];
}

export interface ClientBillingReport {
  clientId: string;
  clientName: string | null;
  totals: {
    billed: number; paid: number; outstanding: number; pending: number;
    revenue: number; assayerCost: number; margin: number; marginPct: number | null;
    entryCount: number;
  };
  projects: BillingProjectRollup[];
  aging: BillingAging;
  invoices: {
    id: string;
    invoiceNumber: string;
    status: InvoiceStatus;
    subtotal: number;
    taxAmount: number;
    tdsAmount: number;
    total: number;
    paidAmount: number;
    outstandingAmount: number;
    issueDate?: string | null;
    dueDate?: string | null;
    daysOverdue: number | null;
  }[];
  recentHistory: {
    id: string;
    action: string;
    entityType: BillingEntityType;
    fromState?: string | null;
    toState?: string | null;
    reason?: string | null;
    userName?: string | null;
    /**
     * The API returns `createdAt` on billing history rows — there is no `occurredAt`.
     * The declared-but-absent field is why every timestamp in the billing audit trail
     * rendered as "Invalid Date": `new Date(undefined)`.
     */
    createdAt: string;
  }[];
}

/** Consolidated finance position: receivables, payables, cash-flow, tax. */
export interface FinanceDashboard {
  currency: string;
  receivable: {
    unbilled: number; invoiced: number; collected: number; outstanding: number;
    disputed: number; aging: BillingAging;
  };
  payable: {
    awaitingApproval: number; approvedUnpaid: number; paid: number;
    onHold: number; disputed: number; total: number;
  };
  cashflow: { in: number; out: number; net: number; inboundCount: number; outboundCount: number };
  profitability: { netRevenue: number; assayerCost: number; margin: number; marginPct: number | null };
  taxPosition: { gstCollected: number; tdsWithheldByClients: number; tdsWithheldFromAssayers: number };
  workingCapital: number;
  openConflicts: number;
  recentPayments: Array<{
    id: string; direction: 'INBOUND' | 'OUTBOUND'; reference: string;
    method: string; amount: number; date: string | null;
  }>;
}

/** An assayer's financial statement — earned, paid, still owed. */
export interface AssayerStatement {
  assayerId: string;
  assayerName: string | null;
  assayerCode: string | null;
  totals: {
    earned: number; paid: number; outstanding: number;
    awaitingApproval: number; onHoldOrDisputed: number; payableCount: number;
  };
  payables: Array<{
    id: string; payableNumber: string; status: AssayerPayableStatus;
    assignmentId: string | null; baseAmount: number; travelAmount: number;
    tdsAmount: number; totalAmount: number; paidAmount: number;
    outstanding: number; createdAt: string;
  }>;
  payments: Array<{
    id: string; paymentReference: string; method: PaymentMethod;
    amount: number; paidDate: string | null; balanceAfter: number | null; notes: string | null;
  }>;
}

/** Complete financial record for any entity in the system. */
export interface EntityLedger {
  entityType: 'client' | 'project' | 'branch' | 'assayer' | 'assignment';
  entityId: string;
  subject: { label: string | null; ref: string | null };
  totals: {
    revenue: number; billedToClient: number; collected: number; outstanding: number;
    unbilled: number; assayerCost: number; assayerPaid: number; assayerOwed: number;
    margin: number; marginPct: number | null; gst: number; tds: number;
    cashIn: number; cashOut: number; entryCount: number; payableCount: number;
  };
  monthly: Array<{ month: string; revenue: number; cost: number; margin: number }>;
  entries: Array<{
    id: string; entryNumber: string; level: BillingLevel; state: BillingState;
    description: string | null; taxableAmount: number; taxAmount: number; tdsAmount: number;
    totalAmount: number; paidAmount: number; outstandingAmount: number;
    invoiceId: string | null; createdAt: string;
  }>;
  payables: Array<{
    id: string; payableNumber: string; status: AssayerPayableStatus;
    baseAmount: number; travelAmount: number; tdsAmount: number; totalAmount: number;
    paidAmount: number; outstanding: number; createdAt: string;
  }>;
  payments: Array<{
    id: string; direction: 'INBOUND' | 'OUTBOUND'; reference: string;
    method: string; amount: number; date: string | null; notes: string | null;
  }>;
  history: Array<{
    id: string; action: string; entityType: BillingEntityType;
    fromState: string | null; toState: string | null; reason: string | null;
    // `createdAt` is the field the endpoint actually returns — see the note above.
    userName: string | null; createdAt: string;
  }>;
}

export interface DisbursePayload {
  paymentReference: string;
  method: PaymentMethod;
  /** Omit to settle the full outstanding balance. */
  amount?: number;
  paidDate?: string;
  notes?: string;
}

/** Client selector rows for scoping the billing workspace. */
export interface BillingClientSummary {
  clientId: string;
  clientName: string;
  paymentTerms: string | null;
  gstRate: string | null;
  tdsRate: string | null;
  entryCount: string;
  revenue: string;
  outstanding: string;
}

/** A billing entry with its client/project/assignment labels resolved. */
export type EnrichedBillingEntry = BillingEntry & {
  clientName: string | null;
  projectName: string | null;
  projectNumber: string | null;
  assignmentNumber: string | null;
  branchName: string | null;
  assayerName: string | null;
};

/** A payable with its assayer/project labels resolved. */
export type EnrichedAssayerPayable = AssayerPayable & {
  assayerName: string | null;
  assayerCode: string | null;
  projectName: string | null;
  assignmentNumber: string | null;
};

/**
 * A billing list, in the one shape every caller reads.
 *
 * It is an *array* carrying two extra properties rather than `{ items, total }` on purpose.
 * `PayableDetailDrawer`, `ConflictDetailDrawer`, `RaiseConflictModal` and `EntryDetailDrawer` all
 * call `.find()` / `.filter()` straight on the hook's `data`; handing them an object would turn
 * every one of those into `data.find is not a function` at runtime — a blank drawer over a
 * money record, not a compile error. Keeping the array keeps those files correct untouched,
 * while the page count rides along for whoever wants to draw a pager.
 *
 * One consequence worth knowing: a non-index property makes React Query's `isPlainArray` check
 * (`length === Object.keys(value).length`) fail, so these lists opt out of structural sharing and
 * get a fresh identity on each refetch. At a page size of 50 that is one extra table render;
 * the alternative is silent breakage in files this layer cannot see.
 */
export type BillingList<T> = T[] & {
  /**
   * Rows matching the filter across all pages. Always a floor — never larger than the truth —
   * because a server that windows without reporting a total leaves us only what we can count.
   */
  total: number;
  /** Whether a further page exists. Decided here, where the response shape is known. */
  hasMore: boolean;
};

/** The page window every billing list endpoint accepts. Omit both to ask for the whole table. */
export interface PageParams {
  page?: number;
  limit?: number;
}

/** One screenful of a dense money table. */
export const BILLING_PAGE_SIZE = 50;

/** The paginated envelope the billing endpoints are moving to. */
interface PagedResponse<T> { items: T[]; total: number }

function isPagedResponse<T>(raw: unknown): raw is PagedResponse<T> {
  return !!raw && !Array.isArray(raw) && Array.isArray((raw as PagedResponse<T>).items);
}

function asList<T>(items: T[], total: number, hasMore: boolean): BillingList<T> {
  return Object.assign(items, { total, hasMore });
}

/**
 * Normalise a list response whichever shape the server is on — the single place that knows both.
 *
 * These endpoints return a bare `T[]` today and are being changed to `{ items, total }`. Frontend
 * and backend ship independently, so for some window one will be ahead of the other; a client that
 * understands only one shape renders an empty table against the other (`[].map` over an object) and
 * the finance screen looks like the book is empty. Reading both means neither deploy order breaks.
 *
 * `api.request` has already unwrapped the `{ success, data }` envelope, so what arrives here is the
 * array or the object, nothing else.
 *
 * The client-side slice covers the third case: a server that ignores `page`/`limit` and sends the
 * whole table anyway. The bytes are already on the wire and nothing here can undo that, but the
 * operator still gets a page control that moves and a count that is right, instead of 300 rows
 * under a "Showing 1-50" label. Once the backend honours the window the branch simply stops firing.
 */
function normaliseList<T>(raw: T[] | PagedResponse<T> | null | undefined, params: PageParams = {}): BillingList<T> {
  const limit = params.limit ?? 0;
  const offset = limit > 0 ? ((params.page ?? 1) - 1) * limit : 0;

  if (isPagedResponse<T>(raw)) {
    // The server windowed and reported the size of the whole set — the only case where the count
    // and "is there a next page" are both exact.
    const total = Number(raw.total ?? raw.items.length);
    return asList(raw.items, total, offset + raw.items.length < total);
  }

  const rows = Array.isArray(raw) ? raw : [];
  if (limit > 0 && rows.length > limit) {
    // More rows than the window we asked for: this build ignores the params and sent everything.
    // Slicing here means the count is exact and the pager is real.
    const items = rows.slice(offset, offset + limit);
    return asList(items, rows.length, offset + items.length < rows.length);
  }
  // Either the whole table was requested (drawers and pickers do this), or the server honoured the
  // window without a total. In the latter case the count is only what we have seen so far, and a
  // page that comes back exactly full is the sole hint that more exists.
  return asList(rows, offset + rows.length, limit > 0 && rows.length === limit);
}

// Entries
async function listEntries(params: {
  clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string;
  level?: BillingLevel; state?: BillingState;
} & PageParams = {}): Promise<BillingList<EnrichedBillingEntry>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
  const raw = await api.request<EnrichedBillingEntry[] | PagedResponse<EnrichedBillingEntry>>(
    `/billing-engine/entries?${q.toString()}`,
  );
  return normaliseList(raw, params);
}
async function getEntry(id: string): Promise<BillingEntry> {
  return api.request<BillingEntry>(`/billing-engine/entries/${id}`);
}
async function createEntry(payload: CreateEntryPayload): Promise<BillingEntry> {
  return api.request<BillingEntry>('/billing-engine/entries', { method: 'POST', body: JSON.stringify(payload) });
}
async function transitionEntry(id: string, status: BillingState, reason?: string): Promise<BillingEntry> {
  return api.request<BillingEntry>(`/billing-engine/entries/${id}/state`, {
    method: 'PATCH', body: JSON.stringify({ status, reason }),
  });
}

export interface BulkTransitionResult {
  succeeded: { id: string; from: BillingState; to: BillingState }[];
  skipped: { id: string; current: BillingState; reason: string }[];
  failed: { id: string; reason: string }[];
}

async function bulkTransitionEntries(entryIds: string[], status: BillingState, reason?: string): Promise<BulkTransitionResult> {
  return api.request<BulkTransitionResult>('/billing-engine/entries/state', {
    method: 'PATCH', body: JSON.stringify({ entryIds, status, reason }),
  });
}
async function adjustEntry(id: string, delta: number, reason: string): Promise<BillingEntry> {
  return api.request<BillingEntry>(`/billing-engine/entries/${id}/adjust`, {
    method: 'PATCH', body: JSON.stringify({ delta, reason }),
  });
}
async function splitEntry(id: string, amounts: number[], notes?: string): Promise<BillingEntry[]> {
  return api.request<BillingEntry[]>(`/billing-engine/entries/${id}/split`, {
    method: 'POST', body: JSON.stringify({ amounts, notes }),
  });
}
async function mergeEntries(entryIds: string[], note?: string): Promise<BillingEntry> {
  return api.request<BillingEntry>('/billing-engine/entries/merge', {
    method: 'POST', body: JSON.stringify({ entryIds, note }),
  });
}

// Invoices
async function listInvoices(params: { clientId?: string; projectId?: string; status?: InvoiceStatus } & PageParams = {}): Promise<BillingList<BillingInvoice>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
  const raw = await api.request<BillingInvoice[] | PagedResponse<BillingInvoice>>(`/billing-engine/invoices?${q.toString()}`);
  return normaliseList(raw, params);
}
async function getInvoice(id: string): Promise<BillingInvoice> {
  return api.request<BillingInvoice>(`/billing-engine/invoices/${id}`);
}
async function createInvoice(payload: CreateInvoicePayload): Promise<BillingInvoice> {
  return api.request<BillingInvoice>('/billing-engine/invoices', { method: 'POST', body: JSON.stringify(payload) });
}
async function transitionInvoice(id: string, status: InvoiceStatus, reason?: string): Promise<BillingInvoice> {
  return api.request<BillingInvoice>(`/billing-engine/invoices/${id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status, reason }),
  });
}

// Payments
async function recordPayment(payload: RecordPaymentPayload): Promise<BillingPayment> {
  return api.request<BillingPayment>('/billing-engine/payments', { method: 'POST', body: JSON.stringify(payload) });
}

// Payables
async function listPayables(params: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus } & PageParams = {}): Promise<BillingList<EnrichedAssayerPayable>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
  const raw = await api.request<EnrichedAssayerPayable[] | PagedResponse<EnrichedAssayerPayable>>(`/billing-engine/payables?${q.toString()}`);
  return normaliseList(raw, params);
}
async function createPayable(payload: CreatePayablePayload): Promise<AssayerPayable> {
  return api.request<AssayerPayable>('/billing-engine/payables', { method: 'POST', body: JSON.stringify(payload) });
}
async function transitionPayable(id: string, status: AssayerPayableStatus, reason?: string): Promise<AssayerPayable> {
  return api.request<AssayerPayable>(`/billing-engine/payables/${id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status, reason }),
  });
}

// Conflicts
async function listConflicts(status?: BillingConflictStatus, params: PageParams = {}): Promise<BillingList<BillingConflict>> {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
  const raw = await api.request<BillingConflict[] | PagedResponse<BillingConflict>>(`/billing-engine/conflicts?${q.toString()}`);
  return normaliseList(raw, params);
}
async function raiseConflict(payload: RaiseConflictPayload): Promise<BillingConflict> {
  return api.request<BillingConflict>('/billing-engine/conflicts', { method: 'POST', body: JSON.stringify(payload) });
}
async function resolveConflict(id: string, status: BillingConflictStatus, action: BillingConflictAction, note: string): Promise<BillingConflict> {
  return api.request<BillingConflict>(`/billing-engine/conflicts/${id}/resolve`, {
    method: 'PATCH', body: JSON.stringify({ status, action, note }),
  });
}

// History
async function getHistory(params: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; entityType?: BillingEntityType } & PageParams = {}): Promise<BillingList<BillingHistoryEvent>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
  const raw = await api.request<BillingHistoryEvent[] | PagedResponse<BillingHistoryEvent>>(`/billing-engine/history?${q.toString()}`);
  return normaliseList(raw, params);
}

// Dashboard & reports
async function getDashboard(clientId?: string): Promise<BillingDashboardSummary> {
  return api.request<BillingDashboardSummary>(`/billing-engine/dashboard${clientId ? `?clientId=${clientId}` : ''}`);
}
async function getClientReport(clientId: string): Promise<ClientBillingReport> {
  return api.request<ClientBillingReport>(`/billing-engine/reports/client/${clientId}`);
}
async function syncFromAssignments(): Promise<{
  scanned: number;
  created: number;
  skipped: number;
  payablesCreated: number;
  errors: Array<{ assignmentId: string; reason: string }>;
}> {
  return api.request('/billing-engine/sync/assignments', { method: 'POST' });
}
async function listBillingClients(): Promise<BillingClientSummary[]> {
  return api.request<BillingClientSummary[]>('/billing-engine/clients');
}
async function getFinanceDashboard(): Promise<FinanceDashboard> {
  return api.request<FinanceDashboard>('/billing-engine/finance/dashboard');
}
async function disbursePayable(payableId: string, payload: DisbursePayload): Promise<BillingPayment> {
  return api.request<BillingPayment>(`/billing-engine/payables/${payableId}/disburse`, {
    method: 'POST', body: JSON.stringify(payload),
  });
}
async function getEntityLedger(
  entityType: EntityLedger['entityType'], entityId: string,
): Promise<EntityLedger> {
  return api.request<EntityLedger>(`/billing-engine/ledger/${entityType}/${entityId}`);
}
async function getAssayerStatement(assayerId: string): Promise<AssayerStatement> {
  return api.request<AssayerStatement>(`/billing-engine/assayers/${assayerId}/statement`);
}

export const billingApi = {
  listEntries,
  getEntry,
  createEntry,
  transitionEntry,
  bulkTransitionEntries,
  adjustEntry,
  splitEntry,
  mergeEntries,
  listInvoices,
  getInvoice,
  createInvoice,
  transitionInvoice,
  recordPayment,
  listPayables,
  createPayable,
  transitionPayable,
  listConflicts,
  raiseConflict,
  resolveConflict,
  getHistory,
  getDashboard,
  getClientReport,
  syncFromAssignments,
  listBillingClients,
  getFinanceDashboard,
  disbursePayable,
  getAssayerStatement,
  getEntityLedger,
};
