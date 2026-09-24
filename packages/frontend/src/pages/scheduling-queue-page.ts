/**
 * The Scheduling queue reads the first 100 unscheduled confirmed offers. It used to show "100" as
 * though that were all of them; the server's pagination total now says how many there really are.
 */
export function readQueuePage<T>(res: unknown): { rows: T[]; total: number } {
  const rows: T[] = Array.isArray(res) ? (res as T[]) : ((res as any)?.data ?? []);
  const total = Number((res as any)?.meta?.pagination?.total);
  return { rows, total: Number.isFinite(total) && total >= rows.length ? total : rows.length };
}

/** "Showing 100 of 342" when the queue is truncated, else null. */
export function truncationNote(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown} of ${total} — schedule these, or narrow the scope, to see the rest.` : null;
}
