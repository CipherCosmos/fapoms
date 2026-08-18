/**
 * The app's one en-IN date formatter.
 *
 * `fmtDate`/`fmtWhen` (or a `fmtDay`/`fmtWhen` pair naming the same thing) were independently
 * redeclared 15+ times — three verbatim copies inside the HR module alone — each an identical
 * `toLocaleDateString('en-IN', {...})` body. `utils/money.ts` proved the fix works for money;
 * this is the same treatment for dates.
 */

/** en-IN date, em dash for unknown — the app-wide convention for a bare date. */
export const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** en-IN date + time, em dash for unknown — used wherever a "when" is shown. */
export const fmtWhen = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
