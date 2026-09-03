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

/**
 * The joining stages, in the order they are walked — the four an assayer passes through before
 * they may be given work.
 *
 * `AssayerService.create` opens every new profile at INVITED, and the planner deliberately pulls
 * candidates in these stages into its pool so it can say what is wrong rather than returning "no
 * assayers found" for somebody who was added minutes ago. They are still excluded from the
 * eligible list — dispatching unverified, untrained people is the control the lifecycle exists to
 * enforce.
 */
export const ONBOARDING_STAGES: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.INVITED,
  AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
  AssayerLifecycleStatus.TRAINING,
];

/**
 * Is this person still joining?
 *
 * A predicate rather than leaving every caller to write `ONBOARDING_STAGES.includes(x)`: the
 * lifecycle status arrives as a plain `string` from an API payload almost everywhere it is asked
 * about, and an array of the enum cannot be `.includes`-ed with one without a cast at each site.
 * Casts at call sites are where a list like this quietly acquires a second, laxer meaning.
 */
export function isOnboardingStage(lifecycleStatus?: string | null): boolean {
  return !!lifecycleStatus && (ONBOARDING_STAGES as string[]).includes(lifecycleStatus);
}

/**
 * WHAT BLOCKS ACTIVATION, stated once for the whole platform.
 *
 * This map lived in two places — `recommendation.engine.ts`, where the planner prints it when it
 * refuses to offer an unfinished joiner work, and a hand-copied version in the frontend's
 * `assayer-shared.ts` — with a spec pinning the strings on the frontend side to keep the two in
 * step. A copy with a test holding it still is not one implementation: the test fails *after*
 * somebody has edited one side, and it can only ever guard the strings, not the four keys or the
 * stage list they are drawn from.
 *
 * The sentence matters because it is read at both ends of one journey. A coordinator is told on
 * the planning screen "Onboarding not finished: in training — mark training complete on the HR
 * roster to activate", follows that instruction to the HR roster, and must find the same words
 * waiting there. Two copies is two chances for the roster to ask for something the planner did
 * not.
 *
 * Phrased to be read mid-sentence after "Onboarding not finished:" and after "they are", which is
 * why each entry starts lowercase and names the stage before the instruction.
 */
export const ONBOARDING_NEXT_STEP: Record<string, string> = {
  [AssayerLifecycleStatus.INVITED]: 'invited — start document verification on the HR roster',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'in document verification — complete it on the HR roster',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'in background verification — complete it on the HR roster',
  [AssayerLifecycleStatus.TRAINING]: 'in training — mark training complete on the HR roster to activate',
};

/** The next-step sentence for somebody still joining, or null once they are past it. */
export function onboardingNextStep(lifecycleStatus?: string | null): string | null {
  if (!lifecycleStatus) return null;
  return ONBOARDING_NEXT_STEP[lifecycleStatus] ?? null;
}

/**
 * The one move that carries somebody FORWARD through joining — the thing the sentence above is
 * asking for — or null when they are not joining, or are joining but cannot advance.
 *
 * Derived from the stage order and then checked against the transition map, rather than written
 * out as a fifth list. The two are statements of the same thing and this is the only place they
 * are held against each other: if a stage is added to the chain without an edge to match, this
 * returns null and the screen falls back to offering the legal moves plainly, instead of putting a
 * button on screen that can only ever return 400.
 *
 * It exists so the HR record can offer that step as a button. Walking a new joiner to ACTIVE was
 * four separate picks from a dropdown of filing states, each one requiring the clerk to already
 * know which of them came next — while the planner had been printing that answer at them the whole
 * time. Naming the step is not the same as taking it: nothing here advances anybody, and it is
 * deliberately one button per decision rather than one button for the whole chain.
 */
export function nextOnboardingStep(from?: string | null): AssayerLifecycleStatus | null {
  if (!isOnboardingStage(from)) return null;
  const at = (ONBOARDING_STAGES as string[]).indexOf(from as string);
  const forward = ONBOARDING_STAGES[at + 1] ?? AssayerLifecycleStatus.ACTIVE;
  return nextAssayerLifecycleStates(from).includes(forward) ? forward : null;
}

export function nextAssayerLifecycleStates(from?: string | null): AssayerLifecycleStatus[] {
  if (!from) return [];
  return ASSAYER_LIFECYCLE_TRANSITIONS[from] ?? [];
}

