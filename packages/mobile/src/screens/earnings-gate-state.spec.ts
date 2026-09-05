import { deriveEarningsGateState } from './earnings-breakdown';

/**
 * The four states of the earnings gate (plus the legacy world while the server flag is off),
 * derived purely from the statement's counts-only `invoicing` block and the separately fetched
 * invitation. This derivation is what keeps the screen honest: a wrong state here either shows
 * gate copy over ungated totals, or tells an assayer nothing is happening while an invitation
 * sits waiting for their consent.
 */
describe('deriveEarningsGateState', () => {
  const gated = (
    awaitingInvoiceCount: number,
    invitation: { id: string; status: string; lineCount: number } | null,
  ) => ({ invoicing: { awaitingInvoiceCount, invitation } });

  describe('legacy (flag off / nothing loaded)', () => {
    it('is legacy while no statement has loaded at all', () => {
      expect(deriveEarningsGateState(null, null)).toEqual({ kind: 'legacy' });
      expect(deriveEarningsGateState(undefined, null)).toEqual({ kind: 'legacy' });
    });

    it('is legacy when the statement carries no invoicing block (server flag off)', () => {
      // Deployed dark, the gated code must change nothing: today's full statement shape has no
      // `invoicing` key, and the screen renders exactly the pre-gate world.
      expect(deriveEarningsGateState({}, null)).toEqual({ kind: 'legacy' });
    });

    it('stays legacy even when an invitation was somehow fetched without a gated statement', () => {
      // Without the gated statement the totals on screen are the UNGATED ones; gate copy over
      // them would describe the figures wrongly. The statement's shape is the source of truth
      // for which world we are in.
      expect(
        deriveEarningsGateState(null, { status: 'INVITED', lineCount: 3 }),
      ).toEqual({ kind: 'legacy' });
    });
  });

  describe('nothing invited', () => {
    it('says how many completed audits await invoicing — counts only, no invitation', () => {
      expect(deriveEarningsGateState(gated(4, null), null)).toEqual({ kind: 'awaiting', count: 4 });
    });

    it('is none when nothing awaits and nothing is invited', () => {
      expect(deriveEarningsGateState(gated(0, null), null)).toEqual({ kind: 'none' });
    });
  });

  describe('invitation open', () => {
    it('is invited when the fetched invitation is INVITED', () => {
      expect(
        deriveEarningsGateState(gated(0, null), { status: 'INVITED', lineCount: 5 }),
      ).toEqual({ kind: 'invited', lineCount: 5 });
    });

    it('is submitted when the fetched invitation is SUBMITTED', () => {
      expect(
        deriveEarningsGateState(gated(0, null), { status: 'SUBMITTED', lineCount: 5 }),
      ).toEqual({ kind: 'submitted', lineCount: 5 });
    });

    it('falls back to the statement stub when the invitation read failed', () => {
      // The statement arrived but the invitation GET did not: the stub still says an invitation
      // exists, and the card must show rather than pretending nothing is happening.
      expect(
        deriveEarningsGateState(gated(2, { id: 'i1', status: 'INVITED', lineCount: 2 }), null),
      ).toEqual({ kind: 'invited', lineCount: 2 });
      expect(
        deriveEarningsGateState(gated(0, { id: 'i1', status: 'SUBMITTED', lineCount: 7 }), null),
      ).toEqual({ kind: 'submitted', lineCount: 7 });
    });

    it('prefers the directly fetched invitation over the statement stub when both exist', () => {
      // The direct read is fresher: an assayer who just submitted must see "submitted" even if
      // the statement in state still embeds the older INVITED stub.
      expect(
        deriveEarningsGateState(
          gated(0, { id: 'i1', status: 'INVITED', lineCount: 5 }),
          { status: 'SUBMITTED', lineCount: 5 },
        ),
      ).toEqual({ kind: 'submitted', lineCount: 5 });
    });

    it('an open invitation outranks the awaiting count', () => {
      // Both can be true at once (new work completed after the invite was cut); the action the
      // assayer can actually take — review the invitation — wins the screen.
      expect(
        deriveEarningsGateState(gated(3, null), { status: 'INVITED', lineCount: 4 }),
      ).toEqual({ kind: 'invited', lineCount: 4 });
    });
  });

  describe('defensive handling of the unexpected', () => {
    it('does not present an unknown invitation status as reviewable', () => {
      // The server only hands the assayer INVITED or SUBMITTED. Anything else falls through to
      // the counts — mislabelling an unknown state as "ready to review" invites consent to a
      // document in a state this build does not understand.
      expect(
        deriveEarningsGateState(gated(2, null), { status: 'CANCELLED', lineCount: 2 }),
      ).toEqual({ kind: 'awaiting', count: 2 });
    });
  });
});
