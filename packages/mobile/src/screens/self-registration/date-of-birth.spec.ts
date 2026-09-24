import { dateOfBirthProblem } from '@fapoms/shared';
import { en } from '../../i18n/locales/en';
import {
  MONTH_KEYS, assembleDateOfBirth, birthDayOptions, birthYearOptions, chooseDatePart, dateOfBirthProblemKey,
  daysInMonth, splitDateOfBirth,
} from './date-of-birth';

/**
 * The Day / Month / Year picker. What matters: only a whole, real date ever leaves it (the server
 * reads "1990-04" as 1 April), the lists offer exactly the days a month has, and every verdict of
 * the shared age rule has a translated sentence.
 */

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);

const NOW = new Date(2026, 8, 24);

describe('the date-of-birth lists', () => {
  it('offers years from this year back to 1930, newest first', () => {
    const years = birthYearOptions(NOW);
    expect(years[0]).toBe(2026);
    expect(years[years.length - 1]).toBe(1930);
    expect(years).toHaveLength(2026 - 1930 + 1);
  });

  it('offers only the days the chosen month has', () => {
    expect(birthDayOptions({ day: '', month: '', year: '' })).toHaveLength(31);
    expect(birthDayOptions({ day: '', month: '4', year: '' })).toHaveLength(30);
    expect(birthDayOptions({ day: '', month: '2', year: '' })).toHaveLength(29);
    expect(birthDayOptions({ day: '', month: '2', year: '1990' })).toHaveLength(28);
    expect(birthDayOptions({ day: '', month: '2', year: '2000' })).toHaveLength(29);
    expect(daysInMonth(2, 1900)).toBe(28);
  });

  it('names twelve months, each in the catalogue', () => {
    expect(MONTH_KEYS).toHaveLength(12);
    MONTH_KEYS.forEach((key) => expect(typeof lookup(key)).toBe('string'));
    expect(lookup(MONTH_KEYS[0])).toBe('January');
  });
});

describe('assembling the date', () => {
  it('gives YYYY-MM-DD only when all three are chosen', () => {
    expect(assembleDateOfBirth({ day: '21', month: '4', year: '1990' })).toBe('1990-04-21');
    expect(assembleDateOfBirth({ day: '', month: '4', year: '1990' })).toBeNull();
    expect(assembleDateOfBirth({ day: '21', month: '', year: '1990' })).toBeNull();
    expect(assembleDateOfBirth({ day: '21', month: '4', year: '' })).toBeNull();
  });

  it('refuses a day the month does not have instead of rolling it into the next month', () => {
    expect(assembleDateOfBirth({ day: '29', month: '2', year: '1990' })).toBeNull();
    expect(assembleDateOfBirth({ day: '29', month: '2', year: '1992' })).toBe('1992-02-29');
  });

  it('clears the day when a new month or year does not have it', () => {
    expect(chooseDatePart({ day: '31', month: '1', year: '1990' }, 'month', '4')).toEqual({ day: '', month: '4', year: '1990' });
    expect(chooseDatePart({ day: '29', month: '2', year: '' }, 'year', '1991')).toEqual({ day: '', month: '2', year: '1991' });
    expect(chooseDatePart({ day: '15', month: '1', year: '1990' }, 'month', '2')).toEqual({ day: '15', month: '2', year: '1990' });
  });

  it('reads a saved date, time part and all, back into the lists', () => {
    expect(splitDateOfBirth('1990-04-21T00:00:00.000Z')).toEqual({ day: '21', month: '4', year: '1990' });
    expect(splitDateOfBirth('')).toEqual({ day: '', month: '', year: '' });
    expect(splitDateOfBirth('21-04-1990')).toEqual({ day: '', month: '', year: '' });
  });
});

describe('the age rule, in the reader’s language', () => {
  it('says nothing about a date the shared rule accepts', () => {
    expect(dateOfBirthProblemKey('1990-04-21', NOW)).toBeNull();
    expect(dateOfBirthProblemKey('', NOW)).toBeNull();
  });

  it.each([
    ['2027-01-01', 'selfRegistration.errors.dobFuture'],
    ['2015-01-01', 'selfRegistration.errors.dobTooYoung'],
    ['1931-01-01', 'selfRegistration.errors.dobTooOld'],
    ['not a date', 'selfRegistration.errors.dobUnreadable'],
  ])('%s is refused by the shared rule and said as %s', (value, key) => {
    expect(dateOfBirthProblem(value, NOW)).not.toBeNull();
    const verdict = dateOfBirthProblemKey(value, NOW)!;
    expect(verdict.key).toBe(key);
    expect(typeof lookup(verdict.key)).toBe('string');
  });

  it('carries the age into the sentence', () => {
    expect(dateOfBirthProblemKey('2015-01-01', NOW)).toEqual({
      key: 'selfRegistration.errors.dobTooYoung', vars: { min: 18, count: 11 },
    });
  });
});
