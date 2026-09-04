import { MobileApiService } from './api.service';
import { ActionDispatcher, isRetryableStatus } from './action-queue';

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
  status: string;
  notes?: string;
  counterTravelFee?: number;
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
  ASSIGNMENT_STATUS: async (p, clientRequestId) => {
    if (p.op === 'reject') {
      const res = await MobileApiService.rejectAssignment(p.assignmentId, p.reason);
      return { success: res.success, error: res.error, retryable: isRetryableStatus(res.status) };
    }
    // `clientRequestId` only does anything server-side for a counter-offer (see
    // `updateAssignmentStatus`'s own comment) — it is still passed for every transition so the
    // dispatcher does not need to know which ones the backend keys on.
    const { ok, status } = await MobileApiService.updateAssignmentStatus(
      p.assignmentId,
      p.status as any,
      p.notes,
      p.counterTravelFee,
      clientRequestId,
    );
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
