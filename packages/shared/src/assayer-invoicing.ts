import { AssayerInvoiceStatus } from './enums';

/**
 * Assayer invoicing — the API shapes for the consent-and-visibility wrapper over payables.
 *
 * The invoice never carries money of its own: every figure on it is a SUM of amounts already
 * stored on `assayer_payables` rows (which were themselves snapshotted at booking by
 * `assignmentMoney`). These types exist so the ops web app, the mobile app and the backend
 * agree on the payloads without any of them re-deriving a rupee.
 */

/**
 * The bill states in which the ASSAYER HAS SENT the bill — owner decision 2026-09-24: amounts
 * appear in the assayer's Money as soon as they send the bill, not only once the desk approves it.
 *
 * INVITED is the desk's invitation the assayer has not sent yet (its amounts are shown only inside
 * the invitation they are reviewing); SUBMITTED is the moment of sending; APPROVED and PAID follow
 * it. CANCELLED and SUPERSEDED carry no lines — cancelling releases them and a revision moves them
 * to the new revision (which starts INVITED again) — so a payable never rides one.
 *
 * The earnings statement's gate (`BillingEngineService.assayerRevealingInvoiceIds`) reveals a bill
 * in one of these states, and ALSO a revision (INVITED again) of a bill the assayer had already
 * submitted — owner decision 2026-09-24 — for the rows and for the totals alike.
 */
export const ASSAYER_SENT_INVOICE_STATUSES: readonly AssayerInvoiceStatus[] = [
  AssayerInvoiceStatus.SUBMITTED,
  AssayerInvoiceStatus.APPROVED,
  // The HOD's final approval (2026-09-24) sits between the office's approval and payment.
  AssayerInvoiceStatus.HOD_APPROVED,
  AssayerInvoiceStatus.PAID,
];

/** One invoice line — a payable, labelled for a human reviewer. */
export interface AssayerInvoiceLine {
  payableId: string;
  payableNumber: string;
  /** FEE = the assignment's fee payable; EXPENSE = an approved expense-claim reimbursement. */
  kind: 'FEE' | 'EXPENSE';
  payableStatus: string;
  onHold: boolean;
  assignmentId: string | null;
  assignmentNumber: string | null;
  branchName: string | null;
  /** Bank or corporate client name that commissioned the audit assignment. */
  clientName?: string | null;
  /** The assignment's completion date (YYYY-MM-DD), the service date a reviewer anchors on. */
  serviceDate: string | null;
  /** Set on EXPENSE lines only — the claim's category, so the reveal says what was reimbursed. */
  expenseCategory: string | null;
  baseAmount: number;
  travelAmount: number;
  tdsAmount: number;
  totalAmount: number;
}

/** The invoice header, as every list/detail endpoint returns it. */
export interface AssayerInvoiceSummary {
  id: string;
  invoiceNumber: string;
  assayerId: string;
  status: AssayerInvoiceStatus;
  invitedAt: string | null;
  invitedBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  /** The HOD's final approval (2026-09-24) — set when the bill is cleared for payment. */
  hodApprovedAt?: string | null;
  hodApprovedBy?: string | null;
  /** The last HOD rejection, kept so the office sees why the bill came back to them. */
  hodRejectedAt?: string | null;
  hodRejectedBy?: string | null;
  hodRejectReason?: string | null;
  paidAt?: string | null;
  paidBy?: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  revision?: number;
  supersedesInvoiceId?: string | null;
  supersededByInvoiceId?: string | null;
  confirmedVersion?: number | null;
  lineCount: number;
  subtotalBase: number;
  subtotalTravel: number;
  tdsAmount: number;
  totalAmount: number;
  currency: string;
  notes: string | null;
  // Labels attached by list endpoints.
  assayerName?: string | null;
  assayerCode?: string | null;
  /**
   * Returned by the office's approval only: what the approver must know that did not refuse it —
   * a line paid to a bank account no passbook or identity document backs (2026-09-24 audit F3).
   */
  warnings?: string[];
}

/**
 * THE reveal: the active invitation an assayer reviews and submits. This is the first payload
 * in the whole system that shows an assayer money, so it carries everything they need to judge
 * it — and nothing that is not theirs.
 */
