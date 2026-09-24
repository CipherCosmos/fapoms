/**
 * The decisions behind `useSwipeSegments`, kept free of React Native so they can be tested.
 */

/** Same thresholds as the app-level tab swipe: clearly horizontal, and far enough to mean it. */
export function isHorizontalSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/**
 * Where a swipe goes from `current`, or `null` when there is nowhere to go (already at the first
 * or last option, or `current` is not one of the options).
 *
 * Content-follows-finger: a swipe LEFT (negative dx) moves to the next option, matching the
 * app-level tab swipe's own direction.
 */
export function nextSegment<T extends string>(order: readonly T[], current: T, dx: number): T | null {
  const i = order.indexOf(current);
  if (i === -1) return null;
  const next = dx < 0 ? order[i + 1] : order[i - 1];
  return next ?? null;
}

/**
 * Whether the segment control should claim this swipe at all.
 *
 * Only when it can act on it. A swipe past the first or last option is left unclaimed so the
 * app-level tab swipe underneath gets it — claiming it and then doing nothing is what made the
 * bottom tabs unreachable by swiping from these screens.
 */
export function shouldClaimSwipe<T extends string>(order: readonly T[], current: T, dx: number, dy: number): boolean {
  return isHorizontalSwipe(dx, dy) && nextSegment(order, current, dx) !== null;
}
