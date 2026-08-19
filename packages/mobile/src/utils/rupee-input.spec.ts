import { parseRupeeInput, formatRupees } from '@fapoms/shared';

/**
 * The regression this exists for: a claim typed as "1,000" was filed as ₹0 and confirmed back to
 * the assayer as "₹1,000 awaiting approval".
 *
 * Three faults lined up. The form validated with `parseFloat`, which reads "1,000" as 1 and
 * passes. The submit used `Number`, which reads it as NaN. `|| 0` turned that into a silent zero,
 * and the success toast interpolated the raw text rather than the number actually sent. Every
 * layer looked reasonable alone.
 *
 * `parseRupeeInput` is now the single reading of an amount field, and returns `null` rather than
 * 0 so "unusable input" cannot be mistaken for "they meant nothing".
 */
describe('parseRupeeInput', () => {
  it('reads the grouped forms an Indian user actually types', () => {
    expect(parseRupeeInput('1,000')).toBe(1000);
    expect(parseRupeeInput('1,00,000')).toBe(100000);
    expect(parseRupeeInput('₹2,500')).toBe(2500);
    expect(parseRupeeInput(' 750 ')).toBe(750);
  });

  it('reads plain and decimal amounts', () => {
    expect(parseRupeeInput('1000')).toBe(1000);
    expect(parseRupeeInput('1000.50')).toBe(1000.5);
    expect(parseRupeeInput('.5')).toBe(0.5);
    expect(parseRupeeInput(1250)).toBe(1250);
  });

  it('refuses input rather than coercing it to zero', () => {
    expect(parseRupeeInput('')).toBeNull();
    expect(parseRupeeInput('   ')).toBeNull();
    expect(parseRupeeInput('abc')).toBeNull();
    expect(parseRupeeInput(null)).toBeNull();
    expect(parseRupeeInput(undefined)).toBeNull();
  });

  it('refuses zero and negatives — a claim must be for an amount', () => {
    expect(parseRupeeInput('0')).toBeNull();
    expect(parseRupeeInput('-500')).toBeNull();
    expect(parseRupeeInput(0)).toBeNull();
    expect(parseRupeeInput(-1)).toBeNull();
  });

  it('refuses the inputs parseFloat would silently read a prefix out of', () => {
    // parseFloat('12abc') === 12, parseFloat('1.2.3') === 1.2 — both would have passed validation
    // and then submitted as NaN.
    expect(parseRupeeInput('12abc')).toBeNull();
    expect(parseRupeeInput('1.2.3')).toBeNull();
    expect(parseRupeeInput('1e5')).toBeNull();
    expect(parseRupeeInput('NaN')).toBeNull();
    expect(parseRupeeInput(Infinity)).toBeNull();
  });

  it('round-trips with formatRupees, so the toast shows what was filed', () => {
    const parsed = parseRupeeInput('1,000');
    expect(parsed).toBe(1000);
    expect(formatRupees(parsed)).toBe('₹1,000');
  });
});
