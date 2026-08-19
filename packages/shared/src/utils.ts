import type { RouteSource } from './interfaces';

export const INDIAN_STATES: { value: string; label: string }[] = [
  { value: 'Andhra Pradesh', label: 'Andhra Pradesh' }, { value: 'Arunachal Pradesh', label: 'Arunachal Pradesh' },
  { value: 'Assam', label: 'Assam' }, { value: 'Bihar', label: 'Bihar' },
  { value: 'Chhattisgarh', label: 'Chhattisgarh' }, { value: 'Goa', label: 'Goa' },
  { value: 'Gujarat', label: 'Gujarat' }, { value: 'Haryana', label: 'Haryana' },
  { value: 'Himachal Pradesh', label: 'Himachal Pradesh' }, { value: 'Jharkhand', label: 'Jharkhand' },
  { value: 'Karnataka', label: 'Karnataka' }, { value: 'Kerala', label: 'Kerala' },
  { value: 'Madhya Pradesh', label: 'Madhya Pradesh' }, { value: 'Maharashtra', label: 'Maharashtra' },
  { value: 'Manipur', label: 'Manipur' }, { value: 'Meghalaya', label: 'Meghalaya' },
  { value: 'Mizoram', label: 'Mizoram' }, { value: 'Nagaland', label: 'Nagaland' },
  { value: 'Odisha', label: 'Odisha' }, { value: 'Punjab', label: 'Punjab' },
  { value: 'Rajasthan', label: 'Rajasthan' }, { value: 'Sikkim', label: 'Sikkim' },
  { value: 'Tamil Nadu', label: 'Tamil Nadu' }, { value: 'Telangana', label: 'Telangana' },
  { value: 'Tripura', label: 'Tripura' }, { value: 'Uttar Pradesh', label: 'Uttar Pradesh' },
  { value: 'Uttarakhand', label: 'Uttarakhand' }, { value: 'West Bengal', label: 'West Bengal' },
  { value: 'Andaman and Nicobar Islands', label: 'Andaman and Nicobar Islands' },
  { value: 'Chandigarh', label: 'Chandigarh' }, { value: 'Delhi', label: 'Delhi' },
  { value: 'Jammu and Kashmir', label: 'Jammu and Kashmir' }, { value: 'Ladakh', label: 'Ladakh' },
  { value: 'Lakshadweep', label: 'Lakshadweep' }, { value: 'Puducherry', label: 'Puducherry' },
];

/**
 * Calculates the great-circle distance between two points on the Earth's surface
 * using the Haversine formula.
 *
 * @param lat1 Latitude of point 1 in degrees
 * @param lon1 Longitude of point 1 in degrees
 * @param lat2 Latitude of point 2 in degrees
 * @param lon2 Longitude of point 2 in degrees
 * @returns Distance in kilometers
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Branch and assayer state names come from different sources — client branch
 * lists and internal rosters — and do not agree: a branch is in `MAHARASHTRA`
 * while an assayer living there is recorded under `Maharashtra` or `maharashtra`,
 * and `ANDRAPRADESH` faces `A.P`. Comparing raw values treats these as different
 * states. Canonicalise for comparison; keep the original for display.
 */
const STATE_ALIASES: Record<string, string> = {
  AP: 'ANDHRA PRADESH', 'A P': 'ANDHRA PRADESH', ANDRAPRADESH: 'ANDHRA PRADESH',
  ANDHRAPRADESH: 'ANDHRA PRADESH', 'ANDHRA PRADESH': 'ANDHRA PRADESH',
  TS: 'TELANGANA', TELANGANA: 'TELANGANA',
  TN: 'TAMIL NADU', TAMILNADU: 'TAMIL NADU', 'TAMIL NADU': 'TAMIL NADU',
  KL: 'KERALA', KERALA: 'KERALA',
  KA: 'KARNATAKA', KARNATAKA: 'KARNATAKA',
  MH: 'MAHARASHTRA', MAHARASHTRA: 'MAHARASHTRA',
  OD: 'ODISHA', ORISSA: 'ODISHA', ODISHA: 'ODISHA',
  RJ: 'RAJASTHAN', RAJASTHAN: 'RAJASTHAN',
  UP: 'UTTAR PRADESH', UTTARPRADESH: 'UTTAR PRADESH', 'UTTAR PRADESH': 'UTTAR PRADESH',
  PY: 'PUDUCHERRY', PONDICHERRY: 'PUDUCHERRY', PUDUCHERRY: 'PUDUCHERRY',
  DL: 'DELHI', 'NEW DELHI': 'DELHI', DELHI: 'DELHI',
  GJ: 'GUJARAT', GUJARAT: 'GUJARAT', WB: 'WEST BENGAL', 'WEST BENGAL': 'WEST BENGAL',
};

/** Uppercase, strip punctuation, collapse spaces, then resolve known aliases. */
export function canonicalState(raw: string | null | undefined): string {
  if (!raw) return 'UNKNOWN';
  const k = String(raw).toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
  return STATE_ALIASES[k] ?? STATE_ALIASES[k.replace(/\s/g, '')] ?? k;
}

