import { api } from './api';

/**
 * Assayer reimbursement claims.
 *
 * Field assayers raise claims from the mobile app (`POST /assignments/:id/expenses`); this
 * surfaces the review side that had no web home, so finance/ops can actually approve or reject
 * them. Without it every submitted claim sits PENDING forever and nobody is reimbursed.
 */

export type ExpenseCategory = 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER';
export type ExpenseStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ExpenseClaim {
  id: string;
  assignmentId: string;
  assayerId: string;
  category: ExpenseCategory;
  amount: number | string;
  description: string | null;
  receiptUrl: string | null;
  status: ExpenseStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  /**
   * The payable that will actually pay this claim. Approval raises one; null on an approved
   * claim means the reimbursement never got raised and the money is not on its way.
   */
  reimbursementPayableId: string | null;
  createdAt: string;
  // Loaded by /expenses/pending (relations: assignment, assayer).
  assayer?: { id: string; displayName?: string; assayerCode?: string } | null;
  assignment?: { id: string; assignmentNumber?: string; projectBranchId?: string } | null;
}

/** Claims awaiting a decision, oldest first (a work queue). */
export const getPendingExpenses = () => api.request<ExpenseClaim[]>('/expenses/pending');

/**
 * Approve or reject a claim. A rejection MUST carry a reason — the backend refuses a reject
 * with no note, since a refused reimbursement the assayer can't act on is exactly the dispute
 * that needs a record.
 */
export const reviewExpense = (expenseId: string, approve: boolean, notes?: string) =>
  api.request<ExpenseClaim>(`/expenses/${expenseId}/review`, {
    method: 'POST',
    body: JSON.stringify({ approve, notes }),
  });

/**
 * Approved claims that never became a payable.
 *
 * Approval is supposed to raise a reimbursement payable immediately. When that write fails the
 * approval still stands — the reviewer's decision is real and the assayer has been told — so the
 * claim sits approved with nothing owing it. This is the queue that makes that visible instead
 * of leaving an assayer waiting on money nobody is tracking.
 */
export const getUnpaidApprovals = () => api.request<ExpenseClaim[]>('/expenses/unpaid-approvals');

/** Raises the missing payables. Idempotent — a claim that already has one is skipped. */
export const retryUnpaidApprovals = () =>
  api.request<{ attempted: number; raised: number }>('/expenses/unpaid-approvals/retry', {
    method: 'POST',
  });

/** One assayer's full claim history (optionally filtered by status). */
export const getAssayerExpenses = (assayerId: string, status?: ExpenseStatus) =>
  api.request<ExpenseClaim[]>(
    `/assayers/${assayerId}/expenses${status ? `?status=${status}` : ''}`,
  );

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  TRAVEL_KM: 'Travel (km)',
  TOLL: 'Toll',
  FOOD: 'Food',
  OTHER: 'Other',
};

// ── Travel verification ──────────────────────────────────────────────────────────
/**
 * What the recorded movement trail says about the journey an assignment was paid travel for.
 *
 * Read-only evidence for whoever is approving a claim. The verdict vocabulary deliberately
 * separates "we did not observe enough to say" from "we observed, and it was short" — see the
 * backend's travel-track module — so a reviewer is never shown a shortfall the data cannot support.
 */
export type TravelVerdict =
  | 'NO_DATA'
  | 'INSUFFICIENT_COVERAGE'
  | 'CONSISTENT'
  | 'SHORTFALL'
  | 'IMPLAUSIBLE';

export interface TravelVerification {
  assignmentId: string;
  assignmentNumber: string;
  checkedInAt: string | null;
  /** Whether the assayer had location sharing on — changes what an empty trail means. */
  trackingEnabled: boolean;
  expectedDistanceKm: number | null;
  /** The quoted distance is not stored, so it is reconstructed from the assayer's current home. */
  expectedIsRecomputed: boolean;
  assessment: {
    verdict: TravelVerdict;
    summary: string;
    expectedDistanceKm: number | null;
    observedRatio: number | null;
    track: {
      observedDistanceKm: number;
      coverage: number;
      longestGapMinutes: number;
      fixCount: number;
      mockedFixCount: number;
      segmentsImplausible: number;
    };
  } | null;
  unavailableReason: string | null;
}

export const getTravelVerification = (assignmentId: string) =>
  api.request<TravelVerification>(`/assignments/${assignmentId}/travel-verification`);
