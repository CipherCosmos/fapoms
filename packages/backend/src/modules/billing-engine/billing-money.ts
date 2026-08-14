/**
 * What a payable costs, and what an entry earns — defined once.
 *
 * Both figures were written out inline wherever a margin was needed: six copies of
 * `baseAmount + travelAmount` and four of `taxableAmount ?? baseAmount`, spread across the
 * client dashboard, the project dashboard, the assayer statement and the invoice builder. They
 * agreed, but only by everyone having typed the same thing — and margin is subtraction, so a
 * single copy left behind after a change shows a different profit for the same period on two
 * screens, with nothing to say which is wrong.
 *
 * Pure and dependency-free so both the entity path and the raw-SQL path can use them, and so
 * they can be reasoned about without a database.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Either shape this codebase reads money in: a hydrated entity, or a raw snake_case SQL row. */
type PayableLike = {
  baseAmount?: unknown; travelAmount?: unknown;
  base_amount?: unknown; travel_amount?: unknown;
};

type EntryLike = {
  taxableAmount?: unknown; baseAmount?: unknown;
  taxable_amount?: unknown; base_amount?: unknown;
};

/**
 * What one payable costs the business.
 *
 * Base plus travel — the GROSS, deliberately before TDS. Withholding tax is the assayer's
 * liability that we remit on their behalf, so it reduces the cash we hand over but not what the
 * work cost us; netting it off would overstate margin by the withheld amount on every job.
 *
 * Payables carry no adjustment column (unlike billing entries), so these two components are the
 * whole of it. If one is ever added, this is the only place that has to learn about it.
 */
export function payableCost(p: PayableLike): number {
  return round2(
    num(p.baseAmount ?? p.base_amount) + num(p.travelAmount ?? p.travel_amount),
  );
}

/**
 * What one billing entry is worth to us.
 *
 * `taxableAmount` when it has been computed (base + travel + adjustment, per `recomputeEntry`),
 * falling back to the base for entries written before that column existed. Revenue is measured
 * before tax for the same reason cost is measured before TDS: GST is collected for the
 * government, not earned.
 */
export function entryRevenue(e: EntryLike): number {
  const taxable = e.taxableAmount ?? e.taxable_amount;
  if (taxable !== null && taxable !== undefined) return round2(num(taxable));
  return round2(num(e.baseAmount ?? e.base_amount));
}

/** Sum of what a set of payables cost. */
export function totalPayableCost(payables: PayableLike[]): number {
  return round2(payables.reduce((sum, p) => sum + payableCost(p), 0));
}

/** Sum of what a set of entries earned. */
export function totalEntryRevenue(entries: EntryLike[]): number {
  return round2(entries.reduce((sum, e) => sum + entryRevenue(e), 0));
}

/**
 * Margin and its percentage, together.
 *
 * Kept as one function because the two are always reported side by side, and the
 * divide-by-zero guard — a period with cost but no revenue yields a margin and a null
 * percentage, never Infinity or NaN on a dashboard — was re-implemented at every call site.
 */
export function margin(revenue: number, cost: number): { margin: number; marginPct: number | null } {
  return {
    margin: round2(revenue - cost),
    marginPct: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
  };
}


export interface TaxOutcome {
  /** GST charged on the taxable value. */
  taxAmount: number;
  /** Withholding deducted from the taxable value — never from the GST. */
  tdsAmount: number;
  /** What actually changes hands: taxable + GST − TDS. */
  totalAmount: number;
}

/**
 * GST and TDS applied to a taxable value.
 *
 * Both sides of the ledger settle the same way — a client invoice line and an assayer payable
 * each add GST to the taxable value and withhold TDS from it — and both had their own copy of
 * `taxable + tax − tds`. Two copies of a settlement formula is one copy too many: it is the
 * figure that decides what is actually invoiced and actually paid, and a divergence between them
 * shows up as money, not as a failing test.
 *
 * Both rates apply to the taxable value, and TDS is deliberately NOT charged on the GST —
 * withholding is computed on the value of the service under the Income Tax Act, while GST is
 * collected for the government on top. Applying TDS to the GST-inclusive figure over-withholds
 * by the tax on the tax.
 *
 * The caller derives its own taxable base, because the two sides build it differently: an entry
 * is base + travel + adjustment − discount, a payable is base + travel.
 */
export function applyTaxes(
  taxable: number,
  rates: { taxRate?: unknown; tdsRate?: unknown },
): TaxOutcome {
  const base = round2(num(taxable));
  const taxAmount = round2(base * (num(rates.taxRate) / 100));
  const tdsAmount = round2(base * (num(rates.tdsRate) / 100));
  return { taxAmount, tdsAmount, totalAmount: round2(base + taxAmount - tdsAmount) };
}

type AssignmentFeeLike = { agreedFee?: unknown; proposedFee?: unknown };

export interface ResolvedAssignmentFee {
  /** The figure to book. */
  fee: number;
  /**
   * True when the assayer actually agreed it. False means this is the fee that was *offered*
   * and never confirmed — which the two sides of the ledger treat differently; see below.
   */
  settled: boolean;
}

/**
 * What an assignment is worth, and whether that price was ever agreed.
 *
 * The precedence was written inline five times, and **not identically**: the client-billing
 * paths read `agreedFee ?? 0` and refuse the entry when it is zero, while the assayer-payable
 * path reads `agreedFee ?? proposedFee ?? 0` and books whatever it finds.
 *
 * That asymmetry is currently load-bearing and is preserved exactly — but it is worth naming,
 * because of what it does when it fires. A completed assignment that somehow carries no agreed
 * fee gets a payable (from the proposed figure) and no billing entry: cost booked, revenue not,
 * margin quietly short by the whole job. Acceptance is supposed to make that impossible — every
 * accept path sets `agreedFee` — so this is a guard against data that should not exist rather
 * than a routine case.
 *
 * Callers state which side they are on, so the difference is visible at the call site instead
 * of hidden in a `??` chain:
 *
 *   assignmentFee(a, 'COST')     — pay what was agreed, or failing that what was offered
 *   assignmentFee(a, 'REVENUE')  — bill only what was agreed
 */
export function assignmentFee(
  a: AssignmentFeeLike,
  side: 'COST' | 'REVENUE',
): ResolvedAssignmentFee {
  const agreed = num(a.agreedFee);
  const settled = a.agreedFee !== null && a.agreedFee !== undefined && agreed > 0;
  if (settled) return { fee: round2(agreed), settled: true };
  return {
    fee: side === 'COST' ? round2(num(a.proposedFee)) : 0,
    settled: false,
  };
}
