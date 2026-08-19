import { formatRupees } from '@fapoms/shared';

/**
 * How this app renders money, and which fee it renders.
 *
 * `formatRupees` in @fapoms/shared already settled the *formatting* question. What it could not
 * settle is the two decisions that sit on top of it, and those had drifted into six files:
 *
 *  - Four screens each declared their own `money` / `inr` / `moneyExact`, two of them bypassing
 *    the shared formatter entirely and calling `toLocaleString('en-IN')` — so the em dash for a
 *    missing value, the rounding, and the decimals were per-file opinions again.
 *  - Five screens each retyped `agreedFee ?? proposedFee` to answer "what is this assignment
 *    worth", one of them twice on the same page with two different fallbacks.
 *
 * Both belong here. The fee precedence in particular is not a formatting detail — it mirrors
 * `assignmentFee(a, 'COST')` on the backend, and a screen that disagrees with it shows the
 * assayer a different number from the one they will be paid.
 */

/** Whole rupees with an em dash for nothing — what almost every surface wants. */
export const money = (n?: number | string | null) => formatRupees(n, { emptyAs: '—' });

/** Rupees and paise, for finance surfaces that must reconcile to the stored figure. */
export const moneyExact = (n?: number | string | null) => formatRupees(n, { decimals: 2, emptyAs: '—' });

/**
 * A total, where nothing present means zero rupees rather than an unknown amount.
 *
 * The difference from {@link money} is what absence means. A fee that has not been set is
 * genuinely unknown and shows an em dash; an aging bucket with no invoices in it holds ₹0, and
 * rendering "—" there would tell a finance user the figure could not be determined when in fact
 * it is nil. Same formatter either way — the choice is about the claim being made.
 */
export const moneyTotal = (n?: number | string | null) => formatRupees(n);

export interface FeeBearing {
  agreedFee?: number | string | null;
  proposedFee?: number | string | null;
}

/**
 * What an assignment is worth to the assayer, as a number.
 *
 * The agreed fee always wins — including when it was negotiated *down* — because that is the
 * figure both sides settled on. The proposed fee stands in only while none has been agreed, so
 * an offer awaiting a reply still shows the amount on the table rather than a blank.
 *
 * Mirrors `assignmentFee(a)` in the backend's assignment-money.ts. Returns null rather than 0
 * when neither exists, so a screen can render "—" instead of claiming the job pays nothing.
 *
 * This is the OFFER figure, for display on an assignment card. Never sum it into an earnings or
 * revenue total — those come from the billing API (`/billing-engine/...`), which is the one place
 * that knows what was actually booked, held, paid and collected.
 */
export function assignmentFeeValue(a: FeeBearing | null | undefined): number | null {
  if (!a) return null;
  const agreed = Number(a.agreedFee ?? NaN);
  if (Number.isFinite(agreed) && agreed > 0) return agreed;
  const proposed = Number(a.proposedFee ?? NaN);
  return Number.isFinite(proposed) ? proposed : null;
}

/** {@link assignmentFeeValue}, formatted — the one-liner five screens were each writing. */
export const assignmentFee = (a: FeeBearing | null | undefined) => money(assignmentFeeValue(a));
