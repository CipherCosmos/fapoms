import { useRef } from 'react';
import { PanResponder } from 'react-native';
import * as haptics from '../lib/haptics';

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
 */
export function useSwipeSegments<T extends string>(order: readonly T[], current: T, onChange: (next: T) => void) {
  return useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > 24 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderRelease: (_, gesture) => {
        const i = order.indexOf(current);
        if (i === -1) return;
        // Content-follows-finger: swipe LEFT (negative dx) advances to the next option, matching
        // the app-level tab swipe's own direction convention.
        const next = gesture.dx < 0 ? order[i + 1] : order[i - 1];
        if (!next) return; // Already at the first/last option.
        haptics.select();
        onChange(next);
      },
    })
  ).current;
}
