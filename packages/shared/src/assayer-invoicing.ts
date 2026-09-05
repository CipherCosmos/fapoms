import { AssayerInvoiceStatus } from './enums';

/**
 * Assayer invoicing — the API shapes for the consent-and-visibility wrapper over payables.
 *
 * The invoice never carries money of its own: every figure on it is a SUM of amounts already
 * stored on `assayer_payables` rows (which were themselves snapshotted at booking by
 * `assignmentMoney`). These types exist so the ops web app, the mobile app and the backend
 * agree on the payloads without any of them re-deriving a rupee.
 */

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
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
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
