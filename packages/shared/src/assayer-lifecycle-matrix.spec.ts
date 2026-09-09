import { AssayerLifecycleStatus } from './enums';
import {
  ASSAYER_LIFECYCLE_TRANSITIONS,
  ASSAYER_TERMINAL_LIFECYCLE,
  canTransitionAssayerLifecycle,
  nextAssayerLifecycleStates,
  assayerLifecyclePath,
  ONBOARDING_STAGES,
  DEPARTED_LIFECYCLE_STATES,
} from './assayer-lifecycle';
import { operationalStatusFor } from './assayer-record';

/**
 * THE WHOLE LIFECYCLE GRAPH, WRITTEN OUT BY HAND.
 *
 * `assayer-lifecycle.spec.ts` next door tests the joining stages and the helpers around them. It
 * does not test the graph itself, and the two existing backend specs only sample it — between
 * them they exercise eleven of the twenty-one legal edges and a handful of illegal ones, chosen
 * because somebody had a reason to think about that particular pair. Nothing anywhere asserts
 * what the graph *is*.
 *
 * That gap is not theoretical. The header comment on `ASSAYER_LIFECYCLE_TRANSITIONS` describes
 * three hand-copied frontend versions that were wrong in both directions at once — offering
 * ACTIVE → TERMINATED, which the server refuses, and omitting every → INACTIVE and → ARCHIVED
 * edge, which it allows. Those copies survived because no test ever said "these are the edges,
 * all of them, and nothing else". A test that reads the map and checks the map agrees with
 * itself would have passed against every one of them.
 *
 * So EXPECTED below is written out rather than derived. It is a second, independent statement of
 * the same graph, and its only value is that it was typed from the business rules rather than
 * generated from the code under test. If somebody edits the transition map, this fails and they
 * have to come here and agree, in writing, that the new edge is intended. That is the whole
 * point: the failure is the review.
 *
 * Every ordered pair is covered — 11 × 11 = 121, including the eleven self-transitions, which are
 * illegal and are the pairs a naive `includes` check is most likely to get wrong.
 */

/** The 23 edges the business actually permits, keyed `FROM->TO`. */
const LEGAL_EDGES: ReadonlySet<string> = new Set([
  // Joining. One way in, one stage at a time; the chain cannot be short-circuited.
  'INVITED->DOCUMENT_VERIFICATION',

  // Withdrawing an invitation that was never taken up (2026-09-09). These two edges existed in
  // `AssayerService.operatorRevokeInvitation` long before they existed here — the service wrote
  // ARCHIVED onto the entity while this map still called the move illegal, so the transition
  // endpoint refused it with a 400 at the same moment the recovery endpoint performed it.
  'INVITED->ARCHIVED',
  'DOCUMENT_VERIFICATION->ARCHIVED',
  'DOCUMENT_VERIFICATION->BACKGROUND_VERIFICATION',
  'BACKGROUND_VERIFICATION->TRAINING',
  'TRAINING->ACTIVE',

  // Abandoning the joining chain part-way. Every stage after INVITED can be parked.
  'DOCUMENT_VERIFICATION->INACTIVE',
  'BACKGROUND_VERIFICATION->INACTIVE',
  'TRAINING->INACTIVE',

  // Working life.
  'ACTIVE->ON_LEAVE',
  'ACTIVE->SUSPENDED',
  'ACTIVE->INACTIVE',
  'ACTIVE->RESIGNED',

  // Coming back from something temporary.
  'ON_LEAVE->ACTIVE',
  'ON_LEAVE->INACTIVE',
  'SUSPENDED->ACTIVE',
  'INACTIVE->ACTIVE',

  // Leaving for good. Note the asymmetry: resignation is reachable from ACTIVE, dismissal is
  // not — a termination is only ever reached through a suspension, which is what puts the
  // investigation on the record before the decision.
  'SUSPENDED->TERMINATED',

  // Rehire — back to the START of joining, never straight to work.
  'RESIGNED->INVITED',
  'TERMINATED->INVITED',

  // Filing the record away.
  'INACTIVE->ARCHIVED',
  'RESIGNED->ARCHIVED',
  'TERMINATED->ARCHIVED',
]);

const ALL_STATES = Object.values(AssayerLifecycleStatus);

