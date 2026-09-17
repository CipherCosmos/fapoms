import {
  dateOfBirthProblem,
  EMERGENCY_CONTACT_RELATIONS,
  INDIAN_STATES,
  isValidIfsc,
  normalisePhone,
  pincodeFromAddress,
} from '@fapoms/shared';
import { lookupRegistrationIfsc, lookupRegistrationPincode } from '../services/public-registration';

/**
 * Fixed choices for the public candidate registration form.
 *
 * A field gets a dropdown here ONLY when the system already enumerates it:
 * - state → shared `INDIAN_STATES`, the same list the desk wizard offers
 * - emergency relation → shared `EMERGENCY_CONTACT_RELATIONS` plus `Other`,
 *   exactly as the desk wizard does
 * - experience → the backend draft DTO validates `@Min(0) @Max(60)`, so the
 *   list is generated from that range rather than written out by hand
 * - employment category → the shared `EmploymentCategory` enum (cards in the page)
 * - gender → the page's own long-standing four options (the record keeps gender
 *   as free text and the roster never enumerated it, so these are preserved
 *   unchanged rather than reinvented)
 *
 * Everything else stays free text ON PURPOSE, matching the data model:
 * `qualification` is free text because the roster holds 104 distinct values
 * (`assayer.entity.ts`), and `currentEmployer` / `expertise` / `availability`
 * are free-text application columns the desk wizard also types. Forcing those
 * into an invented enum would lose detail ("C.A", "B.A") or corrupt it — and a
 * hardcoded bank list would rot, so the bank name comes only from the IFSC
 * directory lookup, exactly like the desk wizard.
 *
 * Every value stored is a plain string inside the existing draft limits, so the
 * server needs no change and stores these exactly as typed text.
 */

export const STATE_OPTIONS = INDIAN_STATES.map((s) => ({
  value: s.value,
  label: s.label,
}));

export const GENDER_OPTIONS = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
  { value: 'Other', label: 'Other' },
  { value: 'Prefer not to say', label: 'Prefer not to say' },
];

/** Backend `UpdateDraftRequestDto.experienceYears` is `@IsInt() @Min(0) @Max(60)`. */
export const EXPERIENCE_MIN = 0;
export const EXPERIENCE_MAX = 60;

export const EXPERIENCE_OPTIONS = Array.from(
  { length: EXPERIENCE_MAX - EXPERIENCE_MIN + 1 },
  (_, i) => {
    const y = EXPERIENCE_MIN + i;
    return {
      value: String(y),
      label: y === 0 ? 'Fresher — less than 1 year' : `${y} year${y === 1 ? '' : 's'}`,
    };
  },
);

export const RELATION_OPTIONS = [
  ...EMERGENCY_CONTACT_RELATIONS.map((v) => ({ value: v as string, label: v as string })),
  { value: '__other', label: 'Other — type below' },
];

export const OTHER_SENTINEL = '__other';

/** True when the stored string was typed under "Other" rather than picked. */
export function isOtherValue(value: string, options: readonly { value: string }[]): boolean {
  const v = (value ?? '').trim();
  if (!v) return false;
  return !options.some((o) => o.value === v);
}

// ---------------------------------------------------------------------------
// Automations: pincode → state/district/city, IFSC → bank name
// ---------------------------------------------------------------------------
// Both go through the invite-token-gated proxy routes on our own backend
// (`GET /public/registration/:token/lookup/...`), which read the same
// directories the desk uses — the postal directory for pincodes, Razorpay's
// keyless IFSC directory for banks. No third-party URL lives in this client.
// Advisory only: a lookup failure never blocks typing; the server validates.

export interface PincodeLookup {
  state: string;
  district: string;
  city: string;
  /**
   * Which register answered. `directory` is India Post, which is what a pincode *means*; `map` is
   * OpenStreetMap standing in because the directory could not be reached, and it is wrong often
   * enough at state borders (160017 reads as Punjab there, Chandigarh in the directory) that the
   * form asks the candidate to confirm it instead of presenting it as settled.
   */
  source: 'directory' | 'map';
}

export type PincodeAnswer =
  | { status: 'found'; place: PincodeLookup }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/**
 * Carries WHY a pincode did not resolve, so the form can stop telling people their correct digits
 * are wrong. A request that throws is "unavailable" — the same class as the server being unable to
 * reach its own directory.
 */
