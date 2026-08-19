/**
 * One rule for "which ticked rows does a bulk action actually change".
 *
 * Every bulk bar in the app kept its ticked ids in a `Set<string>` that outlived the list it was
 * ticked from. Change a filter, jump a page, let a refetch drop a row — the set still held ids the
 * user could no longer see, and the action then sent them to the server. On the planning queue that
 * meant branches nobody had looked at being marked "unable to cover"; on clients it meant the
 * banner counting one thing and the request doing another. The two bulk buttons on the *same*
 * planning screen disagreed about it, which is how it went unnoticed for so long.
 *
 * The rule chosen, and applied at every bulk call site:
 *
 *   A bulk action changes exactly the rows that are on screen right now. The number on the button
 *   is that number. If ticked rows have since been filtered or paged away, we say so instead of
 *   quietly including them or quietly dropping them.
 *
 * Intersecting at action time (rather than pruning the set whenever the visible list changes) is
 * deliberate: pruning throws away a coordinator's ticking the instant they glance at another
 * filter, which is its own kind of silent data loss. Keeping the set and narrowing it at the last
 * moment costs nothing, is safe by construction, and the note below keeps it honest.
 */

export interface VisibleSelection<T> {
  /** The ticked rows that are actually on screen — what the action will change. */
  rows: T[];
  /** Their ids, ready to send. Never contains an id the user cannot currently see. */
  ids: string[];
  /** How many ticked rows the current filter/page is hiding. Zero in the normal case. */
  hiddenCount: number;
}

/**
 * Narrow a ticked-id set down to the rows currently visible.
 *
 * `visible` must be the exact list rendered on screen (already filtered, already the current page,
 * and already narrowed to rows the action can legally touch — e.g. only unsent documents).
 */
export function visibleSelection<T>(
  selected: Set<string>,
  visible: T[],
  keyOf: (row: T) => string,
): VisibleSelection<T> {
  const rows = visible.filter((row) => selected.has(keyOf(row)));
  return {
    rows,
    ids: rows.map(keyOf),
    hiddenCount: Math.max(0, selected.size - rows.length),
  };
}

/**
 * Plain-language warning for the ticked rows the current view is hiding, or `null` when there are
 * none. Office users read this, so it names the consequence ("won't be included") rather than
 * describing set arithmetic.
 */
export function hiddenSelectionNote(hiddenCount: number, noun = 'row'): string | null {
  if (hiddenCount <= 0) return null;
  return hiddenCount === 1
    ? `1 selected ${noun} isn't shown here, so it won't be included.`
    : `${hiddenCount} selected ${noun}s aren't shown here, so they won't be included.`;
}
