import {
  AssayerLifecycleStatus, assayerLifecyclePath, assayerLifecycleBlockedBy,
  canTransitionAssayerLifecycle, operationalStatusFor,
} from '@fapoms/shared';
import { AssayerStateMachine } from './assayer.state-machine';

/**
 * A BULK WALK MAY NOT INVENT AN ACTIVATION.
 *
 * Until 2026-09-11 a bulk `INVITED → SUSPENDED` routed
 * `INVITED → DOCUMENT_VERIFICATION → INACTIVE → ACTIVE → SUSPENDED` and wrote all four hops. The
 * third one is the defect: background verification and training never happened, the identity gate
 * was never asked, `ASSAYER_ONBOARDED` was dispatched for somebody about to be suspended, and the
 * employment record — in an append-only audit trail — ended up holding an ACTIVE row for a person
 * who was never activated.
 *
 * ACTIVE is the one lifecycle value that projects to a deployable person
 * (`operationalStatusFor`), which is why an ACTIVE hop is not a filing detail. The whole lifecycle
 * exists to gate that one state.
 *
 * These cases hold the fix at the level it was made — the transition graph — rather than at the
 * level of what the response says about it. Reporting the walk in `via` was the previous
 * mitigation, and a truthful account of a fabricated activation is still a fabricated activation.
 */
describe('ACTIVE is never a waypoint', () => {
  const ALL = Object.values(AssayerLifecycleStatus);

  /**
   * The general statement, over all 121 ordered pairs. Anything weaker is a list of the examples
   * somebody happened to think of — and this defect was found in one direction and lived on in
   * five others.
   */
  it('never routes any walk through ACTIVE, for any pair of states', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const path = assayerLifecyclePath(from, to);
        if (path === null || path.length === 0) continue;
        const through = path.slice(0, -1);
        expect({ from, to, through }).toEqual({ from, to, through: through.filter((s) => s !== AssayerLifecycleStatus.ACTIVE) });
      }
    }
  });

  /** And ACTIVE is still perfectly reachable as a destination — it is the corridor use that went. */
  it('still reaches ACTIVE as a destination, by the full joining chain', () => {
    expect(assayerLifecyclePath(AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.ACTIVE)).toEqual([
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
      AssayerLifecycleStatus.ACTIVE,
    ]);
    expect(assayerLifecyclePath(AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.ACTIVE))
      .toEqual([AssayerLifecycleStatus.ACTIVE]);
    expect(assayerLifecyclePath(AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.ACTIVE))
      .toEqual([AssayerLifecycleStatus.ACTIVE]);
    expect(assayerLifecyclePath(AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.ACTIVE))
      .toEqual([AssayerLifecycleStatus.ACTIVE]);
  });

  /**
   * The named cases, each one a walk that used to commit an unearned activation. They are written
   * out rather than folded into the sweep above because a failure here says which workflow broke.
   */
  it.each([
    ['an invitation cannot be suspended', AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.SUSPENDED],
    ['an invitation cannot resign', AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.RESIGNED],
    ['a document check cannot be suspended', AssayerLifecycleStatus.DOCUMENT_VERIFICATION, AssayerLifecycleStatus.SUSPENDED],
    ['a background check cannot resign', AssayerLifecycleStatus.BACKGROUND_VERIFICATION, AssayerLifecycleStatus.RESIGNED],
    ['a trainee cannot be suspended', AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.SUSPENDED],
    ['a parked record cannot be suspended', AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.SUSPENDED],
    ['somebody on leave cannot be suspended without coming back first', AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.SUSPENDED],
    ['somebody on leave cannot resign without coming back first', AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.RESIGNED],
    // The one that also reinstated a suspension nobody had decided to lift.
    ['a suspension cannot be filed away by quietly reinstating it', AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.ARCHIVED],
  ])('%s', (_name, from, to) => {
    expect(assayerLifecyclePath(from, to)).toBeNull();
    // The single-transition route refuses it too. That is the whole principle: the bulk toolbar
    // must not be able to reach what the one-record screen cannot.
    expect(canTransitionAssayerLifecycle(from, to)).toBe(false);
  });

  /**
   * PARITY, stated as a rule rather than as nine examples.
   *
   * Every destination the bulk walk can reach must be one the state machine will actually let
   * somebody arrive at, hop by hop. The previous defect was precisely a bulk route that reached
   * an edge the single route refuses.
   */
  it('offers no destination whose route the single-transition rules would refuse', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const path = assayerLifecyclePath(from, to);
        if (path === null) continue;
        let at: string = from;
        for (const hop of path) {
          expect({ from, to, hop, at, legal: canTransitionAssayerLifecycle(at, hop) })
            .toMatchObject({ legal: true });
          at = hop;
        }
      }
    }
  });

  /** The deployable projection, restated here because it is what makes an ACTIVE hop serious. */
  it('keeps ACTIVE the only deployable state, which is why it may not be walked through', () => {
    expect(ALL.filter((s) => operationalStatusFor(s) === 'ACTIVE'))
      .toEqual([AssayerLifecycleStatus.ACTIVE]);
  });

  /** The state machine the service actually calls is the same function, not a copy of it. */
  it('is the same answer through AssayerStateMachine.findPathTo', () => {
    expect(AssayerStateMachine.findPathTo('INVITED', 'SUSPENDED')).toBeNull();
    expect(AssayerStateMachine.findPathTo('ON_LEAVE', 'RESIGNED')).toBeNull();
    expect(AssayerStateMachine.findPathTo('SUSPENDED', 'ARCHIVED')).toBeNull();
  });
});

