import { feeReferenceLine } from './vocabulary';

/**
 * One fee on the form, and the rate card is only a reading beside it.
 *
 * The owner's rule (2026-09-21): the desk rings the assayer, they settle on a number, and that
 * number is typed in — "we are just using that recommended price as our reference, not as our
 * final price… keep each and everything manual, especially for money." And: "keep one fee on the
 * modal, and internally we'll keep the record of base fee and travel fee of each assignment
 * based on the base fee set for an assayer."
 *
 * So the operator is asked for ONE figure. The base/travel split is not theirs to enter — billing
 * carves it from that assayer's own audit fee (`assignment-money.ts`), which is a fact about the
 * person rather than something to re-key per assignment.
 *
 * Two entry points used to disagree about all of this. "Call & Assign" opened a form with an
 * amount box, a read-only rate-card base beside it, and a total labelled "base + travel". "Send
 * to app" opened a confirm dialog with NO box at all and posted no fee, so the rate card's number
 * silently became the recorded number with nobody typing it.
 */
describe('the rate card is a reading, not the price', () => {
  it('offers one figure, because the form asks for one figure', () => {
    const line = feeReferenceLine({ total: 4300 });
    expect(line).toBe('Rate card suggests ₹4,300.');
  });

  it('never announces a split the operator is not being asked for', () => {
    const line = feeReferenceLine({ total: 4300 });
    expect(line).not.toMatch(/audit|travel|base/i);
  });

  it('does not read as a commitment — nothing has been typed yet', () => {
    expect(feeReferenceLine({ total: 4300 })).not.toMatch(/will be recorded|will be charged|final/i);
  });

  it('groups digits the Indian way, since that is who reads it', () => {
    expect(feeReferenceLine({ total: 125000 })).toContain('₹1,25,000');
  });

  it('says when the suggestion rests on a platform default', () => {
    // It changes what the reading is WORTH: a figure from a rate nobody contracted is a weaker
    // starting point than one that was.
    const line = feeReferenceLine({ total: 4300, usedFallbackBaseFee: true });
    expect(line).toMatch(/no contracted rate on file/);
    expect(line).toContain('₹4,300');
  });

  it('does not flag a contracted rate', () => {
    expect(feeReferenceLine({ total: 4300 })).not.toMatch(/platform default/);
  });

  it('tells the desk to type the agreed fee when the card cannot be read', () => {
    const line = feeReferenceLine(null);
    // The form still works without a reference — it is a reading, not a prerequisite.
    expect(line).toMatch(/type the fee you agreed/i);
    expect(line).not.toMatch(/₹/);
  });

  it('rounds to whole rupees rather than putting paise beside an input', () => {
    expect(feeReferenceLine({ total: 4300.49 })).toContain('₹4,300');
  });
});
