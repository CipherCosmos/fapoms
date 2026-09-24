import {
  APPRAISER_MIN_AGE, EARLIEST_BIRTH_YEAR, ageInYears, dateOfBirthProblem,
} from '@fapoms/shared';
import type { TranslationKey, TranslationVars } from '../../i18n/i18n';

/**
 * THE DATE-OF-BIRTH PICKER'S RULES — Day, Month and Year as three lists instead of a
 * "YYYY-MM-DD" box.
 *
 * A candidate typing a date into a box wrote it the way Indian forms print it (21-04-1990), which
 * the box read as the year 21. Three lists cannot be misread. Only a WHOLE date ever leaves this
 * file: the server reads "1990-04" as 1 April 1990, so a half-chosen date stays on the screen and
 * is never saved.
 *
 * Whether a date is ALLOWED is not decided here — that is `dateOfBirthProblem` in the shared
 * package, the one rule the web form and the server use. This file only turns its verdict into a
 * catalogue key, so the phone can say it in Hindi as well as English.
 *
 * Pure, so it can be tested in node without React Native (`date-of-birth.spec.ts`).
 */

export interface DateOfBirthParts {
  /** '' until chosen; otherwise 1–31 as a string, no padding. */
  day: string;
  /** '' until chosen; otherwise 1–12 as a string, no padding. */
  month: string;
  /** '' until chosen; otherwise four digits. */
  year: string;
}

export const EMPTY_DATE_OF_BIRTH: DateOfBirthParts = { day: '', month: '', year: '' };

/** The catalogue keys for January…December, in order. */
export const MONTH_KEYS: readonly TranslationKey[] = [
  'selfRegistration.months.jan', 'selfRegistration.months.feb', 'selfRegistration.months.mar',
  'selfRegistration.months.apr', 'selfRegistration.months.may', 'selfRegistration.months.jun',
  'selfRegistration.months.jul', 'selfRegistration.months.aug', 'selfRegistration.months.sep',
  'selfRegistration.months.oct', 'selfRegistration.months.nov', 'selfRegistration.months.dec',
];

/** Days in a month; February of an unchosen year is allowed its 29th. */
export function daysInMonth(month: number, year?: number | null): number {
  if (!month || month < 1 || month > 12) return 31;
  if (month === 2) {
    if (!year) return 29;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Years to choose from, newest first: this year down to the earliest the shared rule accepts. */
export function birthYearOptions(now: Date = new Date()): number[] {
  const years: number[] = [];
  for (let y = now.getFullYear(); y >= EARLIEST_BIRTH_YEAR; y--) years.push(y);
  return years;
}

/** Days to choose from for what is chosen so far — 28, 29, 30 or 31 of them. */
export function birthDayOptions(parts: DateOfBirthParts): number[] {
  const count = daysInMonth(Number(parts.month) || 0, Number(parts.year) || null);
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** A saved date (ISO, possibly with a time part) split into the three lists. */
export function splitDateOfBirth(value: string | null | undefined): DateOfBirthParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((value ?? '').trim());
  if (!match) return { ...EMPTY_DATE_OF_BIRTH };
  return { year: match[1], month: String(Number(match[2])), day: String(Number(match[3])) };
}

/**
 * Applies one choice. A day the new month (or year) does not have is cleared rather than silently
 * moved — 31 April is not "about 1 May", and the person should see the day is still to choose.
 */
export function chooseDatePart(parts: DateOfBirthParts, part: keyof DateOfBirthParts, value: string): DateOfBirthParts {
  const next = { ...parts, [part]: value };
  if (next.day && Number(next.day) > daysInMonth(Number(next.month) || 0, Number(next.year) || null)) {
    next.day = '';
  }
  return next;
}

/** `YYYY-MM-DD` once all three are chosen and form a real day; null otherwise. */
export function assembleDateOfBirth(parts: DateOfBirthParts): string | null {
  const day = Number(parts.day);
  const month = Number(parts.month);
  const year = Number(parts.year);
  if (!day || !month || !year || !/^\d{4}$/.test(parts.year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return null;
  return `${parts.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The shared rule's verdict as a catalogue key, or null when the date is fine.
 *
 * `dateOfBirthProblem` answers in English sentences; the reason is worked out again here only to
 * pick the right translated one, and only once the shared rule has said there IS a problem — so
 * this can never allow or refuse a date the web form would not.
 */
export function dateOfBirthProblemKey(
  value: string | null | undefined,
  now: Date = new Date(),
): { key: TranslationKey; vars?: TranslationVars } | null {
  if (!value || !dateOfBirthProblem(value, now)) return null;
  const parts = splitDateOfBirth(value);
  const iso = assembleDateOfBirth(parts);
  if (!iso) return { key: 'selfRegistration.errors.dobUnreadable' };
  const [y, m, d] = iso.split('-').map(Number);
  const dob = new Date(y, m - 1, d);
  if (dob.getTime() > now.getTime()) return { key: 'selfRegistration.errors.dobFuture' };
  if (y < EARLIEST_BIRTH_YEAR) return { key: 'selfRegistration.errors.dobTooEarly', vars: { value: EARLIEST_BIRTH_YEAR } };
  const age = ageInYears(iso, now) ?? 0;
  if (age < APPRAISER_MIN_AGE) return { key: 'selfRegistration.errors.dobTooYoung', vars: { min: APPRAISER_MIN_AGE, count: age } };
  return { key: 'selfRegistration.errors.dobTooOld', vars: { count: age } };
}
