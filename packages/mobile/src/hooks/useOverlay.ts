import { useCallback, useMemo, useState } from 'react';
import type { AssayerAssignment } from '../types/mobile-app';

/**
 * Which overlay is open, and what it is open on.
 *
 * The app has ten of these — scanner, chat, navigation, decline, counter-offer, expense claim,
 * issue report, availability, feedback, notifications — and each one used to carry its own pair
 * of state variables in App.tsx: a boolean for whether it was showing and a nullable assignment
 * for what it was showing it for. Fourteen `useState` calls describing a single question.
 *
 * That shape allowed states that mean nothing. `visible` true with a null assignment rendered a
 * modal about no job; an assignment set with `visible` false held a stale reference to a job the
 * assayer had moved on from; and nothing prevented two modals believing they were open at once,
 * which is why several of the render sites had to guard on the flag *and* the subject together.
 * The inconsistency showed: some overlays used a flag plus a subject, others used the subject
 * alone as an implicit flag, and no reader could tell which without checking each one.
 *
 * One nullable tagged union answers the question once. Only one overlay can be open, because only
 * one value can be held; an overlay that needs a subject cannot be opened without one, because
 * the type says so; and opening any overlay closes whatever was open, which is what every call
 * site was already doing by hand.
 */
export type Overlay =
  | { name: 'scanner'; assignment: AssayerAssignment }
  | { name: 'queryChat'; assignment: AssayerAssignment }
  | { name: 'navigate'; assignment: AssayerAssignment }
  | { name: 'negotiate'; assignment: AssayerAssignment }
  | { name: 'issue'; assignment: AssayerAssignment }
  /**
   * The reason lives here rather than beside it, so it is scoped to the decline it was typed
   * for. Held separately, it survived a cancel: typing "branch is shut" against one offer,
   * backing out, then declining a different one pre-filled the box with the first job's reason.
   */
  | { name: 'reject'; assignmentId: string; reason: string }
  /**
   * Nullable on purpose. Filed from the Earnings tab there may be no assignment in progress to
   * attach the claim to, and the modal explains that rather than guessing at one.
   */
  | { name: 'expense'; assignment: AssayerAssignment | null }
  | { name: 'availability' }
  | { name: 'feedback' }
  | { name: 'notifications' }
  /** The durable upload outbox — carries no subject; it lists every packet, across branches. */
  | { name: 'uploads' };

export type OverlayName = Overlay['name'];

export interface OverlayController {
  open: (overlay: Overlay) => void;
  close: () => void;
  /**
   * The open overlay if it is the one named, otherwise null — narrowed, so the render site gets
   * the subject without re-asserting that it exists.
   */
  current: <N extends OverlayName>(name: N) => Extract<Overlay, { name: N }> | null;
  /** Replace the open overlay in place. For editing a field the overlay itself owns. */
  update: (patch: (overlay: Overlay) => Overlay) => void;
}

export function useOverlay(): OverlayController {
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  const open = useCallback((next: Overlay) => setOverlay(next), []);
  const close = useCallback(() => setOverlay(null), []);
  const update = useCallback(
    (patch: (o: Overlay) => Overlay) => setOverlay((o) => (o ? patch(o) : o)),
    [],
  );

  const current = useCallback(
    <N extends OverlayName>(name: N) =>
      overlay?.name === name ? (overlay as Extract<Overlay, { name: N }>) : null,
    [overlay],
  );

  /**
   * `open`, `close` and `update` keep a stable identity across the whole session, so an effect
   * that only needs to *open* something can depend on the opener alone and not be re-run every
   * time some unrelated modal is dismissed. The controller as a whole changes when the open
   * overlay does, because `current` has to.
   */
  return useMemo(() => ({ open, close, current, update }), [open, close, current, update]);
}
