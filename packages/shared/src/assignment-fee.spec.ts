import { describeAssignmentFee, previewFeeChange, seedTravelInput } from './assignment-fee';

/**
 * The fee rules, held still.
 *
 * `packages/shared` had no test runner at all, which is why three packages could each carry their
 * own version of "what is this assignment's fee" and disagree without anything noticing. Every
 * block below is a bug that reached users.
 */
describe('describeAssignmentFee', () => {
  const quoted = { proposedFee: 1900, quotedBaseFee: 1250, quotedTravelFee: 650 };

  it('prefers the agreed fee and marks it settled', () => {
    const v = describeAssignmentFee({ ...quoted, agreedFee: 1900 });
    expect(v.total).toBe(1900);
    expect(v.settled).toBe(true);
    expect(v.source).toBe('AGREED');
  });

  it('falls back to the proposed fee, unsettled', () => {
    const v = describeAssignmentFee(quoted);
    expect(v.total).toBe(1900);
    expect(v.settled).toBe(false);
    expect(v.source).toBe('PROPOSED');
  });

  /**
   * The web bug. `utils/money.ts` gated on `Number.isFinite` rather than `> 0`, so a stored 0
   * rendered as a confident "₹0" — a claim that the job pays nothing — while the backend booked
   * `source: 'NONE'` and mobile said "not set". A desk override of 0 passes API validation, so this
   * was reachable, not theoretical.
   */
  it('treats a zero fee as NO fee, never as ₹0', () => {
    const v = describeAssignmentFee({ proposedFee: 0, agreedFee: 0 });
    expect(v.total).toBeNull();
    expect(v.source).toBe('NONE');
    expect(v.text.total).toBe('—');
    expect(v.text.breakdown).toBe('No fee set');
  });

  it('treats absent, null and empty-string fees as no fee', () => {
    for (const input of [{}, { proposedFee: null }, { proposedFee: '' }, null, undefined]) {
      expect(describeAssignmentFee(input as any).total).toBeNull();
    }
  });

  it('splits the total into the audit fee and the journey', () => {
    const v = describeAssignmentFee(quoted);
    expect(v.base).toBe(1250);
    expect(v.travel).toBe(650);
    expect(v.splitSource).toBe('QUOTED');
    expect(v.text.breakdown).toContain('audit fee');
  });

  /**
   * Order matters, and getting it wrong shipped twice: a screen seeded from `quotedTravelFee`
   * after the desk had already countered showed the assayer the ORIGINAL quote, so they
   * re-countered against a number nobody was offering any more.
   */
  it('prefers the countered travel over the original quote, and keeps both', () => {
    const v = describeAssignmentFee({ ...quoted, counterTravelFee: 900, proposedFee: 2150 });
    expect(v.travel).toBe(900);
    expect(v.quotedTravel).toBe(650);
    expect(v.splitSource).toBe('COUNTERED');
  });

  it('accepts a countered travel of zero — a branch inside the free commute allowance', () => {
    const v = describeAssignmentFee({ ...quoted, counterTravelFee: 0, proposedFee: 1250 });
    expect(v.travel).toBe(0);
    expect(v.splitSource).toBe('COUNTERED');
    expect(v.inconsistent).toBe(false);
  });

  it('derives the audit fee when the quote recorded no base', () => {
    const v = describeAssignmentFee({ proposedFee: 1900, quotedTravelFee: 650 });
    expect(v.base).toBe(1250);
  });

  it('flags a split that does not add up rather than hiding it', () => {
    const v = describeAssignmentFee({ proposedFee: 1900, quotedBaseFee: 1000, quotedTravelFee: 650 });
    expect(v.inconsistent).toBe(true);
  });

  /**
   * An offer made before the quote columns existed. A total is known; the split is not. Countering
   * on travel would silently reprice the audit itself, so it must be refused.
   */
  it('refuses to offer a travel counter when no split is knowable', () => {
    const v = describeAssignmentFee({ proposedFee: 1900 });
    expect(v.splitSource).toBe('LEGACY_UNSPLIT');
    expect(v.counterable).toBe(false);
    expect(v.base).toBeNull();
    expect(v.text.breakdown).toBe(v.text.total);
  });

  it('reads numeric strings, as Postgres decimals arrive', () => {
    const v = describeAssignmentFee({ proposedFee: '1900.00', quotedBaseFee: '1250.00', quotedTravelFee: '650.00' });
    expect(v.total).toBe(1900);
    expect(v.base).toBe(1250);
  });
});