describe('the assayer lifecycle graph', () => {
  /**
   * The canonical eleven. Pinned because the matrix below is only exhaustive if this list is —
   * a twelfth state added to the enum without a line here would silently go untested, and the
   * "every pair" claim in this file's header would quietly become false.
   */
  it('has exactly the eleven canonical states', () => {
    expect(ALL_STATES).toEqual([
      AssayerLifecycleStatus.INVITED,
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
      AssayerLifecycleStatus.ACTIVE,
      AssayerLifecycleStatus.ON_LEAVE,
      AssayerLifecycleStatus.SUSPENDED,
      AssayerLifecycleStatus.INACTIVE,
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
      AssayerLifecycleStatus.ARCHIVED,
    ]);
  });

  it('permits exactly twenty-three edges and no others', () => {
    const actual = new Set<string>();
    for (const from of ALL_STATES) {
      for (const to of ASSAYER_LIFECYCLE_TRANSITIONS[from] ?? []) actual.add(`${from}->${to}`);
    }
    expect([...actual].sort()).toEqual([...LEGAL_EDGES].sort());
    expect(actual.size).toBe(23);
  });

  /**
   * The exhaustive matrix. One assertion per ordered pair, so a failure names the pair rather
   * than telling you a set comparison went wrong somewhere in 121 elements.
   */
  describe.each(ALL_STATES)('from %s', (from) => {
    it.each(ALL_STATES)(`to %s`, (to) => {
      const expected = LEGAL_EDGES.has(`${from}->${to}`);
      expect(canTransitionAssayerLifecycle(from, to)).toBe(expected);
      expect(nextAssayerLifecycleStates(from).includes(to)).toBe(expected);
    });
  });

  /**
   * Standing still is not a move.
   *
   * Called out separately from the matrix because it is the one class of pair where an
   * implementation can be wrong without any edge being wrong: re-submitting the current status
   * is what a double-clicked button sends, and admitting it would write a second audit row
   * recording a transition from a state to itself.
   */
  it('refuses every self-transition', () => {
    for (const state of ALL_STATES) {
      expect(canTransitionAssayerLifecycle(state, state)).toBe(false);
    }
  });

  it('treats ARCHIVED as the only terminal state', () => {
    expect(ASSAYER_TERMINAL_LIFECYCLE).toEqual([AssayerLifecycleStatus.ARCHIVED]);
    expect(nextAssayerLifecycleStates(AssayerLifecycleStatus.ARCHIVED)).toEqual([]);
    for (const to of ALL_STATES) {
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.ARCHIVED, to)).toBe(false);
    }
    // And nothing else is terminal: every other state can go somewhere.
    for (const from of ALL_STATES) {
      if (from === AssayerLifecycleStatus.ARCHIVED) continue;
      expect(nextAssayerLifecycleStates(from).length).toBeGreaterThan(0);
    }
  });

  /**
   * An unknown string is not a state, and must not behave like one.
   *
   * `canTransitionAssayerLifecycle` takes plain strings — that is deliberate, the status arrives
   * as one from every API payload — so a typo, a legacy value or a probe from a client is a
   * reachable input rather than a type error.
   */
  it('refuses transitions out of, and into, anything that is not a state', () => {
    expect(canTransitionAssayerLifecycle('NOT_A_STATE', AssayerLifecycleStatus.ACTIVE)).toBe(false);
    expect(canTransitionAssayerLifecycle('', AssayerLifecycleStatus.ACTIVE)).toBe(false);
    expect(canTransitionAssayerLifecycle('active', 'ACTIVE')).toBe(false);
    expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.ACTIVE, 'NOT_A_STATE')).toBe(false);
    expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.ACTIVE, 'active')).toBe(false);
    expect(nextAssayerLifecycleStates('NOT_A_STATE')).toEqual([]);
    expect(nextAssayerLifecycleStates(null)).toEqual([]);
    expect(nextAssayerLifecycleStates(undefined)).toEqual([]);
  });
});

/**
 * The pairs people assume are legal and are not.
 *
 * These are already covered by the matrix above. They are restated here, by name, because each
 * one is a rule somebody has previously got wrong in this codebase or would reasonably expect to
 * go the other way — and a named failure ("dismissal cannot be reached directly from ACTIVE")
 * explains itself, where `from ACTIVE > to TERMINATED` in a 121-case matrix does not.
 */
