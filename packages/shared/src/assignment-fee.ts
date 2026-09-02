/**
 * What an assignment's fee IS, decided once for the whole product.
 *
 * Three packages each answered this separately and disagreed, which is how a job the backend books
 * as unpriced came to render as a confident "₹0" on the operations desk:
 *
 *   backend  assignment-money.ts   proposed > 0 ? PROPOSED : NONE
 *   mobile   utils/fees.ts         proposed > 0 ? proposed : null    ("not set")
 *   web      utils/money.ts        Number.isFinite(proposed) ? proposed : null   ← no gate
 *
 * The web copy even carried a comment saying it mirrored the backend. It did not, and nothing
 * tested it, because `packages/shared` had no test runner at all.
 *
 * The second, costlier confusion this file exists to end: **a fee has two parts and only one of
 * them is negotiable.** The audit fee comes from the client's rate card and neither side moves it;
 * travel is the whole of what is argued about. Screens kept storing a total in a field that is sent
 * as travel, or seeding a travel input from a total — three separate bugs in one week, each fixed
 * by adding a comment, because a `number` cannot tell you which quantity it holds. `FeeAmounts`
 * makes the distinction a type, and `previewFeeChange` is the only place allowed to turn a typed
 * travel figure into a new total.
 */

import { formatRupees } from './utils';

/** Beyond this, two rupee figures are genuinely different rather than float noise. */
const MONEY_EPSILON = 0.01;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** The raw fee columns as they arrive from the API. Nothing derived. */
export interface AssignmentFeeInput {
  proposedFee?: number | string | null;
  agreedFee?: number | string | null;
  quotedBaseFee?: number | string | null;
  quotedTravelFee?: number | string | null;
  counterTravelFee?: number | string | null;
}

/** Where the total came from. `NONE` means no fee has been stated — never "zero". */
export type FeeSource = 'AGREED' | 'PROPOSED' | 'NONE';

/**
 * How the base/travel split was established, which decides whether a screen may offer a counter.
 *
 * `LEGACY_UNSPLIT` is an offer made before the quote columns existed: a total is known and the
 * split is not. Such a fee must not be countered on travel, because there is no base to add the
 * new travel to — the arithmetic would silently reprice the audit itself.
 */
export type FeeSplitSource = 'QUOTED' | 'COUNTERED' | 'LEGACY_UNSPLIT' | 'NONE';

export interface AssignmentFeeView {
  /** What the assayer sees and what will be paid. `null` means no fee, which is not zero. */
  total: number | null;
  /** True when `agreedFee` won — settled, not still on the table. */
  settled: boolean;
  source: FeeSource;
  /** The audit fee. Never negotiable. `null` when the split is unknown. */
  base: number | null;
  /** The journey. The only negotiable component. `null` when the split is unknown. */
  travel: number | null;
  /** What the rate card originally quoted, when a counter has since moved travel. */
  quotedTravel: number | null;
  splitSource: FeeSplitSource;
  /** `base + travel` disagrees with `total` — a data fault a screen should surface, not hide. */
  inconsistent: boolean;
  /** Whether a travel counter is meaningful at all. False when there is no known base. */
  counterable: boolean;
  /** Pre-formatted, so no screen re-decides the rupee format or what "no fee" looks like. */
  text: {
    total: string;
    base: string;
    travel: string;
    /** "audit fee ₹1,250 + travel ₹650" */
    breakdown: string;
  };
}

/**
 * Resolve the fee. `agreed` beats `proposed`, and both must be greater than zero to count.
 *
 * The `> 0` gate is the whole point: a stored `0` means "nobody has priced this", and rendering it
 * as "₹0" tells a field worker the job pays nothing. A desk override of 0 passes API validation, so
 * this is reachable, not theoretical.
 */