describe('previewFeeChange', () => {
  const view = describeAssignmentFee({ proposedFee: 1900, quotedBaseFee: 1250, quotedTravelFee: 650 });

  it('adds the typed travel to the audit fee — never replaces the total', () => {
    const p = previewFeeChange(view, '500');
    expect(p.travel).toBe(500);
    expect(p.newTotal).toBe(1750);
    expect(p.error).toBeNull();
  });

  /**
   * The Operations Inbox bug: a lane headed "Travel fee" posted the figure as a whole fee, and the
   * backend carved `max(0, 650 − 1250)` — travel silently became ₹0 and the offer dropped to the
   * base. The bodies below are the only ones any screen should send, so the two fields cannot be
   * swapped by hand again.
   */
  it('produces the request bodies, so no screen assembles one by hand', () => {
    const p = previewFeeChange(view, '500');
    expect(p.body.counter).toEqual({ targetStatus: 'NEGOTIATION', counterTravelFee: 500 });
    expect(p.body.firstOffer).toEqual({ proposedFee: 1750 });
  });

  /** Mobile blocked this: `parseRupeeInput` returns null for 0, so ₹0 travel was un-enterable. */
  it('accepts ₹0 travel', () => {
    const p = previewFeeChange(view, '0');
    expect(p.travel).toBe(0);
    expect(p.newTotal).toBe(1250);
    expect(p.error).toBeNull();
  });

  it('accepts Indian digit grouping and a rupee sign', () => {
    expect(previewFeeChange(view, '1,200').travel).toBe(1200);
    expect(previewFeeChange(view, '₹ 1,200').travel).toBe(1200);
  });

  it('refuses input that is not a rupee amount', () => {
    for (const bad of ['', '   ', 'abc', '-50', '1.234']) {
      const p = previewFeeChange(view, bad);
      expect(p.travel).toBeNull();
      expect(p.error).toBeTruthy();
    }
  });

  it('refuses to preview a counter on an offer with no known audit fee', () => {
    const legacy = describeAssignmentFee({ proposedFee: 1900 });
    const p = previewFeeChange(legacy, '500');
    expect(p.error).toContain('no recorded audit fee');
    expect(p.body.counter).toBeNull();
  });

  it('states the arithmetic in words the desk can check', () => {
    expect(previewFeeChange(view, '500').text).toContain('the assayer sees');
  });
});

describe('seedTravelInput', () => {
  /**
   * Every historical bug in this area was a screen seeding a travel field from the TOTAL. There is
   * deliberately no exported helper that would return one, so the mistake is not re-typeable.
   */
  it('seeds the travel component, never the total', () => {
    const view = describeAssignmentFee({ proposedFee: 1900, quotedBaseFee: 1250, quotedTravelFee: 650 });
    expect(seedTravelInput(view)).toBe('650');
    expect(seedTravelInput(view)).not.toBe('1900');
  });

  it('seeds the countered travel once one exists', () => {
    const view = describeAssignmentFee({ proposedFee: 2150, quotedBaseFee: 1250, quotedTravelFee: 650, counterTravelFee: 900 });
    expect(seedTravelInput(view)).toBe('900');
  });

  it('leaves the box empty when nothing is on the table, rather than answering wrongly', () => {
    expect(seedTravelInput(describeAssignmentFee({ proposedFee: 1900 }))).toBe('');
  });
});
