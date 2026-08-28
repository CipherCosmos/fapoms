import {
  payableCost, entryRevenue, totalPayableCost, totalEntryRevenue, margin, assignmentFee,
  applyTaxes, assignmentMoney, round2, MoneyContext,
} from './assignment-money';

/**
 * The one formula the whole billing surface reports from.
 *
 * These matter more than most tests here: margin is a subtraction, so a change to either side
 * that is not matched on the other does not fail loudly — it quietly reports a different profit.
 * What is pinned below is the *meaning* of each figure, not just its arithmetic.
 */
describe('assignment money', () => {
  /** A client with a rate card: ₹3,000 per audit, travel recharged, 18% GST, 10% TDS each way. */
  const rateCard: MoneyContext = {
    clientRate: 3000,
    rechargeTravel: true,
    gstRate: 18,
    clientTdsRate: 10,
    assayerTdsRate: 10,
    legacyTravelReimbursement: null,
  };
  /** A client with no rate: the assayer's fee passes through at cost. */
  const passThrough: MoneyContext = { ...rateCard, clientRate: null };

  describe('assignmentFee — what an assignment is worth', () => {
    it('books the agreed fee when there is one, and says it was agreed', () => {
      expect(assignmentFee({ agreedFee: 2500, proposedFee: 2000 })).toEqual({ amount: 2500, settled: true, source: 'AGREED' });
    });

    it('never lets the proposed fee become the agreed one — the agreed figure wins outright', () => {
      // Negotiation can settle below the offer. Reading the offer would overpay the assayer and
      // overbill the client by the difference on every renegotiated job.
      expect(assignmentFee({ agreedFee: 1800, proposedFee: 2400 }).amount).toBe(1800);
    });

    it('falls back to the proposed fee when none was agreed, and says so', () => {
      // One precedence for BOTH sides. The previous engine paid the assayer from the offer and
      // refused to bill the client, so a completed-but-unagreed assignment booked cost and never
      // revenue. Now it books symmetrically and `settled: false` puts it on the attention list.
      expect(assignmentFee({ proposedFee: 2000 })).toEqual({ amount: 2000, settled: false, source: 'PROPOSED' });
    });

    it('reports nothing to book when neither figure exists', () => {
      expect(assignmentFee({})).toEqual({ amount: 0, settled: false, source: 'NONE' });
    });

    it('treats a zero or unparseable agreed fee as unsettled rather than as a free job', () => {
      expect(assignmentFee({ agreedFee: 0, proposedFee: 2000 })).toEqual({ amount: 2000, settled: false, source: 'PROPOSED' });
      expect(assignmentFee({ agreedFee: 'oops' as any, proposedFee: 2000 }).amount).toBe(2000);
    });

    it('reads a decimal string from the database as the number it represents', () => {
      expect(assignmentFee({ agreedFee: '2500.00' }).amount).toBe(2500);
    });
  });

  describe('assignmentMoney — the whole line', () => {
    it('carves the agreed fee into base + travel so gross equals the fee exactly', () => {
      // The agreed fee already CONTAINS travel; the mobile app says so to the assayer. Paying
      // the fee whole and adding travel on top paid the journey twice.
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, rateCard);
      expect(m.assayer).toEqual({ base: 1700, travel: 300, gross: 2000, tds: 200, net: 1800 });
    });

    it('clamps travel to the fee so a hard negotiation can never produce a negative base', () => {
      const m = assignmentMoney({ agreedFee: 250, quotedTravelFee: 300 }, rateCard);
      expect(m.assayer).toEqual({ base: 0, travel: 250, gross: 250, tds: 25, net: 225 });
    });

    it('bills the client at the rate card, plus the same travel the assayer is paid', () => {
      // Revenue is independent of cost — that spread is the margin the business earns.
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, rateCard);
      expect(m.client).toEqual({
        base: 3000, travel: 300, adjustment: 0, taxable: 3300, gst: 594, tds: 330, total: 3564, pricedFrom: 'CLIENT_RATE',
      });
    });

    it('passes the fee through at cost when the client has no rate, without billing travel twice', () => {
      // base + travel === the agreed fee. The old pass-through billed the whole fee AND added
      // travel, and the duplicate surfaced as "margin".
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, passThrough);
      expect(m.client.base + m.client.travel).toBe(2000);
      expect(m.client).toMatchObject({ base: 1700, travel: 300, taxable: 2000, pricedFrom: 'PASS_THROUGH' });
      expect(m.client.taxable).toBe(m.assayer.gross);
    });

    it('keeps travel off the client line when the contract is all-inclusive', () => {
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, { ...rateCard, rechargeTravel: false });
      expect(m.client.travel).toBe(0);
      expect(m.client.taxable).toBe(3000);
      // …but the assayer is still paid it.
      expect(m.assayer.travel).toBe(300);
    });

    it('applies a per-job adjustment to the taxable value and re-taxes it', () => {
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, { ...rateCard, adjustmentAmount: -300 });
      expect(m.client).toMatchObject({ adjustment: -300, taxable: 3000, gst: 540, tds: 300, total: 3240 });
    });

    it('preserves the legacy behaviour for offers that recorded no travel component', () => {
      // Restating history is worse than the known flaw: fee whole, profile reimbursement on top.
      const m = assignmentMoney({ agreedFee: 2000 }, { ...passThrough, legacyTravelReimbursement: 150 });
      expect(m.assayer).toMatchObject({ base: 2000, travel: 150, gross: 2150 });
      expect(m.client).toMatchObject({ base: 2000, travel: 150, taxable: 2150 });
    });

    it('ignores the legacy reimbursement whenever a quoted travel figure exists', () => {
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, { ...passThrough, legacyTravelReimbursement: 150 });
      expect(m.assayer.travel).toBe(300);
      expect(m.assayer.gross).toBe(2000);
    });

    it('withholds TDS on the gross and never adds GST on the assayer side', () => {
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, { ...rateCard, assayerTdsRate: 2 });
      expect(m.assayer.tds).toBe(40);
      expect(m.assayer.net).toBe(1960);
    });

    it('books from the proposed fee when nothing was agreed, and reports it unsettled', () => {
      const m = assignmentMoney({ proposedFee: 2000, quotedTravelFee: 300 }, rateCard);
      expect(m.fee).toEqual({ amount: 2000, settled: false, source: 'PROPOSED' });
      expect(m.assayer.gross).toBe(2000);
      expect(m.client.total).toBe(3564);
    });

    it('reports nothing when there is no fee at all', () => {
      const m = assignmentMoney({}, rateCard);
      expect(m.fee.source).toBe('NONE');
      expect(m.assayer.gross).toBe(0);
      // The client side still prices the rate card — what the line WOULD be — but the booking
      // path refuses to write anything when the fee source is NONE.
      expect(m.client.base).toBe(3000);
    });

    it('reads decimal strings from the database as numbers', () => {
      const m = assignmentMoney({ agreedFee: '2000.00', quotedTravelFee: '300.00' }, rateCard);
      expect(m.assayer.gross).toBe(2000);
    });
  });

  describe('payableCost / entryRevenue — reading money back off stored rows', () => {
    it('cost is base plus travel — the GROSS, before TDS', () => {
      // A payable of 1460 gross with 10% TDS pays out 1314 in cash, but it cost 1460 to have
      // the work done. Netting the withholding off would overstate margin on every single job.
      expect(payableCost({ baseAmount: 1200, travelAmount: 260, tdsAmount: 146, totalAmount: 1314 } as any)).toBe(1460);
    });

    it('reads a raw SQL row exactly as it reads an entity', () => {
      expect(payableCost({ base_amount: '1200.00', travel_amount: '260.00' }))
        .toBe(payableCost({ baseAmount: 1200, travelAmount: 260 }));
    });

    it('treats absent or unparseable components as zero rather than NaN', () => {
      expect(payableCost({ baseAmount: 1200 })).toBe(1200);
      expect(payableCost({ baseAmount: 'oops' as any, travelAmount: 100 })).toBe(100);
      expect(payableCost({})).toBe(0);
    });

    it('revenue is the taxable value, falling back to base for rows written before it existed', () => {
      expect(entryRevenue({ taxableAmount: 3400, baseAmount: 3000 })).toBe(3400);
      expect(entryRevenue({ baseAmount: 3000 })).toBe(3000);
      expect(entryRevenue({ taxableAmount: 0, baseAmount: 3000 })).toBe(0);
    });

    it('sums and margins', () => {
      expect(totalPayableCost([{ baseAmount: 1200, travelAmount: 260 }, { baseAmount: 1500, travelAmount: 0 }])).toBe(2960);
      expect(totalEntryRevenue([{ taxableAmount: 3400 }, { baseAmount: 3000 }])).toBe(6400);
      expect(margin(6400, 2960)).toEqual({ margin: 3440, marginPct: 53.75 });
      expect(margin(0, 1460)).toEqual({ margin: -1460, marginPct: null });
    });
  });

  describe('applyTaxes — how a taxable value settles', () => {
    it('adds gst and withholds tds, both on the taxable value', () => {
      expect(applyTaxes(10000, { taxRate: 18, tdsRate: 10 })).toEqual({ taxAmount: 1800, tdsAmount: 1000, totalAmount: 10800 });
    });

    it('does NOT withhold tds on the gst', () => {
      expect(applyTaxes(10000, { taxRate: 18, tdsRate: 10 }).tdsAmount).toBe(1000);
    });

    it('treats absent rates as zero, leaving the taxable value untouched', () => {
      expect(applyTaxes(1460, {})).toEqual({ taxAmount: 0, tdsAmount: 0, totalAmount: 1460 });
    });

    it('rounds each component to paise rather than carrying float error into the total', () => {
      const r = applyTaxes(1333.33, { taxRate: 18, tdsRate: 10 });
      expect(r.taxAmount).toBe(240);
      expect(r.tdsAmount).toBe(133.33);
      expect(r.totalAmount).toBe(round2(1333.33 + 240 - 133.33));
    });
  });

  /**
   * A counter-offer moves the journey, not the price of the work.
   *
   * The audit fee comes from the rate card — neither the assayer nor the desk sets it. Before
   * this, a counter moved the *total* and the carve took travel back out at the frozen quoted
   * figure, so every rupee negotiated landed in the base: the payable's base fee silently
   * disagreed with the rate card that produced it, and "we agreed 2,300" told you nothing about
   * whether the work or the journey had been repriced.
   */
  describe('when travel was countered', () => {
    it('pays the agreed travel, not the quoted travel', () => {
      const m = assignmentMoney(
        { agreedFee: 2350, quotedTravelFee: 300, counterTravelFee: 650 },
        rateCard,
      );
      expect(m.assayer.travel).toBe(650);
    });

    it('leaves the audit fee exactly where the rate card put it', () => {
      // Quote was base 1,700 + travel 300 = 2,000. Travel countered to 650, so the total is
      // 2,350 — and the base must still be 1,700, not 2,050.
      const m = assignmentMoney(
        { agreedFee: 2350, quotedTravelFee: 300, counterTravelFee: 650 },
        rateCard,
      );
      expect(m.assayer.base).toBe(1700);
      expect(m.assayer.gross).toBe(2350);
    });

    it('falls back to the quoted travel when nothing was countered', () => {
      const m = assignmentMoney({ agreedFee: 2000, quotedTravelFee: 300 }, rateCard);
      expect(m.assayer.travel).toBe(300);
      expect(m.assayer.base).toBe(1700);
    });

    it('treats a countered travel of zero as a real answer, not as absent', () => {
      // Inside the free commute allowance the agreed travel is nothing, and that is a decision —
      // it must not fall through to the quoted figure.
      const m = assignmentMoney(
        { agreedFee: 1700, quotedTravelFee: 300, counterTravelFee: 0 },
        rateCard,
      );
      expect(m.assayer.travel).toBe(0);
      expect(m.assayer.base).toBe(1700);
    });

    it('never produces a negative base, however the total and travel disagree', () => {
      // The clamp that has always guarded this: a total below the travel figure would otherwise
      // carve out more than there is.
      const m = assignmentMoney(
        { agreedFee: 400, quotedTravelFee: 300, counterTravelFee: 900 },
        rateCard,
      );
      expect(m.assayer.base).toBeGreaterThanOrEqual(0);
      expect(m.assayer.gross).toBe(400);
    });

    it('keeps gross equal to the fee exactly, which the whole carve exists to do', () => {
      for (const counterTravelFee of [0, 125, 650, 2350]) {
        const m = assignmentMoney(
          { agreedFee: 2350, quotedTravelFee: 300, counterTravelFee },
          rateCard,
        );
        expect(m.assayer.base + m.assayer.travel).toBe(m.assayer.gross);
        expect(m.assayer.gross).toBe(2350);
      }
    });
  });
});