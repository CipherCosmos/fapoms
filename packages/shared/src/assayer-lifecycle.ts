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
  /**
   * The revocation edges (2026-09-09). INVITED used to have exactly one way out — forward, into
   * document verification — so an invitation nobody ever accepted could not be closed through the
   * lifecycle at all. The only lifecycle move available said something untrue about a person who
   * had never replied, and 79 such records were sitting on the live roster.
   *
   * The way out existed, but it was hidden: `AssayerService.operatorRevokeInvitation` wrote
   * `lifecycleStatus = ARCHIVED` straight onto the entity, from INVITED or DOCUMENT_VERIFICATION,
   * bypassing this map entirely. So the system held two contradictory beliefs at once — the
   * transition endpoint refused the move with a 400 while the recovery endpoint performed it, and
   * the UI, which reads this map to decide what to offer, could not know the edge existed.
   *
   * Stated here instead. The revoke route still exists and still demands its substantive reason,
   * but it now delegates to the lifecycle authority like everything else, and the roster can
   * offer the move directly.
   */
  [AssayerLifecycleStatus.INVITED]: [
    AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
    AssayerLifecycleStatus.ARCHIVED,
  ],
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [
    AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
    AssayerLifecycleStatus.INACTIVE,
    AssayerLifecycleStatus.ARCHIVED,
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
  /**
   * The rehire edge (2026-09-07). Until now RESIGNED and TERMINATED led only to ARCHIVED — no
   * path ever returned to work, so a genuine rehire (people do come back) was impossible
   * without raw SQL. Rehiring restarts onboarding from INVITED on purpose: identity was
   * verified against documents that may have expired, bank details go stale, and a termination
   * usually happened for a reason someone should re-examine — so the person walks the whole
   * document → background → training path again rather than snapping straight back to ACTIVE
   * (which is precisely the shortcut INACTIVE → ACTIVE already takes, deliberately, for people
   * who never actually left).
   */
  [AssayerLifecycleStatus.RESIGNED]: [
    AssayerLifecycleStatus.INVITED,
    AssayerLifecycleStatus.ARCHIVED,
  ],
  [AssayerLifecycleStatus.TERMINATED]: [
    AssayerLifecycleStatus.INVITED,
    AssayerLifecycleStatus.ARCHIVED,
  ],
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
 * States a route may END at but never PASS THROUGH, in either direction.
 *
 * Each of these is a decision somebody has to make and answer for, not a corridor. A bulk action
 * that walks one of them has manufactured that decision on the operator's behalf and stamped the
 * destination's reason onto it.
 *
 * Two of these were added after the lifecycle certification found the bulk route reaching, in one
 * call, edges the single-transition route refuses outright:
 *
 *   SUSPENDED — `ACTIVE → TERMINATED` is illegal by design: a dismissal is reached only through a
 *     suspension, because the suspension is where the investigation goes on the record BEFORE the
 *     decision. The path-finder was routing straight through it, so "select twelve people → set
 *     them Terminated" wrote twelve suspensions nobody had decided on, each lasting milliseconds
 *     and each carrying the dismissal's reason verbatim. The control survived on paper only.
 *
 *   INVITED — the rehire edge. `RESIGNED/TERMINATED → INVITED` exists so somebody coming back
 *     walks the whole document → background → training chain again; see the map above for why.
 *     Traversing it made `RESIGNED → ACTIVE` a single bulk call that flipped through all five
 *     hops in milliseconds, verifying nothing. Re-onboarding cannot be a corridor to anywhere.
 *
 * INACTIVE is deliberately NOT here. It has a genuine corridor use on the way out — closing a
 * trainee's file really is TRAINING → INACTIVE → ARCHIVED, and nothing is skipped by taking it —
 * which is what the `leaving` relaxation below exists for.
 *
 * ## OPEN, and deliberately not decided here: ACTIVE is still a waypoint
 *
 * Measured against the running system on 2026-09-10. A bulk `INVITED → SUSPENDED` routes
 * INVITED → DOCUMENT_VERIFICATION → INACTIVE → ACTIVE → SUSPENDED and writes all four hops:
 *
 *     INVITED -> DOCUMENT_VERIFICATION
 *     DOCUMENT_VERIFICATION -> INACTIVE
 *     INACTIVE -> ACTIVE          ← background verification and training never happened
 *     ACTIVE -> SUSPENDED
 *
 * The same shape reaches ACTIVE on the way to SUSPENDED or RESIGNED from INVITED,
 * DOCUMENT_VERIFICATION, BACKGROUND_VERIFICATION and INACTIVE, and on the way from SUSPENDED to
 * ARCHIVED — where it also reinstates a suspension nobody decided to lift. Activation is not a
 * corridor by any reading of the paragraph above: it has its own precondition method
 * (`assertCanActivate`), its own identity gate, and its own `ASSAYER_ONBOARDED` notification,
 * which really is emitted for a person who is about to be suspended.
 *
 * It is NOT added to the list here because that is a decision about the transition graph — it
 * would withdraw those targets from the roster's bulk toolbar, which offers whatever this
 * function can reach — and this file is not where that call should be made silently. What HAS
 * changed is that the walk is no longer invisible: `bulkTransitionLifecycle` reports the route it
 * took in `via`, so the response above says `["DOCUMENT_VERIFICATION","INACTIVE","ACTIVE",
 * "SUSPENDED"]` rather than just "INVITED → SUSPENDED, succeeded".
 */
const NEVER_A_WAYPOINT: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.INVITED,
  AssayerLifecycleStatus.SUSPENDED,
  AssayerLifecycleStatus.RESIGNED,
  AssayerLifecycleStatus.TERMINATED,
  AssayerLifecycleStatus.ARCHIVED,
];

