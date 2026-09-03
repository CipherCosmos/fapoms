import type { FieldDef } from '../AssayerForms';
import { buildAssayerEditBody, changedFormKeys, type Assayer } from '../assayer-shared';
import { RATE_KEYS } from './steps';

/**
 * Turning the wizard's boxes into requests.
 *
 * Every step of the registration writes to the real record, so all of this is the record page's
 * own machinery — `buildAssayerEditBody` for the shapes each column wants, `changedFormKeys` for
 * the dirty diff that stops one clerk's save overwriting another's. What this module adds is only
 * what a *create* needs that an edit does not, and what the pay rates need.
 */

/** The empty-ish shape a brand-new record starts from, for `buildAssayerEditBody`'s pair rules. */
const NOTHING_ON_FILE: Pick<Assayer, 'workingHours' | 'certifications'> = {
  workingHours: null,
  certifications: null,
};

/**
 * The body of `POST /assayers`.
 *
 * Built from the WHOLE form rather than a diff, because a create has nothing to differ from: the
 * step opens with an employment type and today's date already chosen, and a diff would drop
 * exactly those defaults on the floor.
 *
 * Then every empty value is stripped, which an edit must never do and a create always must. The
 * DTO's rules are one-sided that way: `@IsEmail()` rejects `""`, `@IsNotEmpty()` rejects `""` on
 * the assayer code, and `@IsDateString()` rejects `null` on the joining date — while
 * `buildAssayerEditBody` deliberately emits those empties so that clearing a box on the record
 * page actually clears the column. A new record has nothing to clear, so "absent" is the only
 * meaning an empty box can have here.
 */
export function buildCreateBody(
  fields: FieldDef[],
  form: Record<string, string>,
): Record<string, unknown> {
  const everything: Record<string, string | undefined> = {};
  for (const field of fields) {
    if (form[field.key] !== undefined) everything[field.key] = form[field.key];
  }
  const { body } = buildAssayerEditBody(fields, everything, NOTHING_ON_FILE);
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    stripped[key] = value;
  }
  return stripped;
}

export interface UpdatePlan {
  /** The PUT body, or null when nothing on the record actually changed. */
  body: Record<string, unknown> | null;
  /** Things this form can answer better than the server can — currently only the hours pair. */
  problems: string[];
  /** How many boxes moved, for the "3 changes saved" confirmation. */
  changedCount: number;
}

/**
 * The body of `PUT /assayers/:id`, carrying only what moved.
 *
 * The dirty diff is not an optimisation. Sending the whole form back on every step would mean
 * step 5's save rewriting the address that step 2 wrote and the identity numbers step 3 wrote,
 * with whatever those boxes held when the wizard opened — so two people working on the same
 * person, or one clerk with the record open in a second tab, silently overwrite each other and
 * both saves return 200.
 *
 * Pay rates are dropped here rather than filtered by the caller: they live in the same form state
 * but belong to a different endpoint, and the API runs `forbidNonWhitelisted`, so one leaking into
 * this body would 400 the entire save rather than being ignored.
 */
export function buildUpdatePlan(
  fields: FieldDef[],
  form: Record<string, string>,
  saved: Record<string, string>,
  current: Pick<Assayer, 'workingHours' | 'certifications'>,
): UpdatePlan {
  const changed = changedFormKeys(form, saved).filter((k) => !RATE_KEYS.includes(k));
  if (changed.length === 0) return { body: null, problems: [], changedCount: 0 };

  const touched: Record<string, string | undefined> = {};
  for (const key of changed) touched[key] = form[key];
  const { body, problems } = buildAssayerEditBody(fields, touched, current);
  if (problems.length > 0) return { body: null, problems, changedCount: changed.length };
  return { body, problems: [], changedCount: changed.length };
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
