import { getAssignmentBaseFee, getAssignmentTotalFee, hasResolvedFee } from './fees';

/**
 * What the app tells a field worker they will earn.
 *
 * This resolves the same question the backend answers in `billing-money.ts`
 * (`assignmentFee(a, 'COST')`), and the two must agree about which figure wins — the number on
 * the assayer's phone is the number they expect to be paid, and a disagreement here is one they
 * discover when the money arrives.
 *
 * Mobile carries one extra tier the backend does not: `standardBaseFee`, the assayer's own rate,
 * shown as an estimate when an assignment carries no fee at all. That is a display fallback for
 * a case that should not occur (an offer always carries a proposed fee), not a third opinion
 * about what is payable — it can only ever appear where the backend would book nothing, so it
 * cannot inflate a real fee. The ordering of the two tiers that DO decide money is what these
 * tests pin.
 */
describe('assignment fee shown to the assayer', () => {
  it('always prefers the agreed fee, including when it was negotiated DOWN', () => {
    // The bug this file was created to end: a `Math.max` formula on one screen pulled a
    // negotiated-down fee back up to the standard rate, so two screens showed different pay for
    // the same job. The agreed figure is what both sides settled on and it wins outright.
    expect(getAssignmentBaseFee({ agreedBaseFee: 1800, proposedFee: 2400, standardBaseFee: 3000 })).toBe(1800);
  });

  it('falls back to the proposed fee while none has been agreed', () => {
    // Matches the backend's COST resolution: an offer awaiting a reply shows the amount on the
    // table rather than a blank.
    expect(getAssignmentBaseFee({ proposedFee: 2400, standardBaseFee: 3000 })).toBe(2400);
  });

  it('resolves agreed and proposed in the same order the backend books them', () => {
    // Pinned as a pair. If either side ever reorders these, the assayer sees one figure and is
    // paid another.
    const cases = [
      { input: { agreedBaseFee: 1800, proposedFee: 2400 }, expected: 1800 },
      { input: { proposedFee: 2400 }, expected: 2400 },
      { input: {}, expected: 0 },
    ];
    for (const { input, expected } of cases) {
      expect(getAssignmentBaseFee(input)).toBe(expected);
    }
  });

  it('shows the standard rate only when nothing else priced the job', () => {
    expect(getAssignmentBaseFee({ standardBaseFee: 3000 })).toBe(3000);
    // …and never in preference to a real figure.
    expect(getAssignmentBaseFee({ proposedFee: 2400, standardBaseFee: 3000 })).toBe(2400);
  });

  it('invents nothing when the job carries no fee at all', () => {
    // A fabricated figure for someone's own pay is worse than showing them nothing. The screens
    // render "not set" off `hasResolvedFee`.
    expect(getAssignmentBaseFee({})).toBe(0);
    expect(hasResolvedFee({})).toBe(false);
  });

  it('adds the agreed travel allowance to the base, not to the standard rate', () => {
    expect(getAssignmentTotalFee({ agreedBaseFee: 1800, agreedTravelFee: 260 })).toBe(2060);
  });

  it('treats a zero fee as unpriced rather than as a job that pays nothing', () => {
    // `agreedBaseFee: 0` is an un-negotiated row, not agreement to work for free — the same
    // reading the backend takes.
    expect(getAssignmentBaseFee({ agreedBaseFee: 0, proposedFee: 2400 })).toBe(2400);
  });
});
