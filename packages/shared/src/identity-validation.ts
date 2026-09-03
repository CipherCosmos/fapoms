/**
 * Identity-number validation: PAN, Aadhaar (with Verhoeff checksum), IFSC, Indian mobile phones.
 *
 * These rules lived as private regex literals inside the backend's roster importer, so the
 * importer was the ONLY write path that checked anything: `POST /assayers` and `PUT /assayers/:id`
 * accepted any string into panNumber / aadhaarNumber / ifscCode, which is how 1,128 PANs and
 * 578 Aadhaars entered the database unvalidated — including 129 Aadhaar cells that held the word
 * "Inactive". One home for the rules means the importer's report-don't-throw path and the API's
 * refuse-with-a-message path can never disagree about what a valid number looks like.
 */

/**
 * PAN: five letters, four digits, one letter (ABCDE1234F).
 *
 * Case-insensitive on purpose — the roster sheets carry lowercase and mixed-case PANs that are
 * the same number. Callers that STORE a PAN must uppercase it first (the importer does), because
 * an exact-match duplicate scan cannot see that "abcde1234f" and "ABCDE1234F" are one person.
 */
export const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/i;

/**
 * IFSC: four letters (the bank), a zero (reserved by RBI), six alphanumerics (the branch).
 * Case-insensitive for the same reason as PAN; store uppercase.
 */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/i;

/**
 * Aadhaar shape only: exactly twelve digits. This is the historical check and it is NOT enough
 * on its own — it accepted any 12-digit typo. Use `isValidAadhaar`, which adds the Verhoeff
 * checksum every real Aadhaar carries. The bare pattern stays exported for callers that need to
 * tell "wrong shape entirely" apart from "right shape, failed checksum" in their error messages.
 */
export const AADHAAR_PATTERN = /^\d{12}$/;

// ---------------------------------------------------------------------------
// Verhoeff checksum — the algorithm Aadhaar's final digit is computed with.
// ---------------------------------------------------------------------------

/**
 * The three Verhoeff tables, exactly as the algorithm defines them:
 * `D` is the multiplication table of the dihedral group D5, `P` the fixed digit permutation
 * applied by position, `INV` the multiplicative inverses. Unlike a plain mod-10 sum this
 * catches every single-digit typo AND every adjacent transposition — the two mistakes a clerk
 * copying twelve digits off a card actually makes.
 */
const VERHOEFF_D: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const VERHOEFF_INV: ReadonlyArray<number> = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** A string of digits and nothing else. The Verhoeff walk below indexes tables with them. */
function digitsOf(value: string): number[] | null {
  if (!/^\d+$/.test(value)) return null;
  return value.split('').map(Number);
}

/**
 * True when the final digit of `digits` is the correct Verhoeff check digit for the rest.
 * Right-to-left walk, position 0 at the check digit — the standard validation form.
 */
function verhoeffValidates(digits: string): boolean {
  const ds = digitsOf(digits);
  if (!ds) return false;
  let c = 0;
  for (let i = 0; i < ds.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][ds[ds.length - 1 - i]]];
  }
  return c === 0;
}

/**
 * The Verhoeff check digit for a payload of digits (for Aadhaar: the first eleven).
 *
 * Exported so tests and data-seeding code can construct numbers that genuinely validate,
 * instead of hard-coding strings nobody can re-derive. Throws on non-digit input — a payload
 * with a letter in it has no check digit, and returning one would hide the caller's bug.
 */
export function verhoeffCheckDigit(payload: string): number {
  const ds = digitsOf(payload);
  if (!ds) throw new Error(`verhoeffCheckDigit needs digits only, got "${payload}"`);
  let c = 0;
  // Position 1, not 0: the payload's digits sit one place left of where the check digit will go.
  for (let i = 0; i < ds.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][ds[ds.length - 1 - i]]];
  }
  return VERHOEFF_INV[c];
}

// ---------------------------------------------------------------------------
// The validators
// ---------------------------------------------------------------------------

/** Trims and shape-tests a PAN. Accepts either case; does not transform — callers store uppercase. */
export function isValidPan(value: unknown): boolean {
  return typeof value === 'string' && PAN_PATTERN.test(value.trim());
}

