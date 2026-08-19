import { assignmentFee, assignmentFeeValue, hasResolvedFee } from './fees';

/**
 * One precedence, shared with the backend. A screen that disagrees with it shows the assayer a
 * different number from the one they will be paid.
 */
describe('assignmentFee', () => {
  it('takes the agreed fee, even when it was negotiated down', () => {
    expect(assignmentFee({ agreedBaseFee: 1800, proposedFee: 2400 })).toBe(1800);
  });

  it('falls back to the proposed fee while none has been agreed', () => {
    expect(assignmentFee({ proposedFee: 2400 })).toBe(2400);
  });

  it('has no third fallback — an unpriced assignment is null, not a guess', () => {
    // It used to fall through to the assayer's standard profile rate, and before that to a
    // hardcoded ₹1200. Neither is what the payout is booked from.
    expect(assignmentFee({})).toBeNull();
    expect(assignmentFee({ agreedBaseFee: 0, proposedFee: 0 })).toBeNull();
    expect(hasResolvedFee({})).toBe(false);
  });

  it('treats a zero agreed fee as unset rather than as a free job', () => {
    expect(assignmentFee({ agreedBaseFee: 0, proposedFee: 2400 })).toBe(2400);
  });

  it('gives 0 rather than null where a sum is being built', () => {
    expect(assignmentFeeValue({})).toBe(0);
    expect(assignmentFeeValue({ agreedBaseFee: 1800 })).toBe(1800);
  });
});
