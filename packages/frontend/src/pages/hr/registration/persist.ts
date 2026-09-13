import { REGISTRATION_RECORD_FIELD_KEYS } from '@fapoms/shared';
import type { FieldDef } from '../AssayerForms';
import { changedFormKeys } from '../assayer-shared';
import { RATE_KEYS } from './steps';

/**
 * Turning the wizard's boxes into requests.
 *
 * Every step writes to the candidate's APPLICATION — the same row they fill in through their own
 * link — rather than to a live roster row, so what this module does is sort the form's keys into
 * the two places an application keeps them and send only what moved. `changedFormKeys` is the
 * record page's own dirty diff, kept because the problem is the same one: two people typing into
 * one person at once.
 *
 * It used to build `POST /assayers` and `PUT /assayers/:id` bodies, which is how a half-finished
 * registration became a half-finished employee.
 */

/**
 * The body of `PATCH /hr/applications/:id`, carrying only what moved.
 *
 * The dirty diff is not an optimisation, and it matters more here than it did against the record.
 * Two people can be typing into one application at once — the desk filling it in while the
 * candidate works through their own link — and the application's `extended_profile` is a single
 * jsonb column written whole. Sending the form back on every step would mean step 5's save
 * rewriting whatever step 3 wrote with the values the wizard opened with, and, worse, dropping a
 * field the candidate had just answered on their phone.
 *
 * ## Two buckets, and the rule that decides
 *
 * An application holds its own columns and one allow-list, so every box goes to exactly one of
 * them: a key on `REGISTRATION_RECORD_FIELD_KEYS` rides under `record` and ends up in
 * `extendedProfile.fields`; everything else is an application column and goes at the top level.
 * The server splits it again through the same two lists, so this is a hint rather than an
 * authority — but sending them apart keeps the request readable and the failure obvious.
 *
 * `phone` is the one worth naming: it is on the record allow-list, so it goes under `record` and
 * NOT into the application's `mobile` column. That column is the number the invite and the
 * verification code are keyed to, and it belongs to the candidate — `verifyOtp` is what writes it,
 * because that is where it is proven. The desk typing a contact number must not quietly replace a
 * number somebody has already confirmed.
 */
export function buildApplicationPatch(
  fields: FieldDef[],
  form: Record<string, string>,
  saved: Record<string, string>,
): { body: Record<string, unknown> | null; changedCount: number } {
  const changed = changedFormKeys(form, saved).filter((k) => !RATE_KEYS.includes(k));
  const known = new Set(fields.map((f) => f.key));

  const columns: Record<string, unknown> = {};
  const record: Record<string, unknown> = {};
  for (const key of changed) {
    if (!known.has(key)) continue;
    const value = form[key] ?? '';
    /*
      `experienceYears` is the one key that is both. It is a column on the application AND on the
      registration allow-list, and the column wins because it is the typed one — the DTO declares
      `@IsInt()`, while `extendedProfile.fields` is jsonb and would take the string `"7"` happily
      and hand it to `AssayerService.update` at promotion. The candidate's own form sends it as a
      column for the same reason; the merged view reads both, so nothing downstream cares which.
    */
    if (key !== 'experienceYears' && (REGISTRATION_RECORD_FIELD_KEYS as readonly string[]).includes(key)) {
      record[key] = value;
      continue;
    }
    // `experienceYears` is the one number among the application's own columns, and its DTO
    // declares `@IsInt()`. An empty box means "not answered", not zero.
    columns[key] = key === 'experienceYears'
      ? (value.trim() === '' ? undefined : Number(value))
      : value;
  }

  const body: Record<string, unknown> = { ...columns };
  if (Object.keys(record).length > 0) body.record = record;
  const changedCount = Object.keys(columns).length + Object.keys(record).length;
  return { body: changedCount > 0 ? body : null, changedCount };
}

export interface RatePayload {
  baseFee: number;
  hourlyRate: number;
  dailyRate: number;
  travelReimbursement: number;
  accommodationAllowance: number;
  mealAllowance: number;
  currency: string;
  effectiveStartDate: string;
}

/**
 * The pay profile, or null when nobody typed a rate.
 *
 * Six `@IsNumber() @IsNotEmpty()` fields, so every one is sent — a blank box means zero, not
 * absent. Returning null for an all-zero card is what stops the flow filing a pay profile of
 * nothing at all against somebody whose rates have not been agreed yet.
 */
export function ratePayload(form: Record<string, string>): RatePayload | null {
  const n = (key: string) => Number(form[key]) || 0;
  const payload: RatePayload = {
    baseFee: n('baseFee'),
    hourlyRate: n('hourlyRate'),
    dailyRate: n('dailyRate'),
    travelReimbursement: n('travelReimbursement'),
    accommodationAllowance: n('accommodationAllowance'),
    mealAllowance: n('mealAllowance'),
    currency: 'INR',
    effectiveStartDate: new Date().toISOString(),
  };
  const anyRate = RATE_KEYS.some((k) => n(k) > 0);
  return anyRate ? payload : null;
}

/** True when a rate box moved since the last save, so an unchanged card is not re-filed. */
export function ratesChanged(form: Record<string, string>, saved: Record<string, string>): boolean {
  return RATE_KEYS.some((k) => (form[k] ?? '') !== (saved[k] ?? ''));
}
