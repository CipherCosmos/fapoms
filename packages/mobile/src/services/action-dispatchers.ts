import { MobileApiService } from './api.service';
import { ActionDispatcher, isRetryableStatus } from './action-queue';
import type { AssayerAssignment } from '../types/mobile-app';

/**
 * The one place a queued action's payload is turned into an actual request.
 *
 * Shared between the immediate attempt (`enqueueAndRun`, called from the screen the moment the
 * assayer taps something) and the background drain (`processActionQueue`, called on app start,
 * foreground return and reconnect) so the two can never drift — a fix made here covers both, and
 * an action that succeeds on the first attempt is built from exactly the same request a later
 * retry would send.
 */

export interface CheckInOutPayload {
  assignmentId: string;
  lat: number;
  lng: number;
  accuracy?: number;
}

export interface AssignmentStatusPayload {
  op: 'transition';
  assignmentId: string;
  /**
   * Typed as the app's own status union, not `string`, so a legacy counter-offer action can no
   * longer even be CONSTRUCTED: fee negotiation was removed from the app, `COUNTER_OFFER` is not
   * a value of this union, and there is deliberately no fee field on this payload. (The server
   * additionally refuses such transitions with a terminal 400 for old builds.)
   */
  status: AssayerAssignment['status'];
  notes?: string;
}

export interface RejectPayload {
  op: 'reject';
  assignmentId: string;
  reason: string;
}

export interface ExpenseClaimPayload {
  assignmentId: string;
  expense: { category: string; amount: number; description?: string };
}

export interface QueryMessagePayload {
  queryId: string;
  body: string;
  attachments?: { url: string; fileName: string; fileType: string }[];
}

export const actionDispatchers: {
  CHECK_IN: ActionDispatcher<CheckInOutPayload>;
  CHECK_OUT: ActionDispatcher<CheckInOutPayload>;
  ASSIGNMENT_STATUS: ActionDispatcher<AssignmentStatusPayload | RejectPayload>;
  EXPENSE_CLAIM: ActionDispatcher<ExpenseClaimPayload>;
  QUERY_MESSAGE: ActionDispatcher<QueryMessagePayload>;
} = {
  // Check-in/out need no clientRequestId: the server already treats them as idempotent by
  // nature (first arrival kept; an already-checked-out assignment just returns success), so a
  // retry that actually landed the first time is harmless without one.
  CHECK_IN: async (p) => {
    const res = await MobileApiService.checkInBranch(p.assignmentId, p.lat, p.lng, p.accuracy);
    return { success: res.success, error: res.error, retryable: isRetryableStatus(res.status) };
  },
  CHECK_OUT: async (p) => {
    const res = await MobileApiService.checkOutBranch(p.assignmentId, p.lat, p.lng, p.accuracy);
    return { success: res.success, error: res.error, retryable: isRetryableStatus(res.status) };
  },
  ASSIGNMENT_STATUS: async (p) => {
    if (p.op === 'reject') {
      const res = await MobileApiService.rejectAssignment(p.assignmentId, p.reason);
      return { success: res.success, error: res.error, retryable: isRetryableStatus(res.status) };
    }
    // No clientRequestId: every transition an assayer still holds (accept, check-in,
    // in-progress) is idempotent server-side — repeating one is a no-op. The action that needed
    // dedup, the counter-offer, no longer exists in this app.
    const { ok, status } = await MobileApiService.updateAssignmentStatus(p.assignmentId, p.status, p.notes);
    return { success: ok, error: ok ? undefined : 'Failed to update assignment status', retryable: isRetryableStatus(status) };
  },
  EXPENSE_CLAIM: async (p, clientRequestId) => {
    const res = await MobileApiService.submitExpense(p.assignmentId, p.expense, clientRequestId);
    return { success: res.success, error: res.error, retryable: isRetryableStatus(res.status) };
  },
  QUERY_MESSAGE: async (p) => {
    const res = await MobileApiService.postQueryMessage(p.queryId, p.body, p.attachments ?? []);
    return { success: res.success, error: res.error, retryable: isRetryableStatus(res.status) };
  },
};
