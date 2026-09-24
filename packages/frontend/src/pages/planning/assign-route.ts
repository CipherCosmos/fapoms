import { money } from '../../utils/money';

/**
 * Where a planning "assign" goes: a new assignment, a reassignment of the branch's live offer, or
 * nowhere at all.
 *
 * ## Why this exists
 *
 * `POST /assignments` on a branch whose offer was still open used to MOVE that offer to the new
 * assayer, silently: the assayer who lost it was never told and no reason was recorded. The server
 * now refuses that (`BRANCH_HAS_LIVE_OFFER`); moving an open offer is a reassignment
 * (`POST /assignments/:id/reassign`), which needs a written reason and notifies both assayers.
 *
 * Every planning entry point that can put an assayer on a branch — the assign modal (Send to app
 * and Call & Assign) and "Assign anyway" for a filtered candidate — asks this one function which
 * of the three it is, so they cannot drift apart again.
 *
 * - PENDING / ACCEPTED with somebody else → reassign (reason required).
 * - CHECKED_IN / IN_PROGRESS → blocked. The assayer has arrived; the office cancels the job
 *   instead. The server refuses too (`REASSIGN_AFTER_CHECK_IN`); this just says so before asking.
 * - no assignment, REJECTED, CANCELLED, or the same assayer → create, exactly as before.
 */

/** The branch's latest assignment, as the planning branch list carries it. */
export interface LiveAssignment {
  id: string;
  status: string;
  proposedFee?: number | string | null;
  scheduledDate?: string | null;
  assayer?: { id: string; displayName: string } | null;
}

export type AssignRoute =
  | { kind: 'create' }
  | { kind: 'reassign'; assignmentId: string; fromName: string; fromStatus: string }
  | { kind: 'blocked'; message: string };

const MOVABLE = new Set(['PENDING', 'ACCEPTED']);
const ARRIVED = new Set(['CHECKED_IN', 'IN_PROGRESS']);

export function assignRoute(live: LiveAssignment | null | undefined, newAssayerId: string): AssignRoute {
  if (!live) return { kind: 'create' };
  const holderName = live.assayer?.displayName || 'The assayer';
  if (ARRIVED.has(live.status)) {
    return {
      kind: 'blocked',
      message: `${holderName} has already checked in at this branch — cancel the job instead, then plan the branch again.`,
    };
  }
  // A missing holder is treated as "somebody else": the server knows who holds it and decides.
  if (MOVABLE.has(live.status) && live.assayer?.id !== newAssayerId) {
    return {
      kind: 'reassign',
      assignmentId: live.id,
      fromName: live.assayer?.displayName || 'the current assayer',
      fromStatus: live.status,
    };
  }
  return { kind: 'create' };
}

/**
 * Why the assign button cannot be pressed yet, or null when it can. The modal disables its submit
 * on a non-null answer and shows the sentence.
 */
export function assignBlocker(route: AssignRoute, reassignReason: string): string | null {
  if (route.kind === 'blocked') return route.message;
  if (route.kind === 'reassign' && !reassignReason.trim()) {
    return `Write why this branch is moving from ${route.fromName}.`;
  }
  return null;
}

type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

export interface ReassignOptions {
  assignmentId: string;
  newAssayerId: string;
  reason: string;
  /**
   * The fee the desk TYPED — see `feeToSend`. Omitted when the box still holds the quote it was
   * prefilled with: the server then records its own day-aware quote for the new assayer (base
   * only when their travel for that day is already paid on another job). Sending the prefill
   * made the server treat a travel-inclusive quote as the desk's number and charge travel twice.
   */
  fee?: number;
  /** The date on the form (YYYY-MM-DD). The server applies it only when it differs. */
  scheduledDate?: string;
  /** Call & Assign: the desk records the new assayer's acceptance in the same request. */
  acceptOnBehalf: boolean;
  /** Optional wording for the recorded acceptance; a default is used for Call & Assign. */
  acceptanceReason?: string;
}

interface AssignmentResult {
  id?: string;
  status?: string;
  proposedFee?: number | string | null;
  scheduledDate?: string | null;
}

