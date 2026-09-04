import { displayedTds } from './earnings-breakdown';

/**
 * The rounding-reconciliation bug found live on a real payout: three independently-rounded
 * whole-rupee figures (base, travel, TDS) did not sum to the headline total, which is rounded
 * separately from all three. See `displayedTds`'s own comment for the exact numbers.
 */
describe('displayedTds', () => {
  it('reconciles the exact figures found live: 1800 + 605 - 240.50 = 2164.50', () => {
    // Naively rounding tdsAmount on its own gives 241 (1800 + 605 - 241 = 2164, a rupee short
    // of the 2165 headline). The reconciled figure must make the three displayed parts sum to
    // the displayed total instead.
    const tds = displayedTds(1800, 605, 2164.5);
    expect(tds).toBe(240);
    expect(Math.round(1800) + Math.round(605) - tds).toBe(Math.round(2164.5));
  });

  it('leaves an already-consistent breakdown alone', () => {
    // Whole-rupee figures that already reconcile must not be perturbed by this.
    expect(displayedTds(2000, 500, 2400)).toBe(100);
  });

  it('reconciles when the total rounds down instead of up', () => {
    // 1000 + 500 - 150.49 = 1349.51, which rounds to 1350 on its own (no naive mismatch here),
    // but the function must still derive TDS from the actual rounded total, not re-round
    // tdsAmount independently.
    const tds = displayedTds(1000, 500, 1349.51);
    expect(Math.round(1000) + Math.round(500) - tds).toBe(Math.round(1349.51));
  });

  it('holds the reconciliation identity for arbitrary paise-level inputs', () => {
    const cases: Array<[number, number, number]> = [
      [1800, 605, 2164.5],
      [1200.5, 300.5, 1420.75],
      [999.49, 1.5, 950.99],
      [0, 0, 0],
    ];
    for (const [base, travel, total] of cases) {
      const tds = displayedTds(base, travel, total);
      expect(Math.round(base) + Math.round(travel) - tds).toBe(Math.round(total));
    }
  });
});
