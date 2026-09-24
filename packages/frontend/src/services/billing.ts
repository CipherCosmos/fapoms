import { api } from './api';
import { AppError } from './errors';
import { waitForQueuedJob, type EnqueuedJob } from './queued-job';
import type {
  BillingEntry,
  BillingInvoice,
  BillingPayment,
  AssayerPayable,
  BillingOverview,
  AssignmentMoneyLine,
  BillingState,
  InvoiceStatus,
  PaymentMethod,
  AssayerPayableStatus,
  AssayerInvoiceStatus,
  AssayerInvoiceSummary,
  AssayerInvoiceInvitation,
  AssayerInvoiceInviteOutcome,
} from '@fapoms/shared';

/**
 * The billing API, as the web app sees it: the assignment is the ledger line.
 *
 * Reads are `overview`, `payouts`, `invoiceable`, `invoices`, the assayer statement, the
 * assignment's money line and the assayer-invoice list/detail; writes are approve/pay/hold
 * payouts, create/send/cancel invoices, record/reverse payments, adjust/hold a client line,
 * the assayer-invoice invite/approve/cancel, and the admin reconcile. Nothing here computes
 * money — every figure on screen is a figure the server sent.
 */

// ---- Shapes ---------------------------------------------------------------

/** One page of a billing list, and the size of the set it was cut from. */
export interface BillingPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PageParams {
  page?: number;
  limit?: number;
}

/** One screenful of a dense money table. */
export const BILLING_PAGE_SIZE = 20;

export type PayoutRow = AssayerPayable & {
  assayerName: string | null;
  assayerCode: string | null;
  clientName: string | null;
  projectName: string | null;
  assignmentNumber: string | null;
  branchName: string | null;
  /**
   * The assayer invoice this payout rides, if any — the id ONLY. The payout list is the payable
   * entity spread with labels, and the entity carries these two columns; the invoice's
   * number/status are NOT attached here (the backend attaches those on the statement's rows,
   * not the payouts page), so a screen that wants them resolves the id — see
   * `useAssayerInvoiceLookup`. `preInvoicingEra` marks rows revealed under the pre-invoicing
   * rules: settled history the invite must never bill twice.
   */
  assayerInvoiceId: string | null;
  preInvoicingEra: boolean;
};

export type InvoiceRow = BillingInvoice & { entryCount: number; clientName: string | null };

export interface InvoiceableLine {
  entryId: string;
  entryNumber: string;
  assignmentId: string;
  assignmentNumber: string | null;
  projectId: string | null;
  projectName: string | null;
  branchName: string | null;
  assayerId: string | null;
  assayerName: string | null;
  serviceDate: string | null;
  onHold: boolean;
  holdReason: string | null;
  baseAmount: number;
  travelAmount: number;
  adjustmentAmount: number;
  taxableAmount: number;
  taxAmount: number;
  tdsAmount: number;
  totalAmount: number;
}

export interface InvoiceableClient {
  clientId: string;
  clientName: string;
  /** Σ total of the lines that can be invoiced now (held lines excluded). */
  total: number;
  count: number;
  lines: InvoiceableLine[];
}

export interface AssayerStatement {
  assayerId: string;
  assayerName: string | null;
  assayerCode: string | null;
  /** Decrypted for finance; null when the assayer has no PAN on file. */
  pan: string | null;
  /** The Income-tax section the withholding is quoted under, from settings (e.g. 194J). */
  tdsSection: string;
  totals: {
    earned: number; paid: number; outstanding: number;
    awaitingApproval: number; onHoldOrDisputed: number; tdsWithheld: number; payableCount: number;
  };
  payables: Array<{
    id: string; payableNumber: string; status: AssayerPayableStatus; onHold: boolean; holdReason: string | null;
    assignmentId: string; expenseId: string | null; baseAmount: number; travelAmount: number;
    tdsAmount: number; totalAmount: number; paidAmount: number; outstanding: number; createdAt: string;
    /** The assayer invoice this row rides — labels the server attaches for the staff audience. */
    invoiceNumber: string | null; invoiceStatus: AssayerInvoiceStatus | null;
  }>;
  payments: Array<{
    id: string; paymentReference: string; method: PaymentMethod;
    amount: number; paidDate: string | null; balanceAfter: number | null; notes: string | null;
  }>;
}

