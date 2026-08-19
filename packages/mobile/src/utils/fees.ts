/**
 * What an assignment is worth, for display on this phone.
 *
 * One precedence, and it is the backend's — `assignmentFee` in
 * `billing-engine/assignment-money.ts`: the agreed fee always wins, including when it was
 * negotiated DOWN, because that is what both sides settled on; the proposed fee stands in only
 * while none has been agreed, so an offer awaiting a reply still shows the amount on the table.
 *
 * There is deliberately no third fallback. This used to fall through to the assayer's standard
 * profile rate (and before that to a hardcoded ₹1200), which showed a field worker a figure they
 * would not actually be paid — the booked payout comes from the agreed or proposed fee and
 * nothing else. An assignment with neither resolves to null and the screens render "not set".
 *
 * This is the OFFER figure. Never sum it into an earnings total: what has been earned, paid and
 * is still owed comes from the assayer's statement (`/billing-engine/assayers/:id/statement`),
 * which is the same set of rows finance works from.
 */

export interface FeeBearingAssignment {
  agreedBaseFee?: number | null;
  proposedFee?: number | null;
}

/** The fee to show, or null when the assignment carries none. */
export function assignmentFee(a: FeeBearingAssignment): number | null {
  if (a.agreedBaseFee && a.agreedBaseFee > 0) return a.agreedBaseFee;
  if (a.proposedFee && a.proposedFee > 0) return a.proposedFee;
  return null;
}

/** True when the assignment states a fee — render "not set", never a guess. */
export function hasResolvedFee(a: FeeBearingAssignment): boolean {
  return assignmentFee(a) !== null;
}

/** The fee as a number, zero when unpriced — for summing offer cards on one screen. */
export function assignmentFeeValue(a: FeeBearingAssignment): number {
  return assignmentFee(a) ?? 0;
}
