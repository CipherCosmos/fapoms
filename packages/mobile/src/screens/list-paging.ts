/**
 * "Show more" for lists whose rows are already all on the phone.
 *
 * The Earnings lists were cut at 8/8/10/15 rows with nothing to say there were more, so an
 * assayer with a long history could not find an older payout or claim at all. The server already
 * returns every row (the statement, `/expenses/mine`, the assignment list), so no new request is
 * needed: the list starts at the same length it always did and each press shows one more page.
 */
export interface ListPage<T> {
  visible: T[];
  /** Rows not shown yet. */
  remaining: number;
  /** How many the next press adds — never more than are left. */
  nextStep: number;
}

export function pageOf<T>(items: readonly T[], shown: number, step: number): ListPage<T> {
  const limit = Math.max(0, shown);
  const visible = items.slice(0, limit);
  const remaining = Math.max(0, items.length - visible.length);
  return { visible, remaining, nextStep: Math.min(Math.max(1, step), remaining) };
}
