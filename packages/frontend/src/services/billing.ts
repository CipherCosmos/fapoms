import { api } from './api';
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
} from '@fapoms/shared';

/**
 * The billing API, as the web app sees it: the assignment is the ledger line.
 *
 * Eighteen calls. Reads are `overview`, `payouts`, `invoiceable`, `invoices`, the assayer
 * statement and the assignment's money line; writes are approve/pay/hold payouts, create/send/
 * cancel invoices, record/reverse payments, adjust/hold a client line, and the admin reconcile.
 * Nothing here computes money — every figure on screen is a figure the server sent.
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
export const BILLING_PAGE_SIZE = 50;

export type PayoutRow = AssayerPayable & {
  assayerName: string | null;
  assayerCode: string | null;
  clientName: string | null;
  projectName: string | null;
  assignmentNumber: string | null;
  branchName: string | null;
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
  pan: string | null;
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
} & PageParams = {}): Promise<BillingPage<PayoutRow>> {
  return api.request<BillingPage<PayoutRow>>(`/billing-engine/payouts${qs(params)}`);
}

async function approvePayouts(payableIds: string[]): Promise<PayoutActionResult> {
  return api.request<PayoutActionResult>('/billing-engine/payouts/approve', { method: 'POST', body: JSON.stringify({ payableIds }) });
}

async function payPayouts(payload: PayPayoutsPayload): Promise<PayPayoutsResult> {
  return api.request<PayPayoutsResult>('/billing-engine/payouts/pay', { method: 'POST', body: JSON.stringify(payload) });
}

async function holdPayout(id: string, onHold: boolean, reason?: string): Promise<AssayerPayable> {
  return api.request<AssayerPayable>(`/billing-engine/payouts/${id}/hold`, { method: 'PATCH', body: JSON.stringify({ onHold, reason }) });
}

async function getAssayerStatement(assayerId: string): Promise<AssayerStatement> {
  return api.request<AssayerStatement>(`/billing-engine/assayers/${assayerId}/statement`);
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
  holdPayout,
  getAssayerStatement,
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
