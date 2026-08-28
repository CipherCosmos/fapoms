/**
 * What an assignment is worth — to the assayer, and to the client — defined once.
 *
 * Every rupee this system bills or pays traces to an assignment, and there is exactly one way to
 * turn an assignment into money. Before this file existed the carve (fee → base + travel), the
 * precedence (agreed fee, else proposed), the client pricing (rate card, else pass-through) and
 * the tax treatment were each written out two to six times — in the payable path, the entry path,
 * a raw-SQL copy in `assayer.service`, the web app and the mobile app — and they did not all
 * agree. The finance overview reported one "revenue", the client tab another; the statement
 * reported cost after TDS, the dashboard before it.
 *
 * Pure and dependency-free, so both the entity path and the raw-SQL path can use it, the tests
 * can reason about it without a database, and a change to how money is computed is a change to
 * this file and nowhere else.
 */

/** Money arithmetic is done in paise and rounded once. One `round2`, no epsilon variants. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Rounding slack when comparing money. Two figures within this are equal. */
export const MONEY_EPSILON = 0.01;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// The fee
// ---------------------------------------------------------------------------

type AssignmentFeeLike = { agreedFee?: unknown; proposedFee?: unknown };

export type FeeSource = 'AGREED' | 'PROPOSED' | 'NONE';

export interface ResolvedAssignmentFee {
  /** The figure to book. Zero when no fee exists at all. */
  amount: number;
  /** True when the assayer actually agreed it. False means this is the offer, never confirmed. */
  settled: boolean;
  source: FeeSource;
}

/**
 * The one precedence for both sides of the ledger:
 *
 *   agreedFee > 0   → the agreed fee, settled
 *   proposedFee > 0 → the proposed fee, NOT settled
 *   otherwise       → nothing to book
 *
 * Both sides read the same figure on purpose. The previous engine booked the assayer from
 * `agreed ?? proposed` and refused the client line unless the fee was agreed — so a completed
 * assignment with no agreed fee paid the assayer and never billed the client, and margin was
 * quietly short by the whole job. Every accept path writes `agreedFee`, so an unsettled booking is
 * a data fault, not a workflow; it is booked symmetrically and surfaced in the attention list
 * rather than silently half-booked.
 */
export function assignmentFee(a: AssignmentFeeLike): ResolvedAssignmentFee {
  const agreed = num(a.agreedFee);
  if (a.agreedFee !== null && a.agreedFee !== undefined && agreed > 0) {
    return { amount: round2(agreed), settled: true, source: 'AGREED' };
  }
  const proposed = num(a.proposedFee);
  if (a.proposedFee !== null && a.proposedFee !== undefined && proposed > 0) {
    return { amount: round2(proposed), settled: false, source: 'PROPOSED' };
  }
  return { amount: 0, settled: false, source: 'NONE' };
}

// ---------------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------------

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
 * Both rates apply to the taxable value, and TDS is deliberately NOT charged on the GST —
 * withholding is computed on the value of the service under the Income Tax Act, while GST is
 * collected for the government on top. Applying TDS to the GST-inclusive figure over-withholds
 * by the tax on the tax.
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

// ---------------------------------------------------------------------------
// The whole line: assayer side and client side, from one assignment
// ---------------------------------------------------------------------------

export interface AssignmentMoneyInput extends AssignmentFeeLike {
  /**
   * The travel component of the fee, frozen at offer time by the one calculator
   * (`FeePolicyService.quote`). Billing never re-prices travel; it only reads this.
   */
  quotedTravelFee?: unknown;
  /**
   * What a counter-offer settled the travel at, when one was made.
   *
   * A counter-offer is about the journey rather than the audit fee — the fee is what the work is
   * worth and comes from the rate card. So this, not `quotedTravelFee`, is the travel actually
   * owed once it is set. The quoted figure stays readable beside it, which is what makes
   * "asked 400, agreed 650" a fact the audit trail can state.
   *
   * Null or absent means nothing was countered and the quote stands.
   */
  counterTravelFee?: unknown;
}

export interface MoneyContext {
  /**
   * What the client is billed per audit (`client_configurations.default_base_fee`), or null when
   * they have not set one — in which case the line passes the assayer's fee through at cost.
   */
  clientRate: number | null;
  /** `clients.planning_preferences.rechargeTravel` — whether travel appears on the client's line. */
  rechargeTravel: boolean;
  /** GST the client is charged, and TDS the client withholds (client_billing, else platform defaults). */
  gstRate: number;
  clientTdsRate: number;
  /** TDS withheld from the assayer (platform setting `billing.tdsRate`). */
  assayerTdsRate: number;
  /**
   * Offers made before `quotedTravelFee` existed have no knowable travel share. For them, the
   * legacy behaviour is preserved: the commercial profile's flat reimbursement, paid on top of the
   * fee. Null means "no legacy figure"; ignored whenever `quotedTravelFee` is present.
   */
  legacyTravelReimbursement?: number | null;
  /** A per-job correction on the client line (`editClientLine`). Defaults to 0. */
  adjustmentAmount?: number;
}

export interface AssignmentMoney {
  fee: ResolvedAssignmentFee;
  /** What we owe the assayer. `gross` is pre-TDS — the cost of the work; `net` is what they receive. */
  assayer: { base: number; travel: number; gross: number; tds: number; net: number };
  /** What the client is billed. `taxable` is ex-GST — the revenue; `total` is what they pay. */
  client: {
    base: number;
    travel: number;
    adjustment: number;
    taxable: number;
    gst: number;
    tds: number;
    total: number;
    pricedFrom: 'CLIENT_RATE' | 'PASS_THROUGH';
  };
}

