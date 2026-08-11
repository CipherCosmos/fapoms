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