export interface PayoutActionResult {
  done: string[];
  refused: Array<{ id: string; reason: string }>;
}

// ── Assayer invoices (the consent wrapper over payables) ───────────────────

/**
 * The bulk "invite everyone with unbilled work" round. Per-assayer outcomes, never a whole-batch
 * failure: `invited`/`skipped` are the server's own counts over `outcomes` ('failed' counts as
 * skipped there — the UI splits it back out, because an infrastructure error is not a business
 * outcome).
 */
export interface AssayerInvoiceInviteAllResult {
  outcomes: AssayerInvoiceInviteOutcome[];
  invited: number;
  skipped: number;
}

/**
 * The rollout gate, as the client sees it: while `billing.assayerInvoicingEnabled` is off, the
 * invite routes answer 404 "not enabled" as if they did not exist. That is a deployment state,
 * not a user error — callers show a quiet banner and disable the invite buttons rather than
 * toasting an error at whoever clicked first.
 */
export function isInvoicingNotEnabled(err: unknown): boolean {
  return err instanceof AppError && err.status === 404 && /not enabled/i.test(err.technical ?? err.userMessage);
}

// ── GST tax invoice document ───────────────────────────────────────────────

export interface InvoiceDocLine {
  srNo: number;
  assignmentNumber: string;
  branchName: string | null;
  serviceDate: string | null;
  description: string;
  hsnSac: string;
  taxableAmount: number;
  taxRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface InvoiceDocument {
  invoice: { number: string; status: InvoiceStatus; issueDate: string | null; dueDate: string | null; currency: string; notes: string | null; paymentTerms: string | null };
  seller: { legalName: string | null; address: string | null; gstin: string | null; stateName: string | null; stateCode: string | null; pan: string | null };
  client: { name: string | null; address: string | null; gstin: string | null; stateName: string | null; stateCode: string | null };
  placeOfSupply: { code: string; name: string | null } | null;
  taxMode: 'INTRA' | 'INTER';
  taxSplitAssumed: boolean;
  defaultSac: string;
  lines: InvoiceDocLine[];
  totals: { taxable: number; cgst: number; sgst: number; igst: number; tax: number; invoiceValue: number; tds: number; netReceivable: number };
  amountInWords: string;
}

// ── NEFT bank file ─────────────────────────────────────────────────────────

export interface BankFileRow {
  payableId: string;
  payableNumber: string;
  assignmentNumber: string | null;
  assayerName: string | null;
  assayerCode: string | null;
  beneficiaryName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  pan: string | null;
  netAmount: number;
  reference: string;
  hasBankDetails: boolean;
}

export interface BankFileResult {
  rows: BankFileRow[];
  skipped: Array<{ id: string; reason: string }>;
}

// ── TDS substantiation ─────────────────────────────────────────────────────

export interface TdsReportRow {
  assayerId: string;
  assayerName: string | null;
  assayerCode: string | null;
  /** Whole for a role entitled to it, otherwise the last four. `panMasked` says which. */
  pan: string | null;
  /** True when `pan` is a tail rather than the number, so the screen can say so. */
  panMasked: boolean;
  gross: number;
  tds: number;
  net: number;
  count: number;
}

export interface TdsReport {
  from: string | null;
  to: string | null;
  section: string;
  rows: TdsReportRow[];
  totals: { gross: number; tds: number; net: number; count: number };
}

export interface PayPayoutsResult {
  done: Array<{ payableId: string; paymentId: string }>;
  refused: Array<{ id: string; reason: string }>;
}

export interface PayPayoutsPayload {
  payableIds: string[];
  paymentReference: string;
  method: PaymentMethod;
  paidDate?: string;
  notes?: string;
}

export interface CreateInvoicePayload {
  clientId: string;
  assignmentIds: string[];
  issueDate?: string;
  dueDate?: string;
  notes?: string;
}

export interface InvoicePaymentPayload {
  invoiceId: string;
  paymentReference: string;
  method: PaymentMethod;
  amount: number;
  receivedDate?: string;
  notes?: string;
}

export interface ClientLinePatch {
  adjustmentAmount?: number;
  adjustmentReason?: string;
  onHold?: boolean;
  holdReason?: string;
}

export interface ReconcileJob {
  jobId: string;
  deduplicated: boolean;
  /** The Jobs-tray row tracking the run (so it is found again after a refresh); null when untracked. */
  backgroundJobId?: string | null;
}

export interface BillingJobStatus {
  jobId: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: { percent: number; stage: string };
  result?: { scanned: number; booked: number; skipped: number; errors: Array<{ assignmentId: string; reason: string }> };
  error?: string;
}

// ---- Calls ----------------------------------------------------------------

const qs = (params: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

async function getOverview(): Promise<BillingOverview> {
  return api.request<BillingOverview>('/billing-engine/overview');
}

async function listPayouts(params: {
  assayerId?: string; clientId?: string; status?: AssayerPayableStatus; onHold?: boolean;
  /** Riding an assayer bill, or on none. The pay screen's stages are built from this. */
  onBill?: boolean;
} & PageParams = {}): Promise<BillingPage<PayoutRow>> {
  return api.request<BillingPage<PayoutRow>>(`/billing-engine/payouts${qs(params)}`);
}

/**
 * How a screen follows a billing bulk run it started — approve, pay, or the invite-all round.
 *
 * Those three POSTs used to do the work inside the request, one transaction per row, and at
 * realistic sizes outlived this client's 30 s: the screen said "failed" while the server carried on
 * writing, and a second press started it again. They now answer at once with the run's id
 * (`EnqueuedJob`), and `followBulkJob` waits for the result — the same `done`/`refused` lists and
 * per-assayer outcomes the POST used to return. `onProgress` receives the server's stage label,
 * e.g. "Approving payouts (7/20)".
 */
/**
 * What approve, pay and invite-all answer: the run to poll (`jobId`, for `followBulkJob`) plus the
 * Jobs-tray row that tracks it, so a page reloaded mid-run can still find it (`useBackgroundJob`).
 */
export interface BillingBulkJobStarted extends EnqueuedJob {
  backgroundJobId?: string | null;
}

export interface BillingBulkJobWatch {
  onProgress?: (progress: { percent: number; stage: string }) => void;
  signal?: { cancelled: boolean };
  pollMs?: number;
}

/** Start approving: the approvals run on the server's queue. Wait on it with `followBulkJob`. */
/**
 * Start approving. `reason` is sent only when the desk approved WITHOUT the assayer having
 * confirmed a bill — it lands on the payout's history row and its audit remark, so the exception
 * can be told from the rule afterwards. Omitted on the normal path (approving a bill), where the
 * assayer's own confirmation is the record.
 */
async function approvePayouts(payableIds: string[], reason?: string): Promise<BillingBulkJobStarted> {
  return api.request<BillingBulkJobStarted>('/billing-engine/payouts/approve', { method: 'POST', body: JSON.stringify({ payableIds, reason }) });
}

/** Start paying: the disbursements run on the server's queue. Wait on it with `followBulkJob`. */
async function payPayouts(payload: PayPayoutsPayload): Promise<BillingBulkJobStarted> {
  return api.request<BillingBulkJobStarted>('/billing-engine/payouts/pay', { method: 'POST', body: JSON.stringify(payload) });
}

/**
 * Wait for a started approve / pay / invite-all run and resolve with its result. Rejects with the
 * run's own failure, `QueuedJobGone` when the run is no longer readable, or `QueuedJobTimeout`
 * when it is still going after the give-up time — which is not a failure: it carries on.
 */
async function followBulkJob<TResult>(started: EnqueuedJob, watch: BillingBulkJobWatch = {}): Promise<TResult> {
  return waitForQueuedJob<TResult>(`/billing-engine/bulk-jobs/${encodeURIComponent(started.jobId)}`, {
    onProgress: watch.onProgress,
    signal: watch.signal,
    pollMs: watch.pollMs,
  });
}

async function holdPayout(id: string, onHold: boolean, reason?: string): Promise<AssayerPayable> {
  return api.request<AssayerPayable>(`/billing-engine/payouts/${id}/hold`, { method: 'PATCH', body: JSON.stringify({ onHold, reason }) });
}

/**
 * The owner-decision undo of a wrong completion: voids the payable it booked and puts the
 * assignment back to ACCEPTED, in one call on `assignment.controller.ts` (not the payouts
 * route) — reopening only the payable without the assignment would leave someone paid for
 * work the record no longer shows as done.
 */
async function reopenAssignment(assignmentId: string, reason: string): Promise<unknown> {
  return api.request(`/assignments/${assignmentId}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
}

async function getAssayerStatement(assayerId: string): Promise<AssayerStatement> {
  return api.request<AssayerStatement>(`/billing-engine/assayers/${assayerId}/statement`);
}

/**
 * Invite ONE assayer to invoice all of their eligible unbilled payouts, as one invoice. 409 when
 * they already hold an active (invited/submitted) invoice; 404 while the rollout flag is off —
 * see `isInvoicingNotEnabled`.
 */
async function inviteAssayerInvoice(assayerId: string): Promise<AssayerInvoiceSummary> {
  return api.request<AssayerInvoiceSummary>('/billing-engine/assayer-invoices/invite', { method: 'POST', body: JSON.stringify({ assayerId }) });
}

/**
 * Start the bulk cadence round: one invoice per assayer with eligible work. It runs on the server's
 * queue — about 1,200 assayers — and `followBulkJob` resolves with the per-assayer outcomes
 * (`AssayerInvoiceInviteAllResult`). 404 while the rollout flag is off, before anything is queued.
 */
async function inviteAllAssayerInvoices(): Promise<BillingBulkJobStarted> {
  return api.request<BillingBulkJobStarted>('/billing-engine/assayer-invoices/invite-all', { method: 'POST' });
}

async function listAssayerInvoices(params: { status?: AssayerInvoiceStatus; assayerId?: string } & PageParams = {}): Promise<BillingPage<AssayerInvoiceSummary>> {
  return api.request<BillingPage<AssayerInvoiceSummary>>(`/billing-engine/assayer-invoices${qs(params)}`);
}

/** One assayer invoice with its lines and labels — the review drawer, and the chip resolver. */
async function getAssayerInvoice(id: string): Promise<AssayerInvoiceInvitation> {
  return api.request<AssayerInvoiceInvitation>(`/billing-engine/assayer-invoices/${id}`);
}

/**
 * Approve a SUBMITTED assayer invoice — the server approves every still-pending line payable in
 * the same transaction. Refusals (a held line, totals drift) come back as human sentences and
 * are shown verbatim.
 */
async function approveAssayerInvoice(id: string): Promise<AssayerInvoiceSummary> {
  return api.request<AssayerInvoiceSummary>(`/billing-engine/assayer-invoices/${id}/approve`, { method: 'POST' });
}

async function cancelAssayerInvoice(id: string, reason: string): Promise<AssayerInvoiceSummary> {
  return api.request<AssayerInvoiceSummary>(`/billing-engine/assayer-invoices/${id}/cancel`, { method: 'PATCH', body: JSON.stringify({ reason }) });
}

async function reviseAssayerInvoice(id: string, reason: string): Promise<AssayerInvoiceSummary> {
  return api.request<AssayerInvoiceSummary>(`/billing-engine/assayer-invoices/${id}/revise`, { method: 'POST', body: JSON.stringify({ reason }) });
}

async function listInvoiceable(clientId?: string): Promise<{ clients: InvoiceableClient[]; total: number; truncated: boolean }> {
  return api.request<{ clients: InvoiceableClient[]; total: number; truncated: boolean }>(`/billing-engine/invoiceable${qs({ clientId })}`);
}

async function listInvoices(params: { clientId?: string; projectId?: string; status?: InvoiceStatus } & PageParams = {}): Promise<BillingPage<InvoiceRow>> {
  return api.request<BillingPage<InvoiceRow>>(`/billing-engine/invoices${qs(params)}`);
}

async function getInvoice(id: string): Promise<BillingInvoice & { clientName: string | null }> {
  return api.request<BillingInvoice & { clientName: string | null }>(`/billing-engine/invoices/${id}`);
}

/** The GST tax invoice document behind an invoice — everything the printable view needs. */
async function getInvoiceDocument(id: string): Promise<InvoiceDocument> {
  return api.request<InvoiceDocument>(`/billing-engine/invoices/${id}/document`);
}

/** Bank details for the selected approved-unpaid payouts, for building the NEFT bank file. */
async function getPayoutBankFile(payableIds: string[]): Promise<BankFileResult> {
  return api.request<BankFileResult>('/billing-engine/payouts/bank-file', { method: 'POST', body: JSON.stringify({ payableIds }) });
}

/** PAN-wise TDS withheld from assayers over a period, for TDS substantiation. */
async function getTdsReport(params: { from?: string; to?: string } = {}): Promise<TdsReport> {
  return api.request<TdsReport>(`/billing-engine/tds-report${qs(params)}`);
}

async function createInvoice(payload: CreateInvoicePayload): Promise<BillingInvoice> {
  return api.request<BillingInvoice>('/billing-engine/invoices', { method: 'POST', body: JSON.stringify(payload) });
}

async function sendInvoice(id: string): Promise<BillingInvoice> {
  return api.request<BillingInvoice>(`/billing-engine/invoices/${id}/send`, { method: 'PATCH' });
}

async function recordInvoicePayment({ invoiceId, ...payload }: InvoicePaymentPayload): Promise<BillingPayment> {
  return api.request<BillingPayment>(`/billing-engine/invoices/${invoiceId}/payment`, { method: 'POST', body: JSON.stringify(payload) });
}

async function cancelInvoice(id: string, reason: string): Promise<BillingInvoice> {
  return api.request<BillingInvoice>(`/billing-engine/invoices/${id}/cancel`, { method: 'PATCH', body: JSON.stringify({ reason }) });
}

async function reversePayment(paymentId: string, reason: string): Promise<BillingPayment> {
  return api.request<BillingPayment>(`/billing-engine/payments/${paymentId}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) });
}

