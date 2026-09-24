import { translatorFor } from './catalogues';
import {
  calendarDaysFrom,
  formatDay,
  formatDayTime,
  formatRupees,
  formatTime,
  groupIndian,
  localDayKey,
  toLocalDate,
} from './format';

describe('formatRupees', () => {
  it('groups the Indian way', () => {
    expect(groupIndian('1')).toBe('1');
    expect(groupIndian('999')).toBe('999');
    expect(groupIndian('1000')).toBe('1,000');
    expect(groupIndian('100000')).toBe('1,00,000');
    expect(groupIndian('12345678')).toBe('1,23,45,678');
    expect(groupIndian('0001000')).toBe('1,000');
  });

  it('shows paise only when there are some, unless asked', () => {
    expect(formatRupees(1200)).toBe('₹1,200');
    expect(formatRupees(1200.5)).toBe('₹1,200.50');
    expect(formatRupees(1200, { paise: 'always' })).toBe('₹1,200.00');
    expect(formatRupees(123456.789)).toBe('₹1,23,456.79');
  });

  it('reads the decimal strings Postgres sends', () => {
    expect(formatRupees('180.00')).toBe('₹180');
    expect(formatRupees('1,00,000')).toBe('₹1,00,000');
  });

  it('rounds to the nearest paisa without float drift', () => {
    expect(formatRupees(0.1 + 0.2, { paise: 'always' })).toBe('₹0.30');
    expect(formatRupees(19.99 * 3, { paise: 'always' })).toBe('₹59.97');
  });

  it('marks a negative amount, but never "-₹0"', () => {
    expect(formatRupees(-500)).toBe('-₹500');
    expect(formatRupees(-0.001)).toBe('₹0');
  });

  it('refuses what is not a number instead of printing ₹NaN', () => {
    expect(formatRupees(null)).toBeNull();
    expect(formatRupees(undefined)).toBeNull();
    expect(formatRupees('')).toBeNull();
    expect(formatRupees('abc')).toBeNull();
    expect(formatRupees(Number.NaN)).toBeNull();
  });
});

describe('dates in words', () => {
  const now = new Date(2026, 8, 24, 10, 0); // 24 September 2026, 10:00 local
  const en = translatorFor('en');
  const hi = translatorFor('hi');

  it('reads a bare calendar date as that local day, not UTC midnight', () => {
    const d = toLocalDate('2026-09-24')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 24]);
    expect(localDayKey('2026-09-24')).toBe('2026-09-24');
    expect(toLocalDate('not a date')).toBeNull();
    expect(toLocalDate(null)).toBeNull();
  });

  it('counts calendar days, ignoring the time of day', () => {
    expect(calendarDaysFrom(new Date(2026, 8, 25, 0, 1), now)).toBe(1);
    expect(calendarDaysFrom(new Date(2026, 8, 23, 23, 59), now)).toBe(-1);
    expect(calendarDaysFrom('2026-09-24', now)).toBe(0);
  });

  it('says Today / Tomorrow / Yesterday', () => {
    expect(formatDay('2026-09-24', now, en)).toBe('Today');
    expect(formatDay('2026-09-25', now, en)).toBe('Tomorrow');
    expect(formatDay('2026-09-23', now, en)).toBe('Yesterday');
    expect(formatDay('2026-09-25', now, hi)).toBe('कल');
  });

  it('names the month, and adds the year only when it is not this year', () => {
    expect(formatDay('2026-10-02', now, en)).toBe('2 October');
    expect(formatDay('2027-01-05', now, en)).toBe('5 January 2027');
    expect(formatDay('2026-10-02', now, hi)).toBe('2 अक्टूबर');
  });

  it('says so when there is no date', () => {
    expect(formatDay(null, now, en)).toBe('Date not known');
  });

  it('tells the time with the part of the day', () => {
    expect(formatTime(new Date(2026, 8, 24, 9, 5), en)).toBe('9:05 am');
    expect(formatTime(new Date(2026, 8, 24, 12, 0), en)).toBe('12:00 pm');
    expect(formatTime(new Date(2026, 8, 24, 0, 30), en)).toBe('12:30 am');
    expect(formatTime(new Date(2026, 8, 24, 18, 45), en)).toBe('6:45 pm');
    expect(formatTime(new Date(2026, 8, 24, 9, 5), hi)).toBe('सुबह 9:05');
    expect(formatTime(new Date(2026, 8, 24, 18, 45), hi)).toBe('शाम 6:45');
    expect(formatTime(new Date(2026, 8, 24, 22, 0), hi)).toBe('रात 10:00');
  });

  it('puts day and time together', () => {
    expect(formatDayTime(new Date(2026, 8, 24, 16, 0), now, en)).toBe('Today, 4:00 pm');
  });
});
