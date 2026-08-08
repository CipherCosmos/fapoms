import type { AssayerAssignment } from '../types/mobile-app';

/**
 * One definition of "how many queries need me".
 *
 * There were three, and two of them were visible at the same time: the tab badge counted
 * assignments holding any non-RESOLVED query, Home counted individual queries with status
 * OPEN, and the Queries screen grouped by assignment again. Home read "Open queries 1" with a
 * badge of 2 beside it, over the same data.
 *
 * The count that matters to an assayer is work waiting on *them*: a query the desk raised and
 * they have not answered. RESPONDED means they have answered and the desk has it — real, worth
 * showing, but not a thing to chase. Counting it in the badge sends someone back to a thread
 * where there is nothing to do.
 */
export function countOpenQueries(assignments: AssayerAssignment[]): number {
  return assignments.reduce(
    (n, a) => n + (a.queries || []).filter((q) => q.status === 'OPEN').length,
    0,
  );
}

/** Answered by the assayer, still with the desk. Shown, never badged. */
export function countAwaitingDesk(assignments: AssayerAssignment[]): number {
  return assignments.reduce(
    (n, a) => n + (a.queries || []).filter((q) => q.status === 'RESPONDED').length,
    0,
  );
}

export function countResolvedQueries(assignments: AssayerAssignment[]): number {
  return assignments.reduce(
    (n, a) => n + (a.queries || []).filter((q) => q.status === 'RESOLVED').length,
    0,
  );
}
