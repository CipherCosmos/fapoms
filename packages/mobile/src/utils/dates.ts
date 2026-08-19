import { formatDateOnly, parseCalendarDate } from '@fapoms/shared';

export type DayTone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface RelativeDay {
  /** "Today", "Tomorrow", "In 8 days", "3 days overdue", or a formatted date far out. */
  label: string;
  /** Badge tone matching the urgency of the label. */
  tone: DayTone;
  /** Days from today's calendar date (negative = past). */
  diffDays: number;
}

/**
 * Calendar-day difference, ignoring the time-of-day component entirely.
 *
 * `parseCalendarDate`, not `new Date(iso)`: a scheduled date arrives as a bare `YYYY-MM-DD`,
 * which `new Date` reads as UTC midnight — the previous evening anywhere west of Greenwich. It
 * was only right here because IST is ahead of UTC. See the shared helper.
 */
export function calendarDayDiff(iso: string, from: Date = new Date()): number {
  const d = parseCalendarDate(iso) ?? new Date(iso);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * When a stop is, phrased the way a person planning their week thinks about it.
 *
 * The schedule used to show every stop with a bare "18 Aug" — which forces the assayer to do
 * the calendar arithmetic themselves, and hides the one thing that matters most: is anything
 * overdue? Overdue is danger, today is the accent (it is *the* day), tomorrow leans warning
 * ("prepare tonight"), and anything further keeps a calm neutral.
 */
export function relativeDay(iso: string | null | undefined, from: Date = new Date()): RelativeDay {
  if (!iso) return { label: 'Unscheduled', tone: 'neutral', diffDays: 0 };
  const diffDays = calendarDayDiff(iso, from);
  if (diffDays < 0) {
    const n = Math.abs(diffDays);
    return { label: n === 1 ? '1 day overdue' : `${n} days overdue`, tone: 'danger', diffDays };
  }
  if (diffDays === 0) return { label: 'Today', tone: 'accent', diffDays };
  if (diffDays === 1) return { label: 'Tomorrow', tone: 'warning', diffDays };
  if (diffDays <= 13) return { label: `In ${diffDays} days`, tone: 'neutral', diffDays };
  return {
    label: formatDateOnly(iso, { day: 'numeric', month: 'short' }),
    tone: 'neutral',
    diffDays,
  };
}

/** "Today · Mon 18 Aug" style header for a day group on the schedule. */
export function dayGroupHeader(iso: string | null | undefined): string {
  if (!iso) return 'Unscheduled';
  const rel = relativeDay(iso);
  const dateText = formatDateOnly(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  if (rel.diffDays === 0) return `Today · ${dateText}`;
  if (rel.diffDays === 1) return `Tomorrow · ${dateText}`;
  if (rel.diffDays < 0) return `Overdue · ${dateText}`;
  return dateText;
}

/** Stable yyyy-mm-dd key for grouping stops into calendar days. */
export function dayKey(iso: string | null | undefined): string {
  if (!iso) return 'unscheduled';
  const d = parseCalendarDate(iso) ?? new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
