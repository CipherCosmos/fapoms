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

/**
 * Which of the earnings gate's states the screen is in, derived purely from the statement's
 * counts-only `invoicing` block and the separately fetched invitation.
 *
 * The states mirror the invoicing lifecycle as the assayer experiences it:
 *
 *  - `legacy`    — the server's `billing.assayerInvoicingEnabled` flag is off (the statement has
 *                  no `invoicing` block), or no statement has loaded at all. Render today's
 *                  ungated screen and nothing else; deployed dark, this must change nothing.
 *  - `none`      — gated, nothing awaiting invoicing and no invitation. Totals mean approved
 *                  earnings; there is simply nothing in flight.
 *  - `awaiting`  — gated, N completed audits await invoicing, no invitation yet. The screen says
 *                  so in counts only: not one rupee is shown for unbilled work.
 *  - `invited`   — an invitation is open. The prominent card; tapping it opens the reveal.
 *  - `submitted` — the assayer has consented; ops approval is pending. The consented document
 *                  stays readable, its amounts still excluded from the headline totals.
 *
 * Precedence: the directly fetched invitation wins over the statement's embedded stub when both
 * exist — it is the richer, fresher read (the modal re-fetches it at open anyway) — and the
 * stub covers for it when the invitation read failed but the statement arrived.
 */
export type EarningsGateState =
  | { kind: 'legacy' }
  | { kind: 'none' }
  | { kind: 'awaiting'; count: number }
  | { kind: 'invited'; lineCount: number }
  | { kind: 'submitted'; lineCount: number };

/** The minimal shapes this derivation reads — structural, so specs can feed plain objects. */
export interface GateStatementInput {
  invoicing?: {
    awaitingInvoiceCount: number;
    invitation: { id: string; status: string; lineCount: number } | null;
  };
}

export interface GateInvitationInput {
  status: string;
  lineCount: number;
}

export function deriveEarningsGateState(
  statement: GateStatementInput | null | undefined,
  invitation: GateInvitationInput | null | undefined,
): EarningsGateState {
  const block = statement?.invoicing;
  // No statement, or an ungated one: the flag is off (or the read failed) — the legacy world.
  // The separately fetched invitation alone must NOT open the gate UI: without the gated
  // statement the totals on screen are the ungated ones, and gate copy over ungated totals
  // would describe the figures wrongly.
  if (!block) return { kind: 'legacy' };

  const active = invitation ?? block.invitation;
  // Only the two live statuses open the gate UI. The server only ever hands the assayer an
  // INVITED or SUBMITTED invitation, but a defensive fall-through beats mislabelling a state
  // this build has never heard of as "ready to review".
  if (active?.status === 'SUBMITTED') return { kind: 'submitted', lineCount: active.lineCount };
  if (active?.status === 'INVITED') return { kind: 'invited', lineCount: active.lineCount };
  if (block.awaitingInvoiceCount > 0) return { kind: 'awaiting', count: block.awaitingInvoiceCount };
  return { kind: 'none' };
}