export function describeAssignmentFee(a: AssignmentFeeInput | null | undefined): AssignmentFeeView {
  const blank = (): AssignmentFeeView => ({
    total: null, settled: false, source: 'NONE',
    base: null, travel: null, quotedTravel: null,
    splitSource: 'NONE', inconsistent: false, counterable: false,
    text: { total: '—', base: '—', travel: '—', breakdown: 'No fee set' },
  });

  if (!a) return blank();

  const agreed = num(a.agreedFee);
  const proposed = num(a.proposedFee);

  let total: number | null = null;
  let source: FeeSource = 'NONE';
  let settled = false;
  if (Number.isFinite(agreed) && agreed > 0) {
    total = round2(agreed); source = 'AGREED'; settled = true;
  } else if (Number.isFinite(proposed) && proposed > 0) {
    total = round2(proposed); source = 'PROPOSED';
  }

  if (total === null) return blank();

  const quotedTravelRaw = num(a.quotedTravelFee);
  const counterTravelRaw = num(a.counterTravelFee);
  const quotedBaseRaw = num(a.quotedBaseFee);

  const quotedTravel = Number.isFinite(quotedTravelRaw) ? round2(quotedTravelRaw) : null;

  /**
   * Travel on the table: a counter if one was made, else the rate card's quote.
   *
   * Order matters and has bitten twice. A screen seeded from `quotedTravelFee` after the desk had
   * already countered showed the assayer the ORIGINAL quote — so they re-countered against a number
   * nobody was offering any more.
   */
  let travel: number | null = null;
  let splitSource: FeeSplitSource;
  if (Number.isFinite(counterTravelRaw)) {
    travel = round2(counterTravelRaw); splitSource = 'COUNTERED';
  } else if (quotedTravel !== null) {
    travel = quotedTravel; splitSource = 'QUOTED';
  } else {
    splitSource = 'LEGACY_UNSPLIT';
  }

  /**
   * The base is preferred from the frozen quote, and derived only as a fallback.
   *
   * Deriving `total − travel` is what the backend does when there is no quoted base, and it is
   * clamped at zero there for the same reason: a travel figure larger than the whole fee is a data
   * fault, and a negative audit fee is not a thing.
   */
  let base: number | null = null;
  if (splitSource !== 'LEGACY_UNSPLIT') {
    base = Number.isFinite(quotedBaseRaw)
      ? round2(quotedBaseRaw)
      : round2(Math.max(0, total - (travel ?? 0)));
  }

  const inconsistent =
    base !== null && travel !== null
      ? Math.abs(base + travel - total) > MONEY_EPSILON
      : false;

  const money = (n: number | null): string => (n === null ? '—' : formatRupees(n));

  return {
    total, settled, source,
    base, travel, quotedTravel,
    splitSource, inconsistent,
    // A counter needs a base to add the new travel to. Without one the sum is meaningless.
    counterable: base !== null,
    text: {
      total: money(total),
      base: money(base),
      travel: money(travel),
      breakdown: base === null
        ? money(total)
        : `audit fee ${money(base)} + travel ${money(travel)}`,
    },
  };
}

export interface FeeChangePreview {
  /** The parsed travel figure. `null` when the input cannot be used. */
  travel: number | null;
  /** What the assayer would see. `null` when the input cannot be used. */
  newTotal: number | null;
  /** A ready-to-show message, or `null` when the input is fine. */
  error: string | null;
  /** "Audit fee ₹1,250 (fixed) + travel ₹650 → the assayer sees ₹1,900" */
  text: string;
  /** The exact request bodies, so no call site assembles one by hand and swaps the fields. */
  body: {
    counter: { targetStatus: 'NEGOTIATION'; counterTravelFee: number } | null;
    firstOffer: { proposedFee: number } | null;
  };
}

/**
 * Turn a typed TRAVEL figure into what the offer becomes. The only place that does this.
 *
 * Zero is a legitimate answer — a branch inside the free commute allowance — which is why this
 * cannot lean on `parseRupeeInput`, whose contract returns `null` for 0. Mobile did lean on it, and
 * an assayer countering a local branch with ₹0 travel was told to "enter the travel amount".
 *
 * Indian digit grouping is accepted ("1,200"), because that is how the number is written on the
 * call and in the sheet the desk is reading from.
 */
export function previewFeeChange(view: AssignmentFeeView, travelInput: string): FeeChangePreview {
  const refuse = (error: string): FeeChangePreview => ({
    travel: null, newTotal: null, error, text: error,
    body: { counter: null, firstOffer: null },
  });

  if (!view.counterable) {
    return refuse('This offer has no recorded audit fee, so travel cannot be changed on it.');
  }

  const raw = String(travelInput ?? '').trim().replace(/[₹\s,]/g, '');
  if (raw === '') return refuse('Enter the travel amount.');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return refuse('Enter the travel amount in rupees, like 650.');

  const travel = round2(Number(raw));
  if (!Number.isFinite(travel)) return refuse('Enter the travel amount in rupees, like 650.');

  const base = view.base ?? 0;
  const newTotal = round2(base + travel);

  return {
    travel,
    newTotal,
    error: null,
    text: `Audit fee ${formatRupees(base)} (fixed) + travel ${formatRupees(travel)}`
      + ` → the assayer sees ${formatRupees(newTotal)}`,
    body: {
      counter: { targetStatus: 'NEGOTIATION', counterTravelFee: travel },
      firstOffer: { proposedFee: newTotal },
    },
  };
}

/**
 * What a travel input should be seeded with. Never the total.
 *
 * Exists as a named function so the mistake is not re-typeable: every historical bug here was a
 * screen writing `setTravelField(fee.total)`. There is now nothing to reach for that returns a
 * total from this module's seeding path.
 */
export function seedTravelInput(view: AssignmentFeeView): string {
  return view.travel !== null && view.travel > 0 ? String(view.travel) : '';
}