/**
 * The fee to send with an assign, or undefined to let the server price it.
 *
 * Only a figure the desk actually typed is sent. The box is prefilled with the rate card's quote
 * as a reading; posting that prefill back made it the "desk's" number, which the server never
 * re-prices — so an assayer's second job on the same day carried travel a second time.
 */
export function feeToSend(feeInput: string, feeEdited: boolean): number | undefined {
  if (!feeEdited) return undefined;
  if (String(feeInput).trim() === '') return undefined;
  const n = Number(feeInput);
  return Number.isFinite(n) ? n : undefined;
}

/** The one `POST /assignments/:id/reassign` body — move, fee, date and acceptance together. */
export function reassignBody(o: ReassignOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { newAssayerId: o.newAssayerId, reason: o.reason.trim() };
  if (o.fee != null && Number.isFinite(o.fee)) body.proposedFee = o.fee;
  if (o.scheduledDate) body.scheduledDate = o.scheduledDate;
  if (o.acceptOnBehalf) {
    body.acceptOnBehalf = true;
    body.acceptanceReason = o.acceptanceReason?.trim()
      || (o.fee != null && Number.isFinite(o.fee)
        ? `Agreed at ${money(o.fee)} during Call & Assign.`
        : 'Agreed during Call & Assign.');
  }
  return body;
}

/**
 * Move a live offer to another assayer — in ONE request.
 *
 * The server's reassign takes the move, the desk's typed fee, a new date and the desk's record of
 * the incoming assayer's acceptance together, in one transaction. This used to be three requests
 * (reassign, then PUT fee/date, then accept), and a failure after the first left the job moved at
 * the rate card's price with nobody's acceptance recorded. Resolves with what the server reports,
 * so the caller says what actually happened.
 */
export async function reassignAndApply(
  request: Request,
  o: ReassignOptions,
): Promise<{ status?: string; proposedFee?: number | string | null }> {
  const reason = o.reason.trim();
  if (!reason) throw new Error('A reason is required to move this branch to another assayer.');

  const moved = await request<AssignmentResult>(`/assignments/${o.assignmentId}/reassign`, {
    method: 'POST',
    body: JSON.stringify(reassignBody(o)),
  });
  return { status: moved?.status, proposedFee: moved?.proposedFee };
}

/**
 * Post a day plan's stops one at a time, in the order given, collecting each stop's outcome.
 *
 * Sequential on purpose: the server charges travel once per assayer per day, on whichever of that
 * day's jobs it records first. Posted concurrently, network timing picked which stop carried the
 * travel; in order, it is always the route's first stop. One refusal does not stop the rest.
 */
export async function postStopsInOrder<S>(
  stops: S[],
  post: (stop: S) => Promise<void>,
  describeError: (err: unknown) => string,
): Promise<{ stop: S; ok: boolean; error?: string }[]> {
  const results: { stop: S; ok: boolean; error?: string }[] = [];
  for (const stop of stops) {
    try {
      await post(stop);
      results.push({ stop, ok: true });
    } catch (err) {
      results.push({ stop, ok: false, error: describeError(err) || 'Failed' });
    }
  }
  return results;
}

/**
 * The day-plan fields one stop's `POST /assignments` carries (F6/Q10, 2026-09-25).
 *
 * A day plan is one journey, and the plan screen priced the day's travel on the whole loop. The
 * route's FIRST stop sends that loop (`plannedDayLoopKm` / `plannedDayLoopMinutes`), so the server
 * quotes its travel on the loop — a system quote, still under travel-once-a-day — and the booked
 * total equals what the plan showed. Every other stop sends nothing extra and is priced base-only,
 * because the first stop already carries the day's journey. No fee is ever sent: the server prices.
 * A retry of only later stops therefore never re-sends the loop.
 */
export function dayPlanStopBody(
  stop: { order: number },
  firstStopOrder: number,
  plan: { totalTravelKm?: number | null; totalTravelMinutes?: number | null },
): Record<string, number> {
  if (stop.order !== firstStopOrder) return {};
  const km = Number(plan.totalTravelKm);
  if (!Number.isFinite(km) || km <= 0) return {};
  const minutes = Number(plan.totalTravelMinutes);
  return {
    plannedDayLoopKm: km,
    ...(Number.isFinite(minutes) && minutes > 0 ? { plannedDayLoopMinutes: minutes } : {}),
  };
}