export async function resolvePincode(token: string, pincode: string): Promise<PincodeAnswer> {
  if (!/^\d{6}$/.test((pincode || '').trim())) return { status: 'not-found' };
  try {
    const found = await lookupRegistrationPincode(token, pincode);
    if (found?.status === 'found' && found.state && found.district) {
      return {
        status: 'found',
        place: {
          state: found.state,
          district: found.district,
          city: found.city ?? found.district,
          // An older backend does not send this. Treating a silent answer as the confirmable kind
          // errs towards asking, which is the safe direction for an address.
          source: found.source === 'directory' ? 'directory' : 'map',
        },
      };
    }
    return { status: found?.status === 'not-found' ? 'not-found' : 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Offline cross-check from the shared postal-circle rule (`shared/pincode.ts`):
 * the first pincode digit fixes the circle, and a selected state outside that
 * circle means one of the two is wrong. Used for the warning only — the live
 * directory above is what fills values in.
 */
export function pincodeStateConflict(pincode: string, state: string): string | null {
  const pin = (pincode || '').trim();
  const st = (state || '').trim();
  if (!/^\d{6}$/.test(pin) || !st) return null;
  const reading = pincodeFromAddress(pin, st);
  return reading.reason;
}

export interface IfscLookup {
  bankName: string;
  branchName: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

export async function resolveIfsc(token: string, code: string): Promise<IfscLookup | null> {
  const v = (code || '').trim().toUpperCase();
  if (!isValidIfsc(v)) return null;
  try {
    const found = await lookupRegistrationIfsc(token, v);
    if (!found?.bankName) return null;
    return found;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lightweight client-side checks (hints, never submit blockers — server owns it)
// ---------------------------------------------------------------------------

/**
 * The shared `normalisePhone` IS the mobile rule (ten digits, 6–9 start, with
 * the +91/0 prefixes real users paste). A hint appears only once a full-length
 * number still fails it — while typing, a neutral helper shows instead, so the
 * field does not scold an unfinished number.
 */
export function mobileHint(value: string): string | null {
  const v = (value || '').trim();
  if (!v) return null;
  if (normalisePhone(v) !== null) return null;
  return v.replace(/\D/g, '').length >= 10
    ? 'That number does not look like a valid 10-digit mobile number.'
    : null;
}

export function mobileHelper(value: string): string {
  return mobileHint(value) ?? 'No +91 needed — just the 10 digits.';
}

/** Canonical ten-digit form of what was typed, or the raw text when unusable. */
export function normaliseMobile(value: string): string {
  return normalisePhone(value) ?? (value || '').trim();
}

/** Same bounds the desk wizard uses for these two date boxes. */
export const DOB_MIN = '1930-01-01';
export function dobMaxToday(): string {
  // Local calendar day, not UTC: `toISOString` is a day behind near midnight IST.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Delegates to the shared rule, so the form refuses exactly what the submit refuses.
 *
 * This used to check only "is it a real date, is it after 1930, is it not in the future" — and
 * said nothing about age. The 18-to-90 rule lived in the nightly roster sweep, so a seventeen-
 * year-old filled the whole form, submitted it, was approved, and turned up days later as a
 * finding in HR's review queue.
 */
export function dobHint(value: string): string | null {
  if (!value) return null;
  return dateOfBirthProblem(value);
}

// ---------------------------------------------------------------------------
// Shapes with no shared validator (shared covers PAN/IFSC/Aadhaar/phone only)
// ---------------------------------------------------------------------------

/** A pincode is exactly 6 digits — the same test the identity hint uses. */
export function isSixDigitPin(value: string): boolean {
  return /^\d{6}$/.test((value || '').trim());
}

/** Bank account numbers are 9–18 digits. */
export function isBankAccountNumber(value: string): boolean {
  return /^\d{9,18}$/.test((value || '').trim());
}

/**
 * Longest value each box may hold, mirroring the enforced limits so an
 * over-long entry is refused HERE with its field named, not at save time with
 * a generic error. Draft DTO (`UpdateDraftRequestDto`): fullName 200, email
 * 255, city/state 100, employer 200, expertise 300, availability 200.
 * Record columns (checked at promotion): bankName 150, qualification 150,
 * emergencyContactName 200, emergencyContactRelation 100.
 */
export const FIELD_LIMITS: Record<string, number> = {
  fullName: 200,
  email: 255,
  city: 100,
  currentEmployer: 200,
  expertise: 300,
  availability: 200,
  bankName: 150,
  qualification: 150,
  emergencyContactName: 200,
  emergencyContactRelation: 100,
};

export function limitHint(key: string, value: string): string | null {
  const max = FIELD_LIMITS[key];
  if (!max || (value ?? '').length <= max) return null;
  return `Keep this under ${max} characters (${(value ?? '').length} now).`;
}