/**
 * States that are an outcome rather than a step, and so may only be passed through when the
 * destination is itself an outcome — i.e. on the way out of the workforce, never back into it.
 */
const NOT_A_WAYPOINT_INBOUND: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.INACTIVE,
];

/** Destinations that make a walk an exit rather than a return. */
const OUTCOME_DESTINATIONS: AssayerLifecycleStatus[] = [
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
 *
 * ## A path is a PLAN, not a promise
 *
 * This answers "which edges connect these two states", and nothing more. It does not know whether
 * the caller holds the reason each hop demands, whether the identity gate will admit an
 * activation, or whether somebody else is moving the same person right now. `bulkTransitionLifecycle`
 * rehearses the whole plan against those rules before it takes the first hop, precisely because a
 * route that is legal edge-by-edge can still be refused part way — and half a walk is not a state
 * this domain can undo. See the contract docblock there.
 */
export function assayerLifecyclePath(from: string, to: string): AssayerLifecycleStatus[] | null {
  if (from === to) return [];
  const leaving = OUTCOME_DESTINATIONS.includes(to as AssayerLifecycleStatus);
  const queue: Array<{ state: string; path: AssayerLifecycleStatus[] }> = [{ state: from, path: [] }];
  const seen = new Set<string>([from]);

  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    for (const next of ASSAYER_LIFECYCLE_TRANSITIONS[state] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      // A decision is never a corridor, whichever way the walk is heading.
      if (NEVER_A_WAYPOINT.includes(next)) continue;
      // An outcome may be passed through on the way out, never on the way back in.
      if (!leaving && NOT_A_WAYPOINT_INBOUND.includes(next)) continue;
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

/**
 * How long a lifecycle reason may be.
 *
 * Lives here because three places need the same number and no two of them may import each other:
 * the controller decorates `TransitionLifecycleDto` with it, `AssayerService` enforces it again at
 * the authority boundary — where the recovery routes and any in-process caller arrive without
 * having passed a DTO — and the transition modals now stop the operator at the same point rather
 * than letting the server be the first to mention it.
 *
 * That last one is why it moved out of the backend. The frontend could not import a backend
 * module, so it did not know there was a limit at all: somebody could write several pages of
 * justification for a termination and have the whole thing rejected on submit, with the length
 * named for the first time in the error.
 *
 * Two thousand characters, which is several paragraphs and the ceiling this codebase already uses
 * for free text of this kind. Before there was one, `reason` was `@IsOptional() @IsString()`
 * against a 50 MB body limit: a 200,000-character reason was accepted in 92 ms and stored in FULL
 * twice — once in `audit_events.remarks`, once in `assayer_activities.remarks` — and a
 * one-megabyte one did the same. `audit_events` is append-only by database trigger, so none of it
 * could ever be reclaimed. Any holder of `assayer:edit:organization` could do it in a loop.
 */
export const LIFECYCLE_REASON_MAX_LENGTH = 2000;
