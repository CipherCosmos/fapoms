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

/**
 * No client-side default fee.
 *
 * This used to fall back to a hardcoded ₹1200 when an assignment carried no fee of any kind.
 * That was a seventh independent copy of a base-fee figure that the backend now resolves from
 * the client's contracted rate card and the assayer's own commercial profile — so the number
 * invented here could differ from what the worker is actually owed. Showing a field worker a
 * fabricated figure for their own pay is worse than showing them nothing, so an unpriced
 * assignment now resolves to 0 and the screens render it as "not set".
 *
 * In practice the server always sends `currentStandardBaseFee` (and a real proposed/agreed
 * fee), so this path is defensive rather than routine.
 */

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
  return a.standardBaseFee && a.standardBaseFee > 0 ? a.standardBaseFee : 0;
}

/** True when nothing on the assignment states a fee — render "not set", never a guess. */
export function hasResolvedFee(a: FeeBearingAssignment): boolean {
  return getAssignmentTotalFee(a) > 0;
}

/** Base fee (see {@link getAssignmentBaseFee}) plus any agreed travel allowance. */
export function getAssignmentTotalFee(a: FeeBearingAssignment): number {
  const travel = a.agreedTravelFee || 0;
  return getAssignmentBaseFee(a) + travel;
}