export function canTransitionAssayerLifecycle(from: string, to: string): boolean {
  return (ASSAYER_LIFECYCLE_TRANSITIONS[from] ?? []).includes(to as AssayerLifecycleStatus);
}

/**
 * States that are an outcome, not a step on the way to somewhere else.
 *
 * Being deactivated, suspended, resigned or terminated is a thing that happened to someone; it is
 * never a stage passed through en route to another. They remain valid destinations — just not
 * waypoints.
 */
const NOT_A_WAYPOINT: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.INACTIVE,
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
];

/**
 * Shortest sequence of legal transitions from one state to another, or null when no path exists.
 * The roster uses this to carry out a bulk change that needs several hops, without inventing
 * edges to get there.
 *
 * An outcome state may not be passed through on the way *back in*. A plain shortest-path search
 * sent a new joiner to ACTIVE via INVITED → DOCUMENT_VERIFICATION → INACTIVE → ACTIVE, because
 * that is three hops where the real onboarding chain is four — so moving a batch of new joiners
 * to ACTIVE skipped background verification and training entirely, marking people field-ready who
 * had passed neither, and recorded a deactivation and reinstatement that never happened.
 *
 * On the way *out* they are still traversable, because there they are the designed route rather
 * than a shortcut: closing a trainee's file really does go TRAINING → INACTIVE → ARCHIVED, and
 * nothing is skipped by taking it.
 */
export function assayerLifecyclePath(from: string, to: string): AssayerLifecycleStatus[] | null {
  if (from === to) return [];
  const leaving = NOT_A_WAYPOINT.includes(to as AssayerLifecycleStatus);
  const queue: Array<{ state: string; path: AssayerLifecycleStatus[] }> = [{ state: from, path: [] }];
  const seen = new Set<string>([from]);

  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    for (const next of ASSAYER_LIFECYCLE_TRANSITIONS[state] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      if (!leaving && NOT_A_WAYPOINT.includes(next)) continue;
      seen.add(next);
      queue.push({ state: next, path: nextPath });
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Has this person left the workforce?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle values that mean somebody has gone.
 *
 * INACTIVE is deliberately absent: it is the catch-all for "not available right now" and covers
 * people who are still employed — no work in their area, a lapsed certification, a pause. Only the
 * one INACTIVE case below counts as having left.
 */
export const DEPARTED_LIFECYCLE_STATES: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
];

/**
 * Has this person left, by their status rather than their dates?
 *
 * ## Why this is in shared, and what it cost to find out
 *
 * This rule existed in three places: a SQL fragment in `hr-workforce.service.ts`, a predicate in
 * `data-integrity.service.ts`, and the roster's `stillWorkable` in the web app. The deceased arm
 * was added to the two backend copies and never reached the third, so one man — recorded as having
 * died, with no leaving date — stayed on the roster's worklists, where the screen asked a clerk to
 * chase his missing bank details. Nothing failed; two of three copies were simply newer than the
 * third.
 *
 * ## The awkward case this exists for
 *
 * A death is not a lifecycle value. It is filed as INACTIVE with `unavailableReason = 'DECEASED'`,
 * because the reason column is where the roster import put it and INACTIVE is where such a record
 * lands. So "has left" cannot be read off `lifecycleStatus` alone, which is exactly the shortcut
 * each of the three copies took at first.
 *
 * ## What this does NOT answer
 *
 * Only the status question. Somebody can also have left by carrying an exit or termination date
 * while their lifecycle was never moved — 25 people on the live roster are the mirror image, with a
 * departed lifecycle and no date at all. Callers that own both facts should ask this AND the dates;
 * `ON_ROSTER` in the backend and `stillWorkable` in the web app both do.
 *
 * The SQL fragment cannot import this function. `has-left-parity.spec.ts` fails if the two drift.
 */
export function hasLeftWorkforce(person: {
  lifecycleStatus?: string | null;
  unavailableReason?: string | null;
}): boolean {
  const lifecycle = (person.lifecycleStatus ?? '') as AssayerLifecycleStatus;
  if (DEPARTED_LIFECYCLE_STATES.includes(lifecycle)) return true;
  return lifecycle === AssayerLifecycleStatus.INACTIVE
    && String(person.unavailableReason ?? '').toUpperCase() === 'DECEASED';
}