/**
 * A distance the way a person should read it — never claiming more than its source knows.
 *
 * The routing layer labels every figure `OSRM` (road network) or `ESTIMATE` (great-circle at
 * an assumed speed), and the straight line under-states the road by 11–56 % on real pairs. So
 * a road figure says so, an estimate says so, and a figure with no label at all is treated as
 * an estimate — an older server that never labelled its distances was, in fact, estimating.
 *
 *   formatRouteDistance(212.6, 'OSRM')      → "213 km by road"
 *   formatRouteDistance(164.4, 'ESTIMATE')  → "~164 km (straight line, estimate)"
 *   formatRouteDistance(8.25, 'OSRM')       → "8.3 km by road"
 *   formatRouteDistance(50, null)           → "~50 km (estimate)"
 *   formatRouteDistance(null, 'OSRM')       → "Distance unavailable"   (or `emptyAs`)
 *
 * Under 10 km one decimal is kept — "8.3 km" vs "8 km" matters when the client's independence
 * floor is 10 km; above that whole kilometres are all anyone reads.
 */
export function formatKilometres(distanceKm: number): string {
  const km = Number(distanceKm);
  if (!Number.isFinite(km)) return '';
  return km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('en-IN');
}

export function formatRouteDistance(
  distanceKm: number | string | null | undefined,
  source: RouteSource | null | undefined,
  options: { emptyAs?: string } = {},
): string {
  const { emptyAs = 'Distance unavailable' } = options;
  if (distanceKm === null || distanceKm === undefined || distanceKm === '') return emptyAs;
  const km = Number(distanceKm);
  if (!Number.isFinite(km)) return emptyAs;
  const figure = `${formatKilometres(km)} km`;
  if (source === 'OSRM') return `${figure} by road`;
  if (source === 'ESTIMATE') return `~${figure} (straight line, estimate)`;
  return `~${figure} (estimate)`;
}

/**
 * Travel time, same discipline. Whole minutes under an hour, "2 h 47 min" above; a road figure
 * says "by road", an estimate (or an unlabelled figure) is hedged with "~" and says so.
 *
 *   formatTravelTime(167.3, 'OSRM')     → "2 h 47 min by road"
 *   formatTravelTime(35, 'ESTIMATE')    → "~35 min (estimate)"
 *   formatTravelTime(120, 'OSRM')       → "2 h by road"
 */
export function formatTravelTime(
  minutes: number | string | null | undefined,
  source: RouteSource | null | undefined,
  options: { emptyAs?: string } = {},
): string {
  const { emptyAs = '' } = options;
  if (minutes === null || minutes === undefined || minutes === '') return emptyAs;
  const total = Math.round(Number(minutes));
  if (!Number.isFinite(total) || total < 0) return emptyAs;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const figure = h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
  return source === 'OSRM' ? `${figure} by road` : `~${figure} (estimate)`;
}

/**
 * Rupee amounts, formatted one way everywhere.
 *
 * Six near-identical `money()` helpers had accumulated across the web and mobile apps, and
 * they had already diverged: most passed `maximumFractionDigits: 0`, one rounded first, and
 * one passed neither — so the same payable could render as "₹14,944" on one screen and
 * "₹14,943.6" on another. Currency formatting is a product-wide decision, not a per-file one.
 */
export interface RupeeFormatOptions {
  /** Decimal places. Defaults to 0 — whole rupees, which is what almost every surface wants. */
  decimals?: number;
  /** Rendered instead of a zero when the value is null/undefined, e.g. an em dash. */
  emptyAs?: string;
}

/**
 * Read a rupee amount a human typed. The counterpart to `formatRupees`, and the only thing that
 * should turn an amount field into a number.
 *
 * Returns `null` for anything that is not a positive amount, deliberately — the alternative is
 * the `Number(x) || 0` idiom, which is how a claim for "1,000" came to be filed as ₹0. That path
 * had three separate faults reinforcing each other: the form validated with `parseFloat`, which
 * reads "1,000" as 1 and passes; the submit used `Number`, which reads it as `NaN`; and `|| 0`
 * turned the NaN into a silent zero that the success toast then reported back using the raw
 * text the user typed. The assayer was told "₹1,000 awaiting approval" and had filed nothing.
 *
 * `null` rather than 0 because "they typed something unusable" and "they meant zero" are
 * different answers and the caller has to handle them differently — one is an error to show, the
 * other is a value to store. A type that cannot express the difference is what let this hide.
 *
 * Grouping separators are accepted rather than rejected: this is an Indian product, "1,00,000"
 * is how the amount is written, and some Android keyboards emit a comma on a numeric field
 * whether the form wants one or not.
 */
export function parseRupeeInput(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  // Strip only what is unambiguously decoration: the currency mark, whitespace and the grouping
  // commas. Anything else left over makes it invalid rather than being quietly discarded.
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (cleaned === '') return null;
  // One optional decimal point, digits either side. Rejects "1.2.3", "1e5", "--5" and "12abc",
  // all of which `parseFloat` would happily read a prefix out of.
  if (!/^\d*\.?\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatRupees(
  value: number | string | null | undefined,
  options: RupeeFormatOptions = {},
): string {
  const { decimals = 0, emptyAs } = options;
  if (emptyAs !== undefined && (value === null || value === undefined || value === '')) {
    return emptyAs;
  }
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return emptyAs ?? '₹0';
  return `₹${n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}
