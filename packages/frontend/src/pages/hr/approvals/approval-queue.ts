import { useQuery } from '@tanstack/react-query';
import { OnboardingApprovalStatus as Status } from '@fapoms/shared';
import { api } from '../../../services/api';
import { queryKeys } from '../../../hooks/queryKeys';
import {
  canApproveJoiners, useCurrentPermissions, useCurrentRoles, useCurrentUserId,
} from '../../../hooks/useCurrentRoles';
import type { ApprovalRound } from '../record/ApprovalPanel';

/**
 * WHO IS WAITING FOR A SENIOR'S APPROVAL BEFORE TRAINING — the approver's list.
 *
 * Read by three things: the Approvals page, its count in the sidebar, and its count in the HR tab
 * strip. They share this one query (one key), so a count and the list it counts cannot disagree.
 */

/** One row, as `GET /assayers/approvals/queue` gives it: the open round, and whose it is. */
export interface QueuedApproval extends ApprovalRound {
  assayerId: string;
  displayName: string;
  assayerCode: string | null;
  region: string | null;
}

export interface ApprovalQueueSplit {
  /** Waiting on THIS reader: sent up, nothing outstanding with HR, and not prepared by them. */
  yours: QueuedApproval[];
  /** The approver asked HR for more; it comes back here when HR answers. */
  waitingOnHr: QueuedApproval[];
  /** Prepared by this reader — they sent it up or answered on it — so somebody else decides it. */
  othersDecide: QueuedApproval[];
}

/**
 * Split the queue by what this reader can do about each row.
 *
 * "Prepared by you" is the round's own `preparers` list — the list the server refuses a decision
 * on — never a rule restated here. The approval panel on the record reads the same field, so the
 * list and the record agree about who may decide.
 */
export function splitApprovalQueue(rows: readonly QueuedApproval[], userId: string | null): ApprovalQueueSplit {
  const split: ApprovalQueueSplit = { yours: [], waitingOnHr: [], othersDecide: [] };
  for (const row of rows) {
    if (userId && row.preparers.includes(userId)) split.othersDecide.push(row);
    else if (row.status === Status.INFO_REQUESTED) split.waitingOnHr.push(row);
    else if (row.status === Status.PENDING) split.yours.push(row);
  }
  return split;
}

/**
 * The queue, for somebody who may approve — and nothing at all for anybody else.
 *
 * Not fetched without the permission: the route refuses them, and a sidebar that fired a refused
 * request on every page load would fill the log with 403s nobody caused.
 *
 * Polled as well as refreshed by the lifecycle events (`useSocketInvalidation`): "ask HR for more"
 * and HR's answer move a round between "yours" and "waiting on HR" without changing anybody's
 * stage, so no lifecycle event fires for them.
 */
export function useApprovalQueue() {
  const roles = useCurrentRoles();
  const permissions = useCurrentPermissions();
  const userId = useCurrentUserId();
  const canApprove = canApproveJoiners(roles, permissions);
  const query = useQuery({
    queryKey: queryKeys.hr.approvals,
    queryFn: () => api.request<QueuedApproval[]>('/assayers/approvals/queue'),
    enabled: canApprove,
    staleTime: 30_000,
    refetchInterval: canApprove ? 60_000 : false,
    refetchOnWindowFocus: 'always',
  });
  const rows = Array.isArray(query.data) ? query.data : [];
  return { query, canApprove, userId, split: splitApprovalQueue(rows, userId) };
}

/**
 * The number beside "Approvals": decisions waiting on this reader. `null` — no number at all — for
 * somebody who cannot approve, and while the queue has not answered, so a loading or failed list
 * never shows as a reassuring 0.
 */
export function useApprovalCount(): number | null {
  const { query, canApprove, split } = useApprovalQueue();
  if (!canApprove || !Array.isArray(query.data)) return null;
  return split.yours.length;
}

/**
 * Since when the row has been where it is — with the approver, or with HR.
 *
 * The round's last event is exactly the move that put it there: sent up or answered puts it on the
 * approver's desk, "asked for more" puts it on HR's. So the latest event's time is the answer for
 * every status, without a table of which kinds count.
 */
export function waitingSince(row: Pick<QueuedApproval, 'events'>): string | null {
  const last = row.events[row.events.length - 1];
  return last?.at ?? null;
}

/** "today", "1 day", "4 days" — how long it has waited, in whole days. */
export function waitedFor(since: string | null, now: Date = new Date()): string {
  if (!since) return '—';
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}