export interface AssayerInvoiceInvitation extends AssayerInvoiceSummary {
  lines: AssayerInvoiceLine[];
}

/**
 * Per-assayer outcome of the bulk "invite everyone with unbilled work" gesture. The batch never
 * fails as a whole; `failed` is the defensive bucket for an infrastructure error on one assayer
 * (logged server-side, `error` carries the message) — distinct from the two expected refusals so
 * it is never dressed up as a business outcome.
 */
export interface AssayerInvoiceInviteOutcome {
  assayerId: string;
  outcome: 'invited' | 'skipped-active-invoice' | 'nothing-eligible' | 'failed';
  invoiceId?: string;
  invoiceNumber?: string;
  lineCount?: number;
  error?: string;
}

/**
 * The counts-only invoicing block on the ASSAYER-audience statement. Deliberately no amounts:
 * money first becomes visible on the invitation itself, never on the statement's teaser.
 */
export interface AssayerStatementInvoicingBlock {
  /** Eligible payables not yet attached to any invoice — "N completed audits await invoicing". */
  awaitingInvoiceCount: number;
  /** The active (INVITED | SUBMITTED) invitation, or null when there is none. */
  invitation: { id: string; status: AssayerInvoiceStatus; lineCount: number } | null;
}

/**
 * The full `GET /billing-engine/assayers/:assayerId/statement` response — one canonical shape for
 * both the staff (ungated) and assayer (gated) audiences, rather than each client hand-declaring
 * its own partial mirror.
 *
 * Before this type existed, mobile's own hand-rolled copy silently dropped `totals.tdsWithheld`,
 * `tdsSection`, and every payable's `invoiceNumber`/`invoiceStatus` — fields the backend always
 * computes and sends, and that the staff-facing web statement already reads and displays. An
 * assayer's own statement showed less about their own money than the desk's view of the same
 * record. A client that hand-maps a response instead of importing the real shape can drop a field
 * silently, with no compile error, the moment the backend adds one — importing this type instead
 * turns that into a type error at the call site.
 */
export interface AssayerStatementTotals {
  earned: number;
  paid: number;
  outstanding: number;
  awaitingApproval: number;
  onHoldOrDisputed: number;
  /** Withheld under `tdsSection` below. Absent from no response — the backend always computes it. */
  tdsWithheld: number;
  payableCount: number;
}

export interface AssayerStatementPayable {
  id: string;
  payableNumber: string;
  status: string;
  onHold: boolean;
  holdReason: string | null;
  assignmentId: string | null;
  expenseId: string | null;
  baseAmount: number;
  travelAmount: number;
  tdsAmount: number;
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  createdAt: string;
  /** Which assayer invoice this row rides, if any — null means never invited. */
  invoiceNumber: string | null;
  invoiceStatus: AssayerInvoiceStatus | null;
  /**
   * Earned before the invoicing gate existed — visible under the old rules, never re-billed.
   * Present only on the gated (assayer-audience) statement's rows.
   */
  preInvoicingEra?: boolean;
  /**
   * The HOD's final approval (2026-09-24). An APPROVED payable without it is approved by the
   * office and waiting for the final approval — not payable yet. Absent on older servers.
   */
  hodApproved?: boolean;
}

export interface AssayerStatementPayment {
  id: string;
  paymentReference: string | null;
  method: string;
  amount: number;
  paidDate: string | null;
  /**
   * Absent on the gated (assayer-audience) statement: a running balance over ALL payables would
   * leak the sum of whichever ones the gate is withholding, so those rows omit the field entirely
   * rather than send a number that lies by counting hidden money.
   */
  balanceAfter?: number | null;
  notes: string | null;
}

export interface AssayerStatement {
  assayerId: string;
  assayerName: string | null;
  assayerCode: string | null;
  /** Decrypted for finance; null when the assayer has no PAN on file. */
  pan: string | null;
  /** The Income-tax section the withholding is quoted under, from settings (e.g. 194J). */
  tdsSection: string;
  totals: AssayerStatementTotals;
  payables: AssayerStatementPayable[];
  payments: AssayerStatementPayment[];
  /** Present only once the server's `billing.assayerInvoicingEnabled` flag is on. */
  invoicing?: AssayerStatementInvoicingBlock;
}
