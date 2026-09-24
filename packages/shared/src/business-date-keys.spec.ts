import { weekdayOfDateKey, businessNoonOf, businessDateKey, addDaysToDateKey } from './index';

/**
 * F20 (2026-09-25): planning's date walks are done on IST calendar keys — stepped with
 * `addDaysToDateKey`, weekday-read with `weekdayOfDateKey`, and handed to date checks as
 * `businessNoonOf(key)` — so no server-local clock can move a day.
 */
describe('calendar keys for planning', () => {
  it('reads the weekday of the key itself', () => {
    expect(weekdayOfDateKey('2026-10-04')).toBe(0); // Sunday
    expect(weekdayOfDateKey('2026-10-03')).toBe(6); // Saturday
    expect(weekdayOfDateKey('not a date')).toBeNaN();
  });

  it('noon IST of a key reads back as that key in IST and in UTC', () => {
    const d = businessNoonOf('2026-10-05');
    expect(businessDateKey(d)).toBe('2026-10-05');
    expect(d.toISOString().slice(0, 10)).toBe('2026-10-05');
  });

  it('steps across a month end on the key', () => {
    expect(addDaysToDateKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(weekdayOfDateKey(addDaysToDateKey('2026-10-03', 1))).toBe(0);
  });
});