async function getAssignmentMoney(assignmentId: string): Promise<AssignmentMoneyLine> {
  return api.request<AssignmentMoneyLine>(`/billing-engine/assignments/${assignmentId}/money`);
}

async function editClientLine(assignmentId: string, patch: ClientLinePatch): Promise<BillingEntry> {
  return api.request<BillingEntry>(`/billing-engine/assignments/${assignmentId}/client-line`, { method: 'PATCH', body: JSON.stringify(patch) });
}

async function listClientLines(params: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; state?: BillingState } = {}): Promise<BillingEntry[]> {
  return api.request<BillingEntry[]>(`/billing-engine/lines${qs(params)}`);
}

async function reconcilePreview(since?: string): Promise<{ count: number; since: string | null }> {
  return api.request<{ count: number; since: string | null }>(`/billing-engine/reconcile/preview${qs({ since })}`);
}

async function reconcile(since?: string): Promise<ReconcileJob> {
  return api.request<ReconcileJob>('/billing-engine/reconcile', { method: 'POST', body: JSON.stringify({ since }) });
}

async function jobStatus(jobId: string): Promise<BillingJobStatus> {
  return api.request<BillingJobStatus>(`/billing-engine/jobs/${jobId}`);
}

export const billingApi = {
  getOverview,
  listPayouts,
  approvePayouts,
  payPayouts,
  followBulkJob,
  holdPayout,
  reopenAssignment,
  getAssayerStatement,
  inviteAssayerInvoice,
  inviteAllAssayerInvoices,
  listAssayerInvoices,
  getAssayerInvoice,
  approveAssayerInvoice,
  cancelAssayerInvoice,
  reviseAssayerInvoice,
  listInvoiceable,
  listInvoices,
  getInvoice,
  getInvoiceDocument,
  getPayoutBankFile,
  getTdsReport,
  createInvoice,
  sendInvoice,
  recordInvoicePayment,
  cancelInvoice,
  reversePayment,
  getAssignmentMoney,
  editClientLine,
  listClientLines,
  reconcilePreview,
  reconcile,
  jobStatus,
};