describe('the edges that look legal and are not', () => {
  const NAMED_ILLEGAL: [string, AssayerLifecycleStatus, AssayerLifecycleStatus][] = [
    // The exact edge three frontend copies offered, and the server refused, for as long as they
    // existed. Dismissal goes through suspension.
    ['dismissal cannot be reached directly from ACTIVE', AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED],
    ['a working person cannot be archived in one move', AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ARCHIVED],
    // The second edge those copies offered.
    ['somebody on leave cannot resign without returning first', AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.RESIGNED],
    ['somebody on leave cannot be dismissed while away', AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.TERMINATED],
    ['a suspension cannot be quietly downgraded to inactive', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.INACTIVE],
    ['a suspended person cannot resign out of the investigation', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.RESIGNED],
    ['a suspended person cannot be sent on leave', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.ON_LEAVE],
    ['a suspension cannot be filed away without a decision', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.ARCHIVED],
    // Onboarding cannot be short-circuited. This is the control the lifecycle exists to enforce.
    ['document checks cannot be skipped to activate', AssayerLifecycleStatus.DOCUMENT_VERIFICATION, AssayerLifecycleStatus.ACTIVE],
    ['background checks cannot be skipped to activate', AssayerLifecycleStatus.BACKGROUND_VERIFICATION, AssayerLifecycleStatus.ACTIVE],
    ['an invitation cannot jump the whole chain', AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.ACTIVE],
    ['a trainee cannot resign — they were never on the books', AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.RESIGNED],
    // Coming back is a re-onboarding, never a reinstatement.
    ['a leaver cannot be snapped back to work', AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.ACTIVE],
    ['a dismissed person cannot be snapped back to work', AssayerLifecycleStatus.TERMINATED, AssayerLifecycleStatus.ACTIVE],
    ['a leaver cannot be put on leave', AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.ON_LEAVE],
    // Archived is the end.
    ['an archived record cannot be reactivated', AssayerLifecycleStatus.ARCHIVED, AssayerLifecycleStatus.ACTIVE],
    ['an archived record cannot be re-invited', AssayerLifecycleStatus.ARCHIVED, AssayerLifecycleStatus.INVITED],
    ['an archived record cannot be un-archived to inactive', AssayerLifecycleStatus.ARCHIVED, AssayerLifecycleStatus.INACTIVE],
  ];

  it.each(NAMED_ILLEGAL)('%s', (_name, from, to) => {
    expect(canTransitionAssayerLifecycle(from, to)).toBe(false);
  });
});

/**
 * The legal edges, named for the same reason the illegal ones are.
 */
describe('the edges that must stay legal', () => {
  const NAMED_LEGAL: [string, AssayerLifecycleStatus, AssayerLifecycleStatus][] = [
    ['dismissal is reached from suspension', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.TERMINATED],
    ['a suspension can be lifted', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.ACTIVE],
    ['leave can be ended', AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.ACTIVE],
    ['a parked person can be brought back without re-onboarding', AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.ACTIVE],
    ['a leaver can be rehired, back to the start', AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.INVITED],
    ['a dismissed person can be rehired, back to the start', AssayerLifecycleStatus.TERMINATED, AssayerLifecycleStatus.INVITED],
    ['a leaver can be filed away', AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.ARCHIVED],
    ['a dismissed person can be filed away', AssayerLifecycleStatus.TERMINATED, AssayerLifecycleStatus.ARCHIVED],
    ['a parked person can be filed away', AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.ARCHIVED],
  ];

  it.each(NAMED_LEGAL)('%s', (_name, from, to) => {
    expect(canTransitionAssayerLifecycle(from, to)).toBe(true);
  });
});

/**
 * THE SHAPE OF THE JOINING CHAIN, AND THE ONE WAY OUT OF IT.
 *
 * INVITED used to have exactly one outgoing edge, forward into document verification. An
 * invitation nobody accepted therefore had no lifecycle exit: the only move on offer said
 * something untrue about a person who had never replied, and 79 such records sat on the live
 * roster. The exit existed in `AssayerService.operatorRevokeInvitation`, which wrote ARCHIVED by
 * hand — an edge this map called illegal, so the screens that read this map could not offer it.
 *
 * Both revocation edges are stated here now. The recovery route still exists and still demands a
 * ten-character reason, but it delegates rather than writing the column itself.
 */
