/**
 * THE FINAL APPROVAL (owner, 2026-09-24).
 *
 * After the office approves, the HOD — whoever holds `BILLING:FINAL_APPROVE:ORGANIZATION`: Admin by
 * default, and any role built in Users & Roles that is given it — approves once more before money
 * can move. Every item, no threshold:
 *
 *  - an assayer's bill (the office approved it; its payouts cannot be paid until the HOD approves),
 *  - a payout the office approved without a bill (the exception path),
 *  - an expense reimbursement the office approved for payment,
 *  - a client invoice, before it can be marked sent to the client.
 *
 * The HOD approves, or rejects with a reason — a rejection goes back to the office, it never
 * cancels anything. The HOD may not be the person who did the office approval (nor, for a client
 * invoice, the person who made it or sent it up): a second pair of eyes has to be a second person.
 */

/** The permission, in the stored RESOURCE:ACTION:SCOPE form. Routes declare it lower-case. */
export const BILLING_FINAL_APPROVE_PERMISSION = 'BILLING:FINAL_APPROVE:ORGANIZATION';

/** What the HOD is being asked to approve. */
export type FinalApprovalKind = 'ASSAYER_BILL' | 'DIRECT_PAYOUT' | 'EXPENSE_REIMBURSEMENT' | 'CLIENT_INVOICE';

export const FINAL_APPROVAL_KINDS: readonly FinalApprovalKind[] = [
  'ASSAYER_BILL', 'DIRECT_PAYOUT', 'EXPENSE_REIMBURSEMENT', 'CLIENT_INVOICE',
];

export const FINAL_APPROVAL_KIND_LABELS: Record<FinalApprovalKind, string> = {
  ASSAYER_BILL: 'Assayer bill',
  DIRECT_PAYOUT: 'Payout approved without a bill',
  EXPENSE_REIMBURSEMENT: 'Expense reimbursement',
  CLIENT_INVOICE: 'Client invoice',
};

/** One thing waiting for the HOD. */
export interface FinalApprovalItem {
  kind: FinalApprovalKind;
  /** The bill's, payout's or invoice's id — what the approve/reject routes take. */
  id: string;
  /** AINV-…, PY-… or INV-…, the number people search by. */
  number: string;
  /** Who gets the money (an assayer) or who is billed (a client). */
  payeeName: string | null;
  payeeCode: string | null;
  /** What moves: the bill's or payout's net to pay, or the invoice total. */
  amount: number;
  currency: string;
  /** How many payouts a bill carries; 1 for a payout; the lines on a client invoice. */
  lineCount: number;
  /** The office approval the HOD is checking: who, and when. For a client invoice, who sent it up. */
  officeApprovedBy: string | null;
  officeApprovedByName: string | null;
  officeApprovedAt: string | null;
  /** The reason the office gave for approving a payout without a bill, when it did. */
  officeNote: string | null;
  /** The assignment a payout is for, when it is one payout. */
  assignmentNumber: string | null;
  /** The last time the HOD sent it back, and why — so a second look knows what the first one said. */
  lastRejectReason: string | null;
  /**
   * What the HOD should know about the bank account the money goes to (2026-09-24 audit): not
   * verified, or changed since the office approved. Empty when there is nothing to say; never set
   * on a client invoice.
   */
  warnings?: string[];
}

export interface FinalApprovalQueue {
  items: FinalApprovalItem[];
  counts: Record<FinalApprovalKind, number>;
  total: number;
  /** True when the list was cut at its cap — the counts are still the whole queue. */
  truncated: boolean;
}

/** One item named for a bulk approve. */
export interface FinalApprovalRef {
  kind: FinalApprovalKind;
  id: string;
}

export interface FinalApprovalBulkResult {
  done: FinalApprovalRef[];
  refused: Array<FinalApprovalRef & { reason: string }>;
}

/** Shortest and longest an HOD's reason may be — long enough for the office to act on. */
export const HOD_REJECT_REASON_MIN = 10;
export const HOD_REJECT_REASON_MAX = 1000;

/** Why an HOD rejection's reason will not do, or null. */
export function hodRejectReasonProblem(reason: string | null | undefined): string | null {
  const t = (reason ?? '').trim();
  if (t.length < HOD_REJECT_REASON_MIN) {
    return 'Say why it is going back to the office, in a sentence they can act on.';
  }
  if (t.length > HOD_REJECT_REASON_MAX) return `Keep it under ${HOD_REJECT_REASON_MAX} characters.`;
  return null;
}

/** The one sentence every refused payment says when the HOD has not approved yet. */
export const AWAITING_HOD_MESSAGE = 'Waiting for HOD approval';