/**
 * THE formula. Every writer and every reader of assignment money goes through here.
 *
 * ## The carve
 *
 * The agreed fee already CONTAINS travel — the quote that became `proposedFee` was base + travel,
 * and the mobile app tells the assayer so in as many words. So the payable carves the agreed
 * total into base and travel instead of paying the fee whole and adding a reimbursement on top
 * (which paid travel twice). The carve keeps gross = fee exactly: negotiation moves the total,
 * whatever was negotiated lands in the base, and travel stays what was quoted — clamped so a fee
 * negotiated below the travel figure never produces a negative base.
 *
 * ## The client side
 *
 * A client's contracted rate is a travel-exclusive audit fee, so `rate + travel` is the invoice
 * (travel only when their contract recharges it). Without a rate the line passes the assayer's
 * fee through: base = fee − travel, plus the same travel — so base + travel === the fee and the
 * journey is never billed twice.
 *
 * ## Taxes
 *
 * GST is charged to the client, never added on the assayer's side (assayers are
 * professional-service vendors; no GST unless they are registered, which this system does not
 * model). TDS is withheld on both sides, at the client's rate and the platform's rate
 * respectively, on the taxable value — never on the GST.
 */
export function assignmentMoney(a: AssignmentMoneyInput, ctx: MoneyContext): AssignmentMoney {
  const fee = assignmentFee(a);
  const amount = fee.amount;

  /**
   * The travel actually owed: what a counter-offer settled on, else what was quoted.
   *
   * The carve below is unchanged and does not need to be: `proposeCounterFee` keeps the total in
   * step by writing `base + counterTravel` into `proposedFee`, so `amount - travel` still lands
   * exactly on the base the rate card set. The difference is which travel figure is authoritative
   * — before, every rupee negotiated moved the *base*, silently changing the price of the work
   * rather than the price of getting there.
   */
  const counteredTravel =
    a.counterTravelFee !== null && a.counterTravelFee !== undefined ? num(a.counterTravelFee) : null;
  const quotedTravel =
    counteredTravel !== null
      ? counteredTravel
      : a.quotedTravelFee !== null && a.quotedTravelFee !== undefined
        ? num(a.quotedTravelFee)
        : null;

  let assayerBase: number;
  let assayerTravel: number;
  if (quotedTravel !== null) {
    assayerTravel = round2(Math.min(Math.max(0, quotedTravel), amount));
    assayerBase = round2(amount - assayerTravel);
  } else {
    // Legacy offer: fee whole, profile reimbursement on top. Restating history is worse than the
    // known flaw; new offers always carry `quotedTravelFee`.
    assayerTravel = round2(Math.max(0, num(ctx.legacyTravelReimbursement)));
    assayerBase = round2(amount);
  }
  const assayerGross = round2(assayerBase + assayerTravel);
  const assayerTaxes = applyTaxes(assayerGross, { taxRate: 0, tdsRate: ctx.assayerTdsRate });

  const pricedFrom = ctx.clientRate !== null && ctx.clientRate > 0 ? 'CLIENT_RATE' : 'PASS_THROUGH';
  const clientBase =
    pricedFrom === 'CLIENT_RATE'
      ? round2(ctx.clientRate as number)
      : quotedTravel !== null
        ? round2(Math.max(0, amount - assayerTravel))
        : round2(amount);
  const clientTravel = ctx.rechargeTravel ? assayerTravel : 0;
  const adjustment = round2(num(ctx.adjustmentAmount));
  const taxable = round2(clientBase + clientTravel + adjustment);
  const clientTaxes = applyTaxes(taxable, { taxRate: ctx.gstRate, tdsRate: ctx.clientTdsRate });

  return {
    fee,
    assayer: {
      base: assayerBase,
      travel: assayerTravel,
      gross: assayerGross,
      tds: assayerTaxes.tdsAmount,
      net: assayerTaxes.totalAmount,
    },
    client: {
      base: clientBase,
      travel: clientTravel,
      adjustment,
      taxable,
      gst: clientTaxes.taxAmount,
      tds: clientTaxes.tdsAmount,
      total: clientTaxes.totalAmount,
      pricedFrom,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading money back off stored rows
// ---------------------------------------------------------------------------

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
 * What one payable costs the business: base plus travel — the GROSS, deliberately before TDS.
 * Withholding tax is the assayer's liability that we remit on their behalf, so it reduces the
 * cash we hand over but not what the work cost us.
 */
export function payableCost(p: PayableLike): number {
  return round2(num(p.baseAmount ?? p.base_amount) + num(p.travelAmount ?? p.travel_amount));
}

/**
 * What one client line is worth to us: the taxable value (ex-GST). GST is collected for the
 * government, not earned.
 */
export function entryRevenue(e: EntryLike): number {
  const taxable = e.taxableAmount ?? e.taxable_amount;
  if (taxable !== null && taxable !== undefined) return round2(num(taxable));
  return round2(num(e.baseAmount ?? e.base_amount));
}

export function totalPayableCost(payables: PayableLike[]): number {
  return round2(payables.reduce((sum, p) => sum + payableCost(p), 0));
}

export function totalEntryRevenue(entries: EntryLike[]): number {
  return round2(entries.reduce((sum, e) => sum + entryRevenue(e), 0));
}

/**
 * Margin and its percentage, together — with the divide-by-zero guard that was re-implemented at
 * every call site (a period with cost but no revenue yields a margin and a null percentage,
 * never Infinity or NaN on a dashboard).
 */
export function margin(revenue: number, cost: number): { margin: number; marginPct: number | null } {
  return {
    margin: round2(revenue - cost),
    marginPct: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
  };
}
