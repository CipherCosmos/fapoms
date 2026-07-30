/**
 * Single source of truth for resolving an assignment's payable audit fee.
 *
 * Previously App.tsx and EarningsScreen.tsx each implemented their own formula
 * (one precedence-based, one `Math.max`-based), which meant a legitimately
 * negotiated-down agreed fee could be inflated back up to the standard rate in
 * one place while the other place respected the negotiated amount — showing
 * two different totals for the same assignment. Both screens must import
 * from here so there is exactly one formula in the app.
 */

export interface FeeBearingAssignment {
  agreedBaseFee?: number | null;
  proposedFee?: number | null;
  standardBaseFee?: number | null;
  agreedTravelFee?: number | null;
}

/** Commercial default used only when an assignment has no standard base fee configured yet. */
export const DEFAULT_STANDARD_BASE_FEE = 1200;

/**
 * Resolves the base audit fee (excluding travel) for an assignment.
 * Precedence: an agreed/finalized fee always wins — even if it was negotiated
 * DOWN below the standard rate — otherwise a proposed (not yet agreed) fee,
 * and only falling back to the standard/default base rate when neither has
 * been set.
 */
export function getAssignmentBaseFee(a: FeeBearingAssignment): number {
  if (a.agreedBaseFee && a.agreedBaseFee > 0) return a.agreedBaseFee;
  if (a.proposedFee && a.proposedFee > 0) return a.proposedFee;
  return a.standardBaseFee || DEFAULT_STANDARD_BASE_FEE;
}

/** Base fee (see {@link getAssignmentBaseFee}) plus any agreed travel allowance. */
export function getAssignmentTotalFee(a: FeeBearingAssignment): number {
  const travel = a.agreedTravelFee || 0;
  return getAssignmentBaseFee(a) + travel;
}