/** Trims and shape-tests an IFSC code. Accepts either case; callers store uppercase. */
export function isValidIfsc(value: unknown): boolean {
  return typeof value === 'string' && IFSC_PATTERN.test(value.trim());
}

/**
 * A real Aadhaar number: twelve digits, not a degenerate repeat, Verhoeff checksum intact.
 *
 * Why more than the twelve-digit shape: the length-only check stored any typo and any
 * placeholder. The checksum makes a slip of one digit, or two digits swapped, fail loudly at
 * entry time — when the person who can re-read the card is still looking at it — instead of
 * surfacing years later as a KYC record that matches nobody.
 *
 * Why the all-same-digit refusal on top of the checksum: `999999999999` is a mathematically
 * valid Verhoeff string (it walks the tables back to 0), and 9999-prefixed numbers are also
 * UIDAI's published TEST range — so the classic keyboard-lean placeholder would sail through
 * the checksum and become a stored identity. No genuine Aadhaar is one digit repeated twelve
 * times; refusing them all is safe and catches the placeholders regardless of checksum luck.
 * (`000000000000` happens to fail Verhoeff anyway — its check digit would be 3 — but the rule
 * covers it without relying on that accident.)
 *
 * Deliberately NOT checked: UIDAI reserves first digits 0 and 1, so a stricter validator could
 * refuse those too. This one does not — the cost of wrongly refusing a genuine ID at a KYC desk
 * outweighs catching a placeholder the checksum already has one-in-ten odds against, and the
 * duplicate/integrity scanner reviews stored identities anyway.
 */
export function isValidAadhaar(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!AADHAAR_PATTERN.test(s)) return false;
  if (isPlaceholderAadhaar(s)) return false;
  return verhoeffValidates(s);
}

/**
 * Twelve of the same digit — a placeholder somebody typed to get past a required field.
 *
 * Exported so the two rejection paths (`RosterImportService.readAssayerRow` and the API's
 * `IsAadhaarNumber` rule) can say WHY without each keeping a copy of the regex. Both used to
 * tell the clerk the checksum had failed and to re-read the card, which is wrong for exactly
 * the value they are likeliest to meet: `999999999999` PASSES Verhoeff, so `isValidAadhaar`
 * refuses it here, before the checksum ever runs. Sending someone back to a card to hunt for a
 * mistyped digit in a number that has no mistyped digit costs a real trip to a real cabinet;
 * "this is a placeholder" tells them the field was never filled in and the number must be
 * found, not corrected.
 *
 * Order matters and is asserted by the spec: this must be tested BEFORE the checksum, or the
 * caller reports the failure the number does not have.
 */
export function isPlaceholderAadhaar(value: unknown): boolean {
  return typeof value === 'string' && /^(\d)\1{11}$/.test(value.trim());
}

/**
 * Canonical 10-digit national form of an Indian MOBILE number, or null.
 *
 * Contract:
 *  - Strips the separators people type: spaces, dashes, parentheses, and one leading `+`.
 *  - Accepts the three prefixes in real use — `+91` / bare `91` (only on a 12-digit string,
 *    because a 10-digit number STARTING with 91 is itself a valid mobile, e.g. 9198765432)
 *    and a leading `0` (only on an 11-digit string, the old trunk-dialling habit).
 *  - Valid means the remainder is exactly ten digits starting 6–9 — the mobile numbering
 *    ranges. Returns that ten-digit string, NOT `+91…`; callers that store E.164 (the roster
 *    importer's `readPhoneNumbers` writes `+91XXXXXXXXXX`) prefix it themselves.
 *  - Everything else returns null: landlines, short codes, letters, two numbers in one cell.
 *    Landlines are deliberately not "supported": a field workforce is reached on mobiles, and
 *    no rule is invented for STD-code shapes. Honest limit: a landline written WITH its STD
 *    code (0712-2345678) collapses to ten digits that can begin 6–9, and shape alone cannot
 *    tell that from a mobile — such a value will pass. Shape validation cannot do better.
 */
export function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let s = String(value).trim().replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return /^[6-9]\d{9}$/.test(s) ? s : null;
}
