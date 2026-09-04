/**
 * The TDS line as shown, adjusted to close the ₹1 gap independent rounding opens.
 *
 * `baseAmount`, `travelAmount` and `tdsAmount` each round to the nearest rupee for display, and
 * that sum does not reliably equal the total's own independent rounding. Proven live against a
 * real payout: server figures ₹1,800.00 base + ₹605.00 travel − ₹240.50 TDS = ₹2,164.50 total —
 * exact at the paise level (`assignmentMoney` in the backend holds `gross = round2(base+travel)`
 * and `net = round2(gross-tds)` precisely) — read on screen as "Base ₹1,800 · Travel ₹605 · TDS
 * -₹241" under a headline of "₹2,165". ₹1,800 + ₹605 − ₹241 = ₹2,164, a rupee short of the
 * headline: three independently-rounded parts next to a fourth, separately-rounded total.
 *
 * The total must never move — it is what the assayer is actually owed, and every other screen
 * (and finance) already treats it as authoritative. So the remainder is absorbed by TDS instead,
 * the deduction rather than an amount earned, the way a receipt's last line commonly closes a
 * rounding gap rather than letting the printed total drift from the real one.
 */
export function displayedTds(baseAmount: number, travelAmount: number, totalAmount: number): number {
  return Math.round(baseAmount) + Math.round(travelAmount) - Math.round(totalAmount);
}
