import { payableCost, entryRevenue, totalPayableCost, totalEntryRevenue, margin, assignmentFee, applyTaxes } from './billing-money';

/**
 * The two money definitions the whole billing surface reports from.
 *
 * These matter more than most tests here: margin is a subtraction, so a change to either side
 * that is not matched on the other does not fail loudly — it quietly reports a different profit.
 * What is pinned below is the *meaning* of each figure, not just its arithmetic.
 */
describe('billing money', () => {
  describe('payableCost — what a job cost the business', () => {
    it('is base plus travel', () => {
      expect(payableCost({ baseAmount: 1200, travelAmount: 260 })).toBe(1460);
    });

    it('reads a raw SQL row exactly as it reads an entity', () => {
      // Both shapes are real in this codebase — the assayer statement goes through raw SQL —
      // and the two must never disagree about the same payable.
      expect(payableCost({ base_amount: '1200.00', travel_amount: '260.00' }))
        .toBe(payableCost({ baseAmount: 1200, travelAmount: 260 }));
    });

    it('is measured BEFORE tds, because withholding is the assayer’s tax and not our saving', () => {
      // A payable of 1460 gross with 10% TDS pays out 1314 in cash, but it cost 1460 to have
      // the work done. Netting the withholding off would overstate margin on every single job.
      const p = { baseAmount: 1200, travelAmount: 260, tdsAmount: 146, totalAmount: 1314 };
      expect(payableCost(p)).toBe(1460);
    });

    it('treats absent or unparseable components as zero rather than NaN', () => {
      // One NaN in a reduce turns a whole dashboard's margin into NaN.
      expect(payableCost({ baseAmount: 1200 })).toBe(1200);
      expect(payableCost({ baseAmount: 'oops' as any, travelAmount: 100 })).toBe(100);
      expect(payableCost({})).toBe(0);
    });
  });

  describe('entryRevenue — what a job earned', () => {
    it('prefers the taxable amount, which carries base + travel + adjustment', () => {
      expect(entryRevenue({ taxableAmount: 3400, baseAmount: 3000 })).toBe(3400);
    });

    it('falls back to base for entries written before taxableAmount existed', () => {
      expect(entryRevenue({ baseAmount: 3000 })).toBe(3000);
    });

    it('does not mistake a legitimate zero for a missing value', () => {
      // A fully-discounted entry earns nothing; `?? ` rather than `||` is what keeps that from
      // silently falling through to the base amount.
      expect(entryRevenue({ taxableAmount: 0, baseAmount: 3000 })).toBe(0);
    });
  });

  describe('totals and margin', () => {
    it('sums a set of payables', () => {
      expect(totalPayableCost([
        { baseAmount: 1200, travelAmount: 260 },
        { baseAmount: 1500, travelAmount: 0 },
      ])).toBe(2960);
    });

    it('sums a set of entries', () => {
      expect(totalEntryRevenue([{ taxableAmount: 3400 }, { baseAmount: 3000 }])).toBe(6400);
    });

    it('reports margin and its percentage together', () => {
      expect(margin(6400, 2960)).toEqual({ margin: 3440, marginPct: 53.75 });
    });

    it('returns a null percentage rather than Infinity when there is cost but no revenue', () => {
      // A period with unbilled work is real; a dashboard reading "Infinity%" is not.
      expect(margin(0, 1460)).toEqual({ margin: -1460, marginPct: null });
    });

    it('reports a negative margin plainly when a job cost more than it earned', () => {
      expect(margin(1000, 1460).margin).toBe(-460);
    });
  });

  describe('assignmentFee — what an assignment is worth, and to which side', () => {
    it('books the agreed fee on both sides when there is one', () => {
      const a = { agreedFee: 2500, proposedFee: 2000 };
      expect(assignmentFee(a, 'COST')).toEqual({ fee: 2500, settled: true });
      expect(assignmentFee(a, 'REVENUE')).toEqual({ fee: 2500, settled: true });
    });

    it('never lets the proposed fee become the agreed one — the agreed figure wins outright', () => {
      // Negotiation can settle below the offer. Reading the offer would overpay the assayer and
      // overbill the client by the difference on every renegotiated job.
      expect(assignmentFee({ agreedFee: 1800, proposedFee: 2400 }, 'COST').fee).toBe(1800);
    });

    it('pays the proposed fee when none was agreed, but does not bill it', () => {
      // The asymmetry, stated. This is the case that leaks margin: cost booked from the offer,
      // revenue refused for want of an agreement. It should be unreachable — every accept path
      // writes agreedFee — so if this ever fires in production the assignment data is wrong.
      const unsettled = { proposedFee: 2000 };
      expect(assignmentFee(unsettled, 'COST').fee).toBe(2000);
      expect(assignmentFee(unsettled, 'REVENUE').fee).toBe(0);
      expect(assignmentFee(unsettled, 'COST').settled).toBe(false);
    });

    it('reports a fee of zero, not settled, when neither figure exists', () => {
      expect(assignmentFee({}, 'COST')).toEqual({ fee: 0, settled: false });
      expect(assignmentFee({}, 'REVENUE')).toEqual({ fee: 0, settled: false });
    });

    it('treats a zero or unparseable agreed fee as unsettled rather than as a free job', () => {
      // `agreedFee: 0` is what an un-negotiated row looks like, not a job someone agreed to do
      // for nothing — and callers gate on `fee <= 0`, so it must not be reported as settled.
      expect(assignmentFee({ agreedFee: 0, proposedFee: 2000 }, 'COST')).toEqual({ fee: 2000, settled: false });
      expect(assignmentFee({ agreedFee: 'oops' as any, proposedFee: 2000 }, 'REVENUE').fee).toBe(0);
    });

    it('flags the unsettled case so a caller can act on it, not just quietly book a number', () => {
      // `settled: false` is what the payable sync watches for. It books the proposed fee (the
      // assayer did the work and must be paid) and then raises a CRITICAL billing conflict,
      // because the client side will refuse an entry for the same assignment and the whole cost
      // would otherwise fall to margin with nothing recording why.
      expect(assignmentFee({ proposedFee: 2000 }, 'COST')).toEqual({ fee: 2000, settled: false });
      expect(assignmentFee({ agreedFee: 2000 }, 'COST')).toEqual({ fee: 2000, settled: true });
    });

    it('reads a decimal string from the database as the number it represents', () => {
      // TypeORM hands numeric columns back as strings.
      expect(assignmentFee({ agreedFee: '2500.00' }, 'REVENUE').fee).toBe(2500);
    });
  });

  describe('applyTaxes — how a taxable value settles', () => {
    it('adds gst and withholds tds, both on the taxable value', () => {
      expect(applyTaxes(10000, { taxRate: 18, tdsRate: 10 }))
        .toEqual({ taxAmount: 1800, tdsAmount: 1000, totalAmount: 10800 });
    });

    it('does NOT withhold tds on the gst', () => {
      // TDS is computed on the value of the service; GST is collected on top for the government.
      // Withholding on the GST-inclusive figure over-deducts by the tax on the tax — here it
      // would take 1180 instead of 1000 and short the assayer 180 on a 10,000 job.
      expect(applyTaxes(10000, { taxRate: 18, tdsRate: 10 }).tdsAmount).toBe(1000);
    });

    it('settles a payable and a billing entry identically for the same taxable value', () => {
      // The two sides of the ledger must never disagree about the same arithmetic.
      const payableSide = applyTaxes(payableCost({ baseAmount: 1200, travelAmount: 260 }), { taxRate: 18, tdsRate: 10 });
      const entrySide = applyTaxes(1460, { taxRate: 18, tdsRate: 10 });
      expect(payableSide).toEqual(entrySide);
    });

    it('treats absent rates as zero, leaving the taxable value untouched', () => {
      expect(applyTaxes(1460, {})).toEqual({ taxAmount: 0, tdsAmount: 0, totalAmount: 1460 });
    });

    it('rounds each component to paise rather than carrying float error into the total', () => {
      // 1333.33 * 18% is 239.9994; storing it unrounded makes the stored total disagree with
      // the sum of the stored components by a fraction of a paisa, which reconciliation flags.
      const r = applyTaxes(1333.33, { taxRate: 18, tdsRate: 10 });
      expect(r.taxAmount).toBe(240);
      expect(r.tdsAmount).toBe(133.33);
      expect(r.totalAmount).toBe(round2(1333.33 + 240 - 133.33));
    });
  });
});

const round2 = (n: number) => Math.round(n * 100) / 100;