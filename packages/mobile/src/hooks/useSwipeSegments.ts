import { useRef } from 'react';
import { PanResponder } from 'react-native';
import * as haptics from '../lib/haptics';
import { nextSegment, shouldClaimSwipe } from './swipe-segments';

/**
 * Swipe left/right to move between a screen's own `Segmented` options — e.g. ScheduleScreen's
 * Active/History, QueriesScreen's Open/Resolved.
 *
 * Deliberately the same shape as App.tsx's main tab-swipe responder (same thresholds, same
 * content-follows-finger direction), but attached lower in the tree. React Native's touch
 * responder system asks the deepest node first: because this uses the plain (bubble-phase)
 * `onMoveShouldSetPanResponder` — not the `...Capture` variant — and is mounted inside the
 * screen's own content rather than on App.tsx's outer wrapper, it gets first refusal on a swipe
 * that happens over this screen, and the app-level tab swipe only ever sees a gesture this one
 * chose not to claim. Without that ordering, a swipe on either of these screens jumped the whole
 * app to a different bottom-dock tab instead of switching the segment under the user's finger.
 *
 * The responder is built once (PanResponder handlers are not re-bound on render), so it reads the
 * options, the current segment and the callback through refs updated on every render. It used to
 * close over the values from the first render: `current` stayed the first segment for ever, so a
 * swipe reached the second segment and could never come back, and every swipe was claimed — which
 * also kept the app-level tab swipe from ever seeing one on these screens.
 */
export function useSwipeSegments<T extends string>(order: readonly T[], current: T, onChange: (next: T) => void) {
  const orderRef = useRef(order);
  const currentRef = useRef(current);
  const onChangeRef = useRef(onChange);
  orderRef.current = order;
  currentRef.current = current;
  onChangeRef.current = onChange;

  return useRef(
    PanResponder.create({
      // Claimed only when there is a segment to move to; past either end the swipe is left for the
      // app-level tab swipe.
      onMoveShouldSetPanResponder: (_, gesture) =>
        shouldClaimSwipe(orderRef.current, currentRef.current, gesture.dx, gesture.dy),
      onPanResponderRelease: (_, gesture) => {
        const next = nextSegment(orderRef.current, currentRef.current, gesture.dx);
        if (!next) return;
        haptics.select();
        onChangeRef.current(next);
      },
    })
  ).current;
}
