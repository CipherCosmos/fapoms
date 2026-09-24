import { formatRupees } from '@fapoms/shared';

/**
 * The assayer detail modal's numbers (W4/W5/W7, 2026-09-24).
 *
 * `performance_rating` is nullable — null means UNRATED, and `Number(null).toFixed(1)` printed
 * "0.0", which reads as the worst possible rating for somebody nobody has rated yet. Fees were
 * printed as `₹${n}` / `toLocaleString()` (no grouping rule, "₹undefined" when absent); every other
 * money figure in the app goes through `formatRupees`.
 */
export function ratingLabel(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

export function feeLabel(value: number | string | null | undefined): string {
  return formatRupees(value, { emptyAs: '—' });
}
