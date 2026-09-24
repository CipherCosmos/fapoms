/**
 * Money, dates and times, written the way people read them.
 *
 * Pure, and deliberately free of `Intl`: Hermes' `Intl` support varies across the Android versions
 * in the field, and a rupee amount is exactly the thing that must never render differently on two
 * phones. Digits are Western Arabic (0-9) in every language — that is what bank papers, SMS and
 * the web desk use — while month names and "Today"/"morning" come from the catalogue.
 */
import { parseCalendarDate, roundMoney } from '@fapoms/shared';
import type { TranslationKey } from './catalogues';
import type { TranslationVars } from './translate';

/** The translator this file needs; `useT()`'s `t` or the background runtime's `t` both fit. */
export type Translator = (key: TranslationKey, vars?: TranslationVars) => string;

/** Group digits the Indian way: 12,34,56,789. */
export function groupIndian(integerDigits: string): string {
  const digits = integerDigits.replace(/^0+(?=\d)/, '');
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * ₹ with Indian grouping. `paise: 'auto'` shows ".50" only when there are paise; `'always'` is for
 * a bill, where "₹1,200.00" reads as exact.
 *
 * Returns null for something that is not a number, so a caller cannot print "₹NaN".
 */
export function formatRupees(
  amount: number | string | null | undefined,
  opts: { paise?: 'auto' | 'always' } = {},
): string | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const value = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  // Rounded to paise by the shared rule first: `Math.round(1.005 * 100)` is 100, not 101.
  const totalPaise = Math.round(roundMoney(Math.abs(value)) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  const showPaise = opts.paise === 'always' || paise !== 0;
  const body = `${groupIndian(String(rupees))}${showPaise ? `.${String(paise).padStart(2, '0')}` : ''}`;
  return `${value < 0 && totalPaise !== 0 ? '-' : ''}₹${body}`;
}

/**
 * A date or timestamp as a local `Date`.
 *
 * A bare `YYYY-MM-DD` is a calendar day, not UTC midnight — `new Date('2026-09-24')` is the
 * previous evening anywhere west of Greenwich — so it goes through the shared calendar parser.
 */
export function toLocalDate(input: Date | string | null | undefined): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (!input) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return parseCalendarDate(input) ?? null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `YYYY-MM-DD` of a date in the phone's own time zone. */
export function localDayKey(input: Date | string | null | undefined): string | null {
  const d = toLocalDate(input);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole calendar days from `now`'s day to `input`'s day (negative = past). */
export function calendarDaysFrom(input: Date | string, now: Date): number | null {
  const d = toLocalDate(input);
  if (!d) return null;
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

const MONTH_KEYS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'] as const;

export function monthName(t: Translator, monthIndex0: number): string {
  return t(`date.months.${MONTH_KEYS[((monthIndex0 % 12) + 12) % 12]}` as TranslationKey);
}

/**
 * A calendar date, always spelled out: "24 September" (with the year only when it is not this
 * year). For sentences that already read "on …", where "on Tomorrow" would not. Never "24/09" —
 * day/month order is exactly what gets misread.
 */
export function formatDate(input: Date | string | null | undefined, now: Date, t: Translator): string {
  const d = toLocalDate(input);
  if (!d) return t('date.unknown');
  const vars = { day: d.getDate(), month: monthName(t, d.getMonth()), year: d.getFullYear() };
  return d.getFullYear() === now.getFullYear() ? t('date.dayMonth', vars) : t('date.dayMonthYear', vars);
}

/** A day in plain words: "Today", "Tomorrow", "Yesterday", else as `formatDate`. */
export function formatDay(input: Date | string | null | undefined, now: Date, t: Translator): string {
  const d = toLocalDate(input);
  if (!d) return t('date.unknown');
  const diff = calendarDaysFrom(d, now) ?? 0;
  if (diff === 0) return t('date.today');
  if (diff === 1) return t('date.tomorrow');
  if (diff === -1) return t('date.yesterday');
  return formatDate(d, now, t);
}

/**
 * A clock time in words: "9:30 am" in English, "सुबह 9:30" in Hindi. The part of day is a
 * catalogue pattern, because languages differ in where it goes and how many parts a day has.
 */
export function formatTime(input: Date | string | null | undefined, t: Translator): string {
  const d = toLocalDate(input);
  if (!d) return t('date.unknown');
  const h = d.getHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const time = `${hour12}:${String(d.getMinutes()).padStart(2, '0')}`;
  const period = h < 5 ? 'lateNight' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 20 ? 'evening' : 'night';
  return t(`time.${period}` as TranslationKey, { time });
}

/** "Today, 9:30 am" / "24 September, 4:00 pm". */
export function formatDayTime(input: Date | string | null | undefined, now: Date, t: Translator): string {
  const d = toLocalDate(input);
  if (!d) return t('date.unknown');
  return t('date.dayAtTime', { day: formatDay(d, now, t), time: formatTime(d, t) });
}
