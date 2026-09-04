import { ParsePagePipe } from './parse-page.pipe';

/**
 * The gap this pipe closes: `GET /assayers?page=0`, `?page=-1` and `?page=abc` each reached
 * `AssayerService.findAll` / `RosterQueryService.findFiltered` unguarded, turned into
 * `skip: (page - 1) * limit`, and blew up as an unhandled 500 — `QueryFailedError: OFFSET must
 * not be negative` for 0/-1, `TypeORMError: Provided "skip" value is not a number` for "abc" —
 * confirmed live against the running server. `limit` on the very same routes already had
 * `ParseLimitPipe`; `page` had no pipe at all.
 */
describe('ParsePagePipe', () => {
  const run = (v: unknown) => new ParsePagePipe().transform(v, {} as any);

  it('defaults to 1 when the query param is missing', () => {
    expect(run(undefined)).toBe(1);
  });

  it('falls back to 1 on non-numeric garbage', () => {
    expect(run('abc')).toBe(1);
    expect(run('NaN')).toBe(1);
    expect(run('')).toBe(1);
    expect(run(null)).toBe(1);
  });

  it('falls back to 1 on zero or negative input — the exact requests that used to 500', () => {
    expect(run('0')).toBe(1);
    expect(run(0)).toBe(1);
    expect(run('-1')).toBe(1);
    expect(run(-100)).toBe(1);
  });

  it('passes a valid positive integer through unchanged', () => {
    expect(run('75')).toBe(75);
    expect(run(30)).toBe(30);
    expect(run('1')).toBe(1);
  });

  it('floors a fractional value rather than rejecting it', () => {
    expect(run('2.9')).toBe(2);
  });

  it('falls back to 1 rather than returning zero when flooring a sub-1 fraction', () => {
    expect(run('0.5')).toBe(1);
  });

  it('has no upper bound — a page far past the last one is valid, not an error', () => {
    expect(run('999999')).toBe(999999);
  });

  it('treats a repeated query key (array value) by taking the first entry', () => {
    expect(run(['3', '20'])).toBe(3);
    expect(run(['abc', '20'])).toBe(1);
  });
});