describe('the shape of the joining chain', () => {
  it('gives INVITED one way forward and one way to withdraw, and nothing else', () => {
    expect(nextAssayerLifecycleStates(AssayerLifecycleStatus.INVITED)).toEqual([
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.ARCHIVED,
    ]);
  });

  it('lets every later joining stage be parked, but never skipped', () => {
    for (const stage of ONBOARDING_STAGES) {
      if (stage === AssayerLifecycleStatus.INVITED) continue;
      expect(canTransitionAssayerLifecycle(stage, AssayerLifecycleStatus.INACTIVE)).toBe(true);
    }
    // ACTIVE is reachable from the last joining stage and from nowhere earlier in the chain.
    for (const stage of ONBOARDING_STAGES) {
      const expected = stage === AssayerLifecycleStatus.TRAINING;
      expect(canTransitionAssayerLifecycle(stage, AssayerLifecycleStatus.ACTIVE)).toBe(expected);
    }
  });
});

/**
 * Path-finding must not invent edges.
 *
 * `assayerLifecyclePath` is what the roster's bulk action walks, so a path it returns is a
 * sequence of real transitions somebody's employment record will actually receive. The comment
 * on the function describes the defect this guards: a plain shortest-path search sent new joiners
 * to ACTIVE via INACTIVE because that was three hops instead of four, marking people field-ready
 * who had passed neither background verification nor training.
 */
describe('bulk path-finding', () => {
  it('returns only sequences of legal edges, for every reachable pair', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const path = assayerLifecyclePath(from, to);
        if (path === null) continue;
        if (from === to) {
          expect(path).toEqual([]);
          continue;
        }
        // Every consecutive hop is a real edge, and the walk ends where it was asked to.
        let at: string = from;
        for (const step of path) {
          expect(canTransitionAssayerLifecycle(at, step)).toBe(true);
          at = step;
        }
        expect(at).toBe(to);
      }
    }
  });

  it('walks a new joiner through all four joining stages, never around them', () => {
    expect(assayerLifecyclePath(AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.ACTIVE)).toEqual([
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
      AssayerLifecycleStatus.ACTIVE,
    ]);
  });

  /**
   * A REHIRE IS NEVER WALKED FOR YOU.
   *
   * The bulk action can be pointed at ACTIVE with anybody selected, so the path-finder decides
   * whether a departed person gets carried back to work. It used to carry them: `RESIGNED →
   * ACTIVE` resolved to all five hops, and the roster ran them in milliseconds — re-invited,
   * "document verified", "background verified", "trained", active. Nothing was checked. One
   * reason string, or on the API none at all, covered the lot.
   *
   * `RESIGNED/TERMINATED → INVITED` exists precisely because coming back should be slow and
   * deliberate. So INVITED is not a waypoint: it can be a destination, and the chain out of it
   * has to be walked as separate decisions by somebody who is looking at the documents.
   */
  it('will not carry a leaver back to work in one bulk walk', () => {
    for (const departed of [AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.TERMINATED]) {
      expect(assayerLifecyclePath(departed, AssayerLifecycleStatus.ACTIVE)).toBeNull();
      // The rehire itself is still one hop, and still reachable — it is the walk PAST it that is
      // refused, not the move to it.
      expect(assayerLifecyclePath(departed, AssayerLifecycleStatus.INVITED))
        .toEqual([AssayerLifecycleStatus.INVITED]);
    }
  });

  it('finds no way out of ARCHIVED, to anywhere', () => {
    for (const to of ALL_STATES) {
      if (to === AssayerLifecycleStatus.ARCHIVED) continue;
      expect(assayerLifecyclePath(AssayerLifecycleStatus.ARCHIVED, to)).toBeNull();
    }
  });

  /**
   * A DISMISSAL IS NEVER WALKED FOR YOU EITHER.
   *
   * `ACTIVE → TERMINATED` is illegal on purpose: a dismissal is reached only through a suspension,
   * because the suspension is where the investigation goes on the record BEFORE the decision. The
   * path-finder used to route straight through it, because the guard that keeps outcome states
   * out of the middle of a walk was switched off whenever the DESTINATION was itself an outcome —
   * and TERMINATED is one.
   *
   * So "select twelve ACTIVE people → Terminated" was on the roster's menu while the same move on
   * any one of their records was not, and it wrote twelve suspensions nobody had decided on, each
   * lasting milliseconds, each carrying the dismissal's reason verbatim. The control survived as
   * paperwork. SUSPENDED is now never a waypoint in either direction.
   */
  it('will not route a bulk dismissal through a suspension', () => {
    expect(assayerLifecyclePath(AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED)).toBeNull();
    // The suspension itself is still reachable, and so is the dismissal that follows it — as two
    // decisions, which is the whole point.
    expect(assayerLifecyclePath(AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.SUSPENDED))
      .toEqual([AssayerLifecycleStatus.SUSPENDED]);
    expect(assayerLifecyclePath(AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.TERMINATED))
      .toEqual([AssayerLifecycleStatus.TERMINATED]);
  });

  /**
   * The same relaxation, in the case it was actually written for. Nothing is skipped here: a
   * trainee's file genuinely is closed by parking it and then filing it.
   */
  it('closes a trainee file by parking it before filing it', () => {
    expect(assayerLifecyclePath(AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.ARCHIVED)).toEqual([
      AssayerLifecycleStatus.INACTIVE,
      AssayerLifecycleStatus.ARCHIVED,
    ]);
  });
});

