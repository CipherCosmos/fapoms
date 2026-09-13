import { formatDateOnly } from '@fapoms/shared';

/**
 * The app's one en-IN date formatter.
 *
 * `fmtDate`/`fmtWhen` (or a `fmtDay`/`fmtWhen` pair naming the same thing) were independently
 * redeclared 15+ times — three verbatim copies inside the HR module alone — each an identical
 * `toLocaleDateString('en-IN', {...})` body. `utils/money.ts` proved the fix works for money;
 * this is the same treatment for dates.
 *
 * `fmtDate` itself delegates to `@fapoms/shared`'s `formatDateOnly`, which mobile already used —
 * this consolidation was one level short: the many call sites in this file's own history all
 * pointed at ONE local formatter, but that formatter was a second, independently-written copy of
 * a shared one, with a real gap `formatDateOnly` already closed — `new Date('2026-08-18')` parses
 * as UTC midnight, which is a day early anywhere west of Greenwich, and `formatDateOnly` treats a
 * bare `YYYY-MM-DD` as local midnight instead. Kept as a wrapper, not a re-export, only to
 * translate `formatDateOnly`'s `''` (unparseable/absent) into this app's own em-dash convention,
 * so none of this file's many callers have to change what an absent date renders as.
 */

/** en-IN date, em dash for unknown — the app-wide convention for a bare date. */
export const fmtDate = (d?: string | null) => formatDateOnly(d) || '—';

/** en-IN date + time, em dash for unknown — used wherever a "when" is shown. */
export const fmtWhen = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
