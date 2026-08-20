import { daysUntilExpiry } from '@fapoms/shared';

/**
 * One clock decides whether a credential has run out.
 *
 * The HR service asks Postgres for `expiry_date::date - (today in India)` — a difference
 * between two calendar dates. Three screens asked the browser for
 * `Math.ceil((new Date(iso) - Date.now()) / 86400000)` instead — a difference between two
 * instants, on the device's own clock. They disagree every day between midnight and 05:30 IST,
 * and whenever a laptop's clock is off.
 *
 * The consequence was a compliance screen and a person's own record contradicting each other
 * about whether that person was allowed to work: the console's badge said a certificate had
 * already run out and chipped it red, while the Skills tab chipped it amber "0d left" and
 * withheld the warning that says this assayer cannot be given work.
 */
describe('days until a credential expires', () => {
  const realNow = Date.now;
  afterEach(() => { Date.now = realNow; jest.useRealTimers(); });

  /** Freeze the wall clock at an instant, the way the browser would see it. */
  const at = (iso: string) => { jest.useFakeTimers(); jest.setSystemTime(new Date(iso)); };

  it('counts calendar days, so an expiry today is zero all day', () => {
    at('2026-08-20T04:00:00Z'); // 09:30 IST on the 20th
    expect(daysUntilExpiry('2026-08-20T00:00:00Z')).toBe(0);
    at('2026-08-20T17:00:00Z'); // 22:30 IST, same working day
    expect(daysUntilExpiry('2026-08-20T00:00:00Z')).toBe(0);
  });

  it('turns negative on the Indian day the credential lapses, not five hours later', () => {
    // 01:30 IST on 1 September: a new working day, and the 31st is behind us.
    at('2026-08-31T20:00:00Z');
    expect(daysUntilExpiry('2026-08-31T00:00:00Z')).toBe(-1);
    // The old browser rule measured instants, so it rounded this to zero — the screen said
    // "0d left" while the server had already counted the credential expired.
    const byTheOldRule = Math.ceil((Date.parse('2026-08-31T00:00:00Z') - Date.now()) / 86_400_000);
    expect(byTheOldRule).not.toBe(-1);
    expect(Math.abs(byTheOldRule)).toBe(0);
  });

  it('agrees with itself either side of UTC midnight', () => {
    at('2026-08-19T23:59:00Z'); // 05:29 IST on the 20th
    const before = daysUntilExpiry('2026-08-25T00:00:00Z');
    at('2026-08-20T00:01:00Z'); // 05:31 IST on the 20th
    expect(daysUntilExpiry('2026-08-25T00:00:00Z')).toBe(before);
  });

  it('counts forward for a future date', () => {
    at('2026-08-20T04:00:00Z');
    expect(daysUntilExpiry('2026-08-25T00:00:00Z')).toBe(5);
  });

  it('says nothing when no expiry is recorded', () => {
    expect(daysUntilExpiry(null)).toBeNull();
    expect(daysUntilExpiry('')).toBeNull();
    expect(daysUntilExpiry('not-a-date')).toBeNull();
  });
});