/**
 * The refusal has to be usable.
 *
 * `No valid path from INVITED to SUSPENDED` is true and tells a clerk nothing — they are left
 * deciding whether the roster is broken. Naming the decision the route would have had to make on
 * their behalf turns it into a next step they can actually take.
 */
describe('why there is no path', () => {
  it('names the decision a route would have had to make on the operator\'s behalf', () => {
    expect(assayerLifecycleBlockedBy('INVITED', 'SUSPENDED')).toBe(AssayerLifecycleStatus.ACTIVE);
    expect(assayerLifecycleBlockedBy('ON_LEAVE', 'RESIGNED')).toBe(AssayerLifecycleStatus.ACTIVE);
    expect(assayerLifecycleBlockedBy('ACTIVE', 'TERMINATED')).toBe(AssayerLifecycleStatus.SUSPENDED);
    expect(assayerLifecycleBlockedBy('RESIGNED', 'ACTIVE')).toBe(AssayerLifecycleStatus.INVITED);
  });

  /**
   * And says nothing when there is nothing to say. Two states that are simply unconnected have no
   * decision standing between them, and inventing a sentence for that would be worse than the
   * bare fact.
   */
  it('offers no explanation where none exists', () => {
    for (const to of Object.values(AssayerLifecycleStatus)) {
      if (to === AssayerLifecycleStatus.ARCHIVED) continue;
      expect(assayerLifecycleBlockedBy(AssayerLifecycleStatus.ARCHIVED, to)).toBeNull();
    }
  });

  /** A reachable pair has no blocker either — this is only ever asked after a null path. */
  it('reports no blocker for a walk that is allowed', () => {
    expect(assayerLifecycleBlockedBy('INVITED', 'ACTIVE')).toBeNull();
    expect(assayerLifecycleBlockedBy('TRAINING', 'ARCHIVED')).toBeNull();
    expect(assayerLifecycleBlockedBy('ACTIVE', 'ACTIVE')).toBeNull();
  });

  /** The destination is allowed to be a decision — arriving there IS the decision. */
  it('does not call the destination its own blocker', () => {
    expect(assayerLifecycleBlockedBy('ACTIVE', 'SUSPENDED')).toBeNull();
    expect(assayerLifecycleBlockedBy('SUSPENDED', 'TERMINATED')).toBeNull();
    expect(assayerLifecycleBlockedBy('RESIGNED', 'INVITED')).toBeNull();
  });
});
