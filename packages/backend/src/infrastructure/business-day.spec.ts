import { BUSINESS_TODAY_SQL, businessTodayDateKey, businessDateKey } from '@fapoms/shared';

/**
 * One clock for "today", and it is India's.
 *
 * The system had three. JavaScript's `new Date().toISOString().slice(0, 10)` is the UTC date;
 * SQL's `CURRENT_DATE` is the database session's date, and the database runs UTC; and the
 * browser and the phone use the device's own. Between midnight and 05:30 IST the first two are
 * still on yesterday, so for the first five and a half hours of every working day the server
 * disagreed with everyone looking at it.
 *
 * What that cost, concretely: "one reminder per breached item per day" reset at half past five
 * in the morning rather than at midnight, so a breach reminder sent at 11pm silenced the whole
 * of the next morning; an assignment created before 05:30 was scheduled for a date already
 * past; and every "days away", "overdue" and "expiring soon" count was a day out.
 */
describe('the business day', () => {
  it('names the Indian calendar day, whatever the process timezone is', () => {
    // 00:30 IST on the 20th is 19:00 UTC on the 19th. The working day is the 20th.
    const earlyMorningIST = new Date('2026-08-19T19:00:00Z');
    expect(businessDateKey(earlyMorningIST)).toBe('2026-08-20');
    // This is precisely what a UTC slice gets wrong.
    expect(earlyMorningIST.toISOString().slice(0, 10)).toBe('2026-08-19');
  });

  it('agrees with itself either side of the UTC midnight boundary', () => {
    // 05:29 IST and 05:31 IST are the same working day; UTC changes date between them.
    expect(businessDateKey(new Date('2026-08-19T23:59:00Z'))).toBe('2026-08-20');
    expect(businessDateKey(new Date('2026-08-20T00:01:00Z'))).toBe('2026-08-20');
  });

  it('gives SQL the same day, without a parameter to forget to pass', () => {
    // Interpolated straight into a query, so it must be a self-contained expression.
    expect(BUSINESS_TODAY_SQL).toBe("((NOW() AT TIME ZONE 'Asia/Kolkata')::date)");
    expect(BUSINESS_TODAY_SQL).not.toContain('$');
  });

  it("still answers today's date in the shape a date column holds", () => {
    expect(businessTodayDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
