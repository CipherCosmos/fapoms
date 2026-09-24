import { formatRupees } from './utils';
import {
  roundMoney,
  indianFinancialYear,
  formatClientInvoiceNumber,
  CLIENT_INVOICE_NUMBER_PATTERN,
  tds194jDeduction,
} from './billing-money-rules';

describe('roundMoney — paise, half away from zero, without binary noise (F14)', () => {
  it.each([
    [1.005, 1.01],
    [10000.005, 10000.01],
    [0.285, 0.29],
    [1.255, 1.26],
    [8.345, 8.35],
    [2.675, 2.68],
    [1.004, 1],
    [1.0049999, 1],
    [0.1 + 0.2, 0.3],
    [1234567.895, 1234567.9],
    [0, 0],
  ])('%p → %p', (input, expected) => {
    expect(roundMoney(input)).toBe(expected);
  });

  it('rounds a credit to the same size as the charge it reverses', () => {
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(-10000.005)).toBe(-10000.01);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
    expect(Object.is(roundMoney(-0), 0)).toBe(true);
  });

  it('passes non-finite input through, as the old helper did', () => {
    expect(roundMoney(NaN)).toBeNaN();
    expect(roundMoney(Infinity)).toBe(Infinity);
  });

  it('is the fix: the old formula got 1.005 wrong', () => {
    expect(Math.round(1.005 * 100) / 100).toBe(1);
  });
});

describe('indianFinancialYear — April to March on the Indian calendar day', () => {
  it('puts 31 March in the year that is ending and 1 April in the new one', () => {
    expect(indianFinancialYear('2026-03-31').label).toBe('25-26');
    expect(indianFinancialYear('2026-04-01').label).toBe('26-27');
  });

  it('judges a timestamp by the day in India, not the UTC day', () => {
    // 1 April 02:00 IST is still 31 March in UTC.
    const fy = indianFinancialYear(new Date('2026-03-31T20:30:00Z'));
    expect(fy).toEqual({ startYear: 2026, label: '26-27', from: '2026-04-01', to: '2027-03-31' });
    // 31 March 23:00 IST.
    expect(indianFinancialYear(new Date('2026-03-31T17:30:00Z')).label).toBe('25-26');
  });

  it('pads the century turn', () => {
    expect(indianFinancialYear('2099-12-01').label).toBe('99-00');
    expect(indianFinancialYear('2100-01-01').label).toBe('99-00');
  });

  it('refuses something that is not a date', () => {
    expect(() => indianFinancialYear('nonsense')).toThrow();
  });
});

describe('formatClientInvoiceNumber — INV/25-26/000123 (F7)', () => {
  it('zero-pads the serial to six digits and fits in sixteen characters', () => {
    const n = formatClientInvoiceNumber('25-26', 123);
    expect(n).toBe('INV/25-26/000123');
    expect(n.length).toBe(16);
    expect(CLIENT_INVOICE_NUMBER_PATTERN.test(n)).toBe(true);
    expect(formatClientInvoiceNumber('25-26', 999999)).toBe('INV/25-26/999999');
  });

  it('refuses a serial the field cannot hold, and a malformed year', () => {
    expect(() => formatClientInvoiceNumber('25-26', 0)).toThrow();
    expect(() => formatClientInvoiceNumber('25-26', 1_000_000)).toThrow();
    expect(() => formatClientInvoiceNumber('25-26', 1.5)).toThrow();
    expect(() => formatClientInvoiceNumber('2025-26', 1)).toThrow();
  });

  it('does not match the old numbers, which keep their form', () => {
    expect(CLIENT_INVOICE_NUMBER_PATTERN.test('INV-MF3K2-123456')).toBe(false);
  });
});

describe('tds194jDeduction — the annual threshold and the catch-up (F15)', () => {
  const base = { ratePct: 10, thresholdRupees: 50000, fyGrossBefore: 0, fyTdsBefore: 0 };

  it('withholds nothing while the year stays below the threshold', () => {
    expect(tds194jDeduction({ ...base, gross: 20000 })).toEqual({ tds: 0, basis: 'BELOW_THRESHOLD', fyGrossIncluding: 20000 });
  });

  it('withholds nothing when the year lands exactly on the threshold — it must be exceeded', () => {
    expect(tds194jDeduction({ ...base, gross: 10000, fyGrossBefore: 40000 }).tds).toBe(0);
  });

  it('makes the crossing payable carry the whole year', () => {
    // 45,000 earlier with nothing withheld; this 10,000 takes the year to 55,000 → 5,500 due.
    const out = tds194jDeduction({ ...base, gross: 10000, fyGrossBefore: 45000 });
    expect(out).toEqual({ tds: 5500, basis: 'CROSSED', fyGrossIncluding: 55000 });
  });

  it('withholds at the rate once the year is already past the threshold', () => {
    const out = tds194jDeduction({ ...base, gross: 2000, fyGrossBefore: 55000, fyTdsBefore: 5500 });
    expect(out).toEqual({ tds: 200, basis: 'ABOVE', fyGrossIncluding: 57000 });
  });

  it('caps the catch-up at the payable itself and leaves the rest for the next one', () => {
    const crossing = tds194jDeduction({ ...base, gross: 2000, fyGrossBefore: 49000 });
    expect(crossing.tds).toBe(2000); // 5,100 due, only 2,000 to withhold from
    const next = tds194jDeduction({ ...base, gross: 5000, fyGrossBefore: 51000, fyTdsBefore: 2000 });
    expect(next.tds).toBe(3600); // 5,600 due on 56,000, 2,000 already withheld
  });

  it('hands the catch-up to the next payable when the one that carried it is voided', () => {
    // The voided payable is simply absent from "before": the next one sees an un-withheld year.
    expect(tds194jDeduction({ ...base, gross: 3000, fyGrossBefore: 52000, fyTdsBefore: 0 }).tds).toBe(3000);
    expect(tds194jDeduction({ ...base, gross: 8000, fyGrossBefore: 52000, fyTdsBefore: 0 }).tds).toBe(6000);
  });

  it('never goes negative when earlier payables were withheld at the higher no-PAN rate', () => {
    expect(tds194jDeduction({ ...base, gross: 1000, fyGrossBefore: 60000, fyTdsBefore: 12000 }).tds).toBe(0);
  });

  it('keeps the old behaviour when the threshold is 0', () => {
    expect(tds194jDeduction({ ...base, thresholdRupees: 0, gross: 2000, fyGrossBefore: 0 }))
      .toEqual({ tds: 200, basis: 'NO_THRESHOLD', fyGrossIncluding: 2000 });
  });

  it('applies the no-PAN rate the caller passes', () => {
    expect(tds194jDeduction({ ...base, ratePct: 20, gross: 1000, fyGrossBefore: 60000, fyTdsBefore: 6000 }).tds).toBe(1000);
  });
});

describe('formatRupees at two decimals uses the same paise rounding', () => {
  it('prints ₹1.005 as ₹1.01, and does not double-round whole rupees', () => {
    expect(formatRupees(1.005, { decimals: 2 })).toBe('₹1.01');
    expect(formatRupees(2.495, { decimals: 0 })).toBe('₹2');
  });
});