/**
 * THE OPERATIONAL PROJECTION, FOR EVERY STATE.
 *
 * `status` is the column every planner filters on, and it is only ever correct if it is derived.
 * The comment on `operationalStatusFor` describes what happened when one writer did not derive it:
 * 536 people who had resigned, been terminated, suspended or gone inactive were operationally
 * ACTIVE and offered as audit candidates.
 *
 * Written out per state rather than as a rule, because the interesting entries are the ones a
 * rule would get wrong — ON_LEAVE is INACTIVE, not ACTIVE, and SUSPENDED is its own value rather
 * than being folded into INACTIVE.
 */
describe('the operational status projection', () => {
  const PROJECTION: [AssayerLifecycleStatus, 'ACTIVE' | 'SUSPENDED' | 'INACTIVE'][] = [
    [AssayerLifecycleStatus.INVITED, 'INACTIVE'],
    [AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'INACTIVE'],
    [AssayerLifecycleStatus.BACKGROUND_VERIFICATION, 'INACTIVE'],
    [AssayerLifecycleStatus.TRAINING, 'INACTIVE'],
    [AssayerLifecycleStatus.ACTIVE, 'ACTIVE'],
    // Leave means "do not offer them work". Folding it into ACTIVE left somebody marked away in
    // HR sitting in the candidate pool and counted as capacity.
    [AssayerLifecycleStatus.ON_LEAVE, 'INACTIVE'],
    [AssayerLifecycleStatus.SUSPENDED, 'SUSPENDED'],
    [AssayerLifecycleStatus.INACTIVE, 'INACTIVE'],
    [AssayerLifecycleStatus.RESIGNED, 'INACTIVE'],
    [AssayerLifecycleStatus.TERMINATED, 'INACTIVE'],
    [AssayerLifecycleStatus.ARCHIVED, 'INACTIVE'],
  ];

  it.each(PROJECTION)('projects %s to %s', (lifecycle, expected) => {
    expect(operationalStatusFor(lifecycle)).toBe(expected);
  });

  /**
   * Exactly one state is deployable.
   *
   * The planner's gate is `isActive && status === 'ACTIVE'` (`DeployabilityFilter`), so this is
   * the list of lifecycle states from which somebody can be sent to a branch. It must be one
   * entry long, and it must be ACTIVE.
   */
  it('makes ACTIVE the only lifecycle state that projects to an operationally active status', () => {
    const deployable = ALL_STATES.filter((s) => operationalStatusFor(s) === 'ACTIVE');
    expect(deployable).toEqual([AssayerLifecycleStatus.ACTIVE]);
  });

  it('never projects an unknown status onto an unknown lifecycle value', () => {
    expect(operationalStatusFor('NOT_A_STATE')).toBe('INACTIVE');
    expect(operationalStatusFor(null)).toBe('INACTIVE');
    expect(operationalStatusFor(undefined)).toBe('INACTIVE');
    expect(operationalStatusFor('')).toBe('INACTIVE');
  });
});

/**
 * Who counts as having left.
 *
 * INACTIVE is deliberately absent — it covers people who are still employed but not available
 * right now. The distinction decides whether the roster chases somebody for their bank details.
 */
describe('departure classification', () => {
  it('counts resignation, dismissal and archival as having left, and nothing else', () => {
    expect([...DEPARTED_LIFECYCLE_STATES].sort()).toEqual([
      AssayerLifecycleStatus.ARCHIVED,
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
    ].sort());
    for (const s of [
      AssayerLifecycleStatus.INACTIVE,
      AssayerLifecycleStatus.SUSPENDED,
      AssayerLifecycleStatus.ON_LEAVE,
      AssayerLifecycleStatus.ACTIVE,
      ...ONBOARDING_STAGES,
    ]) {
      expect(DEPARTED_LIFECYCLE_STATES.includes(s)).toBe(false);
    }
  });
});
