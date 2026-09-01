import { ParseLimitPipe } from './parse-limit.pipe';

/**
 * The gap this pipe closes: about twenty list endpoints read `Number(limit)` straight from the
 * query string with no ceiling, so `?limit=5000000` becomes an unclamped `take:` in a TypeORM
 * query — a single-request memory/CPU exhaustion vector. This is the reusable version of the
 * clamp `audit.controller.ts` already hand-rolled once.
 */
describe('ParseLimitPipe', () => {
  const run = (v: unknown, opts?: { default?: number; max?: number }) =>
    new ParseLimitPipe(opts).transform(v, {} as any);

  it('defaults to 50 when the query param is missing', () => {
    expect(run(undefined)).toBe(50);
  });

  it('defaults to 200 as the ceiling when none is given', () => {
    expect(run('999999')).toBe(200);
  });

  it('falls back to the default on non-numeric garbage', () => {
    expect(run('abc')).toBe(50);
    expect(run('NaN')).toBe(50);
    expect(run('')).toBe(50);
    expect(run(null)).toBe(50);
  });

  it('falls back to the default on zero or negative input', () => {
    expect(run('0')).toBe(50);
    expect(run('-5')).toBe(50);
    expect(run(-100)).toBe(50);
  });

  it('clamps an absurdly large value down to max', () => {
    expect(run('5000000', { default: 20, max: 200 })).toBe(200);
    expect(run('1e30')).toBe(200);
  });

  it('passes a valid positive integer within range through unchanged', () => {
    expect(run('75', { default: 20, max: 200 })).toBe(75);
    expect(run(30)).toBe(30);
  });

  it('floors a fractional value rather than rejecting it', () => {
    expect(run('49.9', { default: 20, max: 200 })).toBe(49);
  });

  it('falls back to default rather than returning zero when flooring a sub-1 fraction', () => {
    expect(run('0.5')).toBe(50);
  });

  it('respects a custom default and max', () => {
    expect(run(undefined, { default: 20, max: 200 })).toBe(20);
    expect(run('9999', { default: 20, max: 200 })).toBe(200);
  });

  it('treats a repeated query key (array value) as garbage and falls back to default', () => {
    expect(run(['10', '20'])).toBe(10);
    expect(run(['abc', '20'])).toBe(50);
  });
});
