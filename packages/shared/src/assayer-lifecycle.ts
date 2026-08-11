import { AssayerLifecycleStatus } from './enums';

/**
 * The assayer lifecycle, stated once for the whole platform.
 *
 * This map existed in four places: the backend state machine, which enforces it, and three
 * hand-copied frontend versions in AssayerRoster, AssayerDetailDrawer and AssayerProfile. All
 * three copies were wrong in the same two directions, and both directions hurt:
 *
 *   - They OFFERED transitions the backend rejects — ACTIVE → TERMINATED and ON_LEAVE →
 *     RESIGNED — so HR was shown buttons that could only ever return 400. On the roster this
 *     was worse than one failed click: the bulk action plans a route between states, so a
 *     multi-step path through a non-existent edge failed part-way and left the batch split.
 *   - They OMITTED transitions the backend allows: every → INACTIVE edge, and every → ARCHIVED
 *     edge. An HR manager therefore could not archive a leaver at all, and could not mark
 *     someone inactive part-way through onboarding, even though the backend supports both.
 *
 * Both sides now import this. A change to the lifecycle is one edit, and the UI cannot offer
 * something the server will refuse.
 */
export const ASSAYER_LIFECYCLE_TRANSITIONS: Record<string, AssayerLifecycleStatus[]> = {
  [AssayerLifecycleStatus.INVITED]: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [
    AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
    AssayerLifecycleStatus.INACTIVE,
  ],
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [
    AssayerLifecycleStatus.TRAINING,
    AssayerLifecycleStatus.INACTIVE,
  ],
  [AssayerLifecycleStatus.TRAINING]: [
    AssayerLifecycleStatus.ACTIVE,
    AssayerLifecycleStatus.INACTIVE,
  ],
  [AssayerLifecycleStatus.ACTIVE]: [
    AssayerLifecycleStatus.ON_LEAVE,
    AssayerLifecycleStatus.SUSPENDED,
    AssayerLifecycleStatus.INACTIVE,
    AssayerLifecycleStatus.RESIGNED,
  ],
  [AssayerLifecycleStatus.ON_LEAVE]: [
    AssayerLifecycleStatus.ACTIVE,
    AssayerLifecycleStatus.INACTIVE,
  ],
  [AssayerLifecycleStatus.SUSPENDED]: [
    AssayerLifecycleStatus.ACTIVE,
    AssayerLifecycleStatus.TERMINATED,
  ],
  [AssayerLifecycleStatus.INACTIVE]: [
    AssayerLifecycleStatus.ACTIVE,
    AssayerLifecycleStatus.ARCHIVED,
  ],
  [AssayerLifecycleStatus.RESIGNED]: [AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.TERMINATED]: [AssayerLifecycleStatus.ARCHIVED],
};

/** States an assayer can never leave — nothing further is offered from here. */
export const ASSAYER_TERMINAL_LIFECYCLE: AssayerLifecycleStatus[] = [AssayerLifecycleStatus.ARCHIVED];

export function nextAssayerLifecycleStates(from?: string | null): AssayerLifecycleStatus[] {
  if (!from) return [];
  return ASSAYER_LIFECYCLE_TRANSITIONS[from] ?? [];
}

export function canTransitionAssayerLifecycle(from: string, to: string): boolean {
  return (ASSAYER_LIFECYCLE_TRANSITIONS[from] ?? []).includes(to as AssayerLifecycleStatus);
}

/**
 * Shortest sequence of legal transitions from one state to another, or null when no path
 * exists. The roster uses this to carry out a bulk change that needs several hops — moving
 * someone from TRAINING to ARCHIVED, say — without inventing edges to get there.
 */
export function assayerLifecyclePath(from: string, to: string): AssayerLifecycleStatus[] | null {
  if (from === to) return [];
  const queue: Array<{ state: string; path: AssayerLifecycleStatus[] }> = [{ state: from, path: [] }];
  const seen = new Set<string>([from]);

  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    for (const next of ASSAYER_LIFECYCLE_TRANSITIONS[state] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ state: next, path: nextPath });
    }
  }
  return null;
}
