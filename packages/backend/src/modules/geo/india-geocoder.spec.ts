import { canonicalState } from './india-geocoder';

/**
 * Regression guard for the state-abbreviation fallback used by `geocodeIndiaRobust` (see the
 * comment above `canonicalState`). This used to be a private alias table duplicated in this
 * file; it now delegates to `@fapoms/shared`'s `canonicalStateName`. The point of this test is
 * NOT "does it compile" — it is that the specific abbreviations real appraiser rosters use, which
 * this file's own table used to resolve, still resolve to a usable full state name after the
 * switch.
 */
describe('canonicalState', () => {
  it('expands a dotted/short abbreviation a roster actually uses ("A.P" style: bare "ap")', () => {
    expect(canonicalState('ap')).toBe('Andhra Pradesh');
  });

  it('expands "mp" to Madhya Pradesh', () => {
    expect(canonicalState('mp')).toBe('Madhya Pradesh');
  });

  it('expands "up" to Uttar Pradesh', () => {
    expect(canonicalState('up')).toBe('Uttar Pradesh');
  });

  it('expands "tn" to Tamil Nadu', () => {
    expect(canonicalState('tn')).toBe('Tamil Nadu');
  });

  it('expands "wb" to West Bengal', () => {
    expect(canonicalState('wb')).toBe('West Bengal');
  });

  it('resolves "J&K" style input ("jk") to Jammu and Kashmir', () => {
    expect(canonicalState('jk')).toBe('Jammu and Kashmir');
  });

  it('resolves a bare code the shared function does not expand ("or" collides with English)', () => {
    // canonicalStateName('or') returns null — a bare two-letter code is genuinely ambiguous for
    // a function serving callers far beyond a state column. This is exactly what stayed local.
    expect(canonicalState('or')).toBe('Odisha');
  });

  it('resolves a despaced variant a real import used ("ANDRAPRADESH")', () => {
    expect(canonicalState('ANDRAPRADESH')).toBe('Andhra Pradesh');
  });

  it('passes through an already-canonical name unchanged', () => {
    expect(canonicalState('Karnataka')).toBe('Karnataka');
  });

  it('returns empty string for empty/null/undefined input without throwing', () => {
    expect(canonicalState('')).toBe('');
    expect(canonicalState(null)).toBe('');
    expect(canonicalState(undefined)).toBe('');
  });

  it('falls back to the trimmed original for input no table recognises as a state', () => {
    expect(canonicalState('  Narnia  ')).toBe('Narnia');
  });
});
