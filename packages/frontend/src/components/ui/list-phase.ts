/**
 * Which of four things a list is doing, decided in one place.
 *
 * Screens here each answered this differently and mostly wrongly. The branches table replaced
 * itself with a line of text whenever it refetched, so the answer you were reading vanished the
 * moment you narrowed it — and because its load was debounced, for the first quarter-second it
 * rendered its *empty state* to someone who had just opened the page: "No branches to show —
 * clear your search and filters if you expected to see some", to a person who had set neither.
 *
 * An empty result and a result that has not arrived are different things and must never look
 * the same. That is the whole rule; these are the four cases it produces.
 */
export type ListPhase =
  /** Nothing on screen and nothing to show yet — draw the shape of the list. */
  | 'skeleton'
  /** Rows on screen, a narrower set on the way — keep them, dim them. */
  | 'refreshing'
  /** The answer arrived and it is genuinely empty. */
  | 'empty'
  /** The answer arrived and there are rows. */
  | 'ready';

export function listPhase(state: { loading: boolean; rowCount: number }): ListPhase {
  const { loading, rowCount } = state;
  if (loading) return rowCount > 0 ? 'refreshing' : 'skeleton';
  return rowCount > 0 ? 'ready' : 'empty';
}
