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
   * The fee the desk typed. Applied when the rate card's re-price for the new assayer differs.
   * Omitted, the server's re-price stands.
   */
  fee?: number;
  /** The date on the form. Applied when it differs from the date the job already carries. */
  scheduledDate?: string;
  /** Call & Assign: the desk accepts on the new assayer's behalf at `fee`. */
  acceptOnBehalf: boolean;
}

interface AssignmentResult {
  id?: string;
  status?: string;
  proposedFee?: number | string | null;
  scheduledDate?: string | null;
}

/**
 * Move a live offer to another assayer, then bring it to what the form says.
 *
 * The server re-prices from the rate card for the new assayer and resets the job to PENDING; the
 * desk's typed fee (and date) are then applied on top, and Call & Assign accepts it at that fee —
 * the same three things the create path does in one request, done as the three the reassign
 * contract allows. Resolves with the final status so the caller reports what actually happened.
 */
export async function reassignAndApply(request: Request, o: ReassignOptions): Promise<{ status?: string }> {
  const reason = o.reason.trim();
  if (!reason) throw new Error('A reason is required to move this branch to another assayer.');

  const moved = await request<AssignmentResult>(`/assignments/${o.assignmentId}/reassign`, {
    method: 'POST',
    body: JSON.stringify({ newAssayerId: o.newAssayerId, reason }),
  });
  const id = moved?.id || o.assignmentId;
  let status = moved?.status;

  const patch: Record<string, unknown> = {};
  if (o.fee != null && Number.isFinite(o.fee) && Number(moved?.proposedFee) !== o.fee) {
    patch.proposedFee = o.fee;
    patch.agreedFee = o.fee;
  }
  const currentDate = moved?.scheduledDate ? String(moved.scheduledDate).slice(0, 10) : undefined;
  if (o.scheduledDate && o.scheduledDate !== currentDate) patch.scheduledDate = o.scheduledDate;
  if (Object.keys(patch).length > 0) {
    await request(`/assignments/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
  }

  if (o.acceptOnBehalf) {
    if (o.fee == null) throw new Error('Accepting on the assayer\'s behalf needs the agreed fee.');
    const accepted = await request<AssignmentResult>(`/assignments/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify({ fee: o.fee, reason: `Agreed at ${money(o.fee)} during Call & Assign.` }),
    });
    status = accepted?.status ?? 'ACCEPTED';
  }
  return { status };
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
