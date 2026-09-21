/**
 * Identity-number validation: PAN, Aadhaar (with Verhoeff checksum), IFSC, GSTIN (with its own
 * mod-36 checksum), Indian mobile phones.
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
 * GSTIN shape only: two digits (the GST state code), the ten-character PAN of the registrant,
 * one digit or letter (the entity number for that PAN — 1-9 then A-Z once a PAN has ten-plus
 * registrations), a literal `Z` (the position GSTN's spec reserves for future use; every GSTIN
 * issued so far carries `Z` there), and one alphanumeric checksum character. Case-insensitive
 * for the same reason as PAN — a client's GSTIN often arrives copied off an invoice or a
 * lowercase form field; store uppercase.
 *
 * This is the historical check and, like `AADHAAR_PATTERN`, it is NOT enough on its own — shape
 * alone accepts any fabricated 15-character string. Use `isValidGstin`, which adds the mod-36
 * checksum every real GSTIN carries. The bare pattern stays exported for callers that need to
 * tell "wrong shape entirely" apart from "right shape, failed checksum" in their error messages.
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;

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
// GSTIN checksum — ISO 7064 MOD 37-36, restricted to the 36 characters (digits then A-Z) a
// GSTIN is actually drawn from. The full scheme reserves a 37th symbol ('*') for a check
// character that would otherwise collide with a payload character; a GSTIN never produces one
// in practice; see `gstinCheckDigit`'s throw for what happens if it somehow did.
// ---------------------------------------------------------------------------

/** Digits then A-Z — index doubles as each character's value in the mod-36 walk below. */
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The mod-36 checksum character for the first fourteen characters of a GSTIN.
 *
 * Right-to-left, Luhn-style: starting from the rightmost payload character, each character's
 * alphabet position is doubled on odd steps and left alone on even ones (factor 2, 1, 2, 1…),
 * and a value that overflows the 0-35 range is folded back into it by adding its base-36
 * "digits" — `Math.floor(doubled / 36) + (doubled % 36)` — which is what a doubled value needs
 * instead of decimal Luhn's "sum the two digits". The checksum character is whichever alphabet
 * position brings that running sum to a multiple of 36.
 *
 * Exported so tests can build a GSTIN that genuinely checksums, instead of hard-coding a string
 * nobody can re-derive — same reasoning as `verhoeffCheckDigit` above. Throws on a character
 * outside the GSTIN alphabet, the same contract `verhoeffCheckDigit` uses for non-digits.
 */
export function gstinCheckDigit(payload: string): string {
  const chars = payload.toUpperCase().split('');
  let factor = 2;
  let sum = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const codePoint = GSTIN_ALPHABET.indexOf(chars[i]);
    if (codePoint === -1) {
      throw new Error(`gstinCheckDigit needs GSTIN alphabet characters (0-9, A-Z) only, got "${payload}"`);
    }
    const doubled = factor * codePoint;
    sum += Math.floor(doubled / 36) + (doubled % 36);
    factor = factor === 2 ? 1 : 2;
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
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
 * A real GSTIN: fifteen characters, the state/PAN/entity/reserved-digit shape `GSTIN_PATTERN`
 * checks, and the mod-36 checksum intact.
 *
 * Why more than the shape: a shape-only check stores any fifteen-character string a clerk
 * assembles to fill a required field, the same failure mode `isValidAadhaar` was written to
 * close for Aadhaar. The checksum makes a mistyped or transposed character fail at entry, while
 * the invoice or certificate it was copied from is still on the desk to re-check.
 *
 * Accepts either case; does not transform — callers store uppercase, same contract as PAN/IFSC.
 *
 * Deliberately NOT checked: whether the first two digits are a GST state code actually in use.
 * That list changes when a new union territory is carved out or a code is reassigned, and
 * keeping it in step is a maintenance burden the checksum does not need help from — a wrong
 * state code with a right checksum is still a fabricated GSTIN, but catching it needs the same
 * "is this a real state" table `regions.ts` already owns, not a second copy of it here.
 */
export function isValidGstin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!GSTIN_PATTERN.test(s)) return false;
  return gstinCheckDigit(s.slice(0, 14)) === s[14].toUpperCase();
}

/**
 * Does this value pass the rule the API enforces on a client's `taxId`?
 *
 * The column has always held either shape — a GSTIN for a GST-registered entity, a bare PAN for
 * an individual or a client not yet registered — and an empty string passes, so clearing the
 * field is never blocked by the rule meant to keep junk out of it.
 */
export function isGstinOrPan(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.trim() === '' || isValidGstin(value) || isValidPan(value);
}

/**
 * What the API says when it refuses one — and what the form should say BEFORE it is sent.
 *
 * It lives here because it was written twice, in the two places that have to agree: the server's
 * `IsGstinOrPanFormat` decorator refused the save with this sentence, while the edit form showed
 * a grey "double-check before saving" that read as advice. It was not advice. The operator typed
 * something, was told to check it, saved anyway because nothing said they could not, and got the
 * refusal from the server on a screen that had implied the opposite. The identical grey note on
 * the BILLING tax identifier is genuinely advisory — that column has no such rule — so the two
 * looked the same and behaved differently, which is the worst of both.
 */
export const GSTIN_OR_PAN_REFUSAL =
  "This doesn't look like a GSTIN or a PAN — enter one of the two, e.g. 27AAPFU0939F1ZV or ABCDE1234F.";

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

/**
 * An Indian mobile number in E.164 (`+91XXXXXXXXXX`), or null — the shape an SMS gateway is
 * handed.
 *
 * Deliberately `normalisePhone` plus a prefix, not a second reading of phone numbers: the SMS
 * provider used to carry its own normaliser, which passed ANY run of digits through (a landline, a
 * two-numbers-in-one-cell string glued together) and let the gateway bill for refusing it. What
 * counts as a mobile is decided once, above.
 */
export function toE164IndianMobile(value: unknown): string | null {
  const national = normalisePhone(value);
  return national ? `+91${national}` : null;
}

// ── SMS wording under DLT ────────────────────────────────────────────────────────────────────
//
// Held here, beside the phone rule, because the server (which sends and saves templates) and the
// settings screen (which previews and counts while an administrator types) must agree to the
// character: a counter that disagrees with the gateway's bill, or a DLT form that differs by one
// space from what the server sends, is a text the operators block.

/** The `{{token}}` placeholder syntax every SMS template uses. */
const SMS_TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The distinct `{{token}}` names in a text, in order of first appearance. */
export function smsTemplateTokens(text: string): string[] {
  const seen: string[] = [];
  for (const m of String(text ?? '').matchAll(SMS_TOKEN)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** The text as it must be registered on the DLT portal: every `{{token}}` becomes `{#var#}`. */
export function toDltForm(text: string): string {
  return String(text ?? '').replace(SMS_TOKEN, '{#var#}');
}

/** Fills `{{token}}` placeholders from `data`; an absent value becomes empty. */
/**
 * The most characters one DLT variable (`{#var#}`) may carry. TRAI's DLT rule; an operator blocks a
 * text whose filled-in variable is longer, so every value is fitted to it here — once, for every
 * text — rather than each sender guessing its own limit.
 */
export const DLT_VARIABLE_MAX_LENGTH = 30;

/** A value as one variable of a text: whitespace collapsed, and cut to fit with the cut marked. */
export function fitSmsVariable(value: unknown, max = DLT_VARIABLE_MAX_LENGTH): string {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function fillSmsTemplate(text: string, data: Record<string, unknown>): string {
  return String(text ?? '').replace(SMS_TOKEN, (_m, token: string) => {
    const value = data?.[token];
    return value === undefined || value === null ? '' : fitSmsVariable(value);
  });
}

/**
 * The values every message carries, under the same names in every email and every text.
 *
 * Each template used to name its own: the person was `fullName` in one email, `candidateName` in the
 * next, and a text had no way to name the number it was going to. The platform fills these for every
 * message, so an administrator can use the same placeholders in any wording. Anything a sender passes
 * of its own — a code, a temporary password — wins over them.
 */
export const COMMON_MESSAGE_TOKENS = ['name', 'phone', 'email', 'companyName', 'portalUrl', 'time', 'date'] as const;

export type CommonMessageToken = (typeof COMMON_MESSAGE_TOKENS)[number];

/**
 * What each one means, in the words the editing screens show.
 *
 * Here rather than in either screen: the email screen and the SMS screen both list these, and a list
 * written twice is a list that disagrees with itself within a release.
 */
export const COMMON_MESSAGE_TOKEN_HELP: Record<CommonMessageToken, string> = {
  name: 'Who the message is for — blank when the sender does not know a name',
  phone: 'The mobile number it is going to (texts)',
  email: 'The address it is going to (emails)',
  companyName: 'Your firm\'s name, from Platform Settings → Company',
  portalUrl: 'Where to open FAPOMS',
  time: 'The time it was sent, e.g. 6:42 pm',
  date: 'The date it was sent, e.g. 19 Sept 2026',
};

/**
 * What each template's OWN placeholders mean — the other thirty.
 *
 * `COMMON_MESSAGE_TOKEN_HELP` above covers the seven every message carries. Each email template
 * also declares its own (`email-template-registry.ts`: `requiredTokens` / `optionalTokens` /
 * `rawTokens`), and those reached the editing screen as bare `{{otpCode}}` chips whose entire
 * hover text was "Required token {{otpCode}} is present" — the name, restated. Somebody editing
 * the wording of an email could see WHICH placeholders were expected and not what a single one
 * of them would be replaced with.
 *
 * Written here, with the common seven, for the same reason they are: two screens list these, and
 * a list written twice disagrees with itself within a release.
 *
 * Kept as a plain `Record<string, string>` rather than a total map over a union: the registry is
 * the source of truth for WHICH tokens exist, it lives in the backend, and a template added
 * there must not fail to compile the shared package. `emailTokenHelp()` below degrades to a
 * useful sentence for anything not yet described.
 */
export const EMAIL_TEMPLATE_TOKEN_HELP: Record<string, string> = {
  assayerCode: 'The appraiser code issued on approval, e.g. ASY-2026-0842',
  branchName: 'The bank branch the paperwork is for, e.g. HDFC Bank — Fort Branch, Mumbai',
  briefDate: 'The day the digest covers, written out, e.g. Wednesday, September 16, 2026',
  candidateName: 'The candidate\'s name as they gave it on their application',
  digestSectionsHtml: 'The whole body of the morning digest, already laid out. Place it once; do not try to style inside it',
  digestSectionsText: 'The same digest body as plain text, for readers whose email shows no formatting',
  displayName: 'The person\'s name as their record shows it',
  documentType: 'What the attached paperwork is, e.g. Bullion Audit Schedule',
  expiryHours: 'How many hours the link in this email keeps working, e.g. 72',
  fileName: 'The name of the attached file, e.g. Audit_Packet_HDFC_Fort_2026-09-16.pdf',
  fullName: 'The person\'s full name',
  greeting: 'The opening line, e.g. "Hello Rajesh Kumar," — leave it out and write your own instead',
  intro: 'The standard opening paragraph for this email — leave it out and write your own instead',
  inviteUrl: 'The personal registration link. Every candidate gets a different one',
  loginUrl: 'Where to sign in to FAPOMS',
  logoUrl: 'Your company logo. Use it as an image source, not as text',
  otpCode: 'The verification code the person has to type, e.g. 849201',
  purpose: 'What the code is for, e.g. "sign in" — it reads inside a sentence',
  remarks: 'Any note the desk added for this person',
  reviewNotes: 'Why the application was not accepted, in the reviewer\'s own words',
  roleName: 'The role the candidate is being invited for, e.g. Gold & Bullion Appraiser',
  securityNotice: 'The standard caution for this email — keep it unless you have a reason not to',
  setupUrl: 'The personal link for setting a password. Every person gets a different one',
  status: 'Where the person now stands, e.g. Active Roster Ready',
  subjectCounts: 'The headline counts for the subject line, e.g. 3 Overdue · 1 Approval',
  supportEmail: 'The address a reader should write to for help',
  temporaryPassword: 'The one-time password issued with app access. It is shown once and never again',
  username: 'The sign-in name issued to this person, e.g. RAJESH.KUMAR',
  validDays: 'How many days the temporary password works for, e.g. 7',
  validMinutes: 'How many minutes the code works for, e.g. 5',
};

/**
 * What a placeholder means, wherever it came from.
 *
 * Checks this template's own list, then the seven every message carries. An undescribed token
 * still gets a true sentence rather than nothing — the screen has to say something, and "we fill
 * this in when the email is sent" is both honest and the thing the reader needs to know.
 */
export function emailTokenHelp(token: string): string {
  return EMAIL_TEMPLATE_TOKEN_HELP[token]
    ?? COMMON_MESSAGE_TOKEN_HELP[token as CommonMessageToken]
    ?? 'Filled in by the system when this email is sent';
}

/**
 * What is wrong with edited SMS wording, as sentences — empty when it may be saved.
 *
 * Every required value must still be there (a code message without `{{code}}` delivers no code), and
 * nothing else may be (a placeholder nobody fills in arrives as a blank the DLT template never had).
 * The server refuses the save on these; the settings screen shows them while the administrator types.
 */
export function smsWordingProblems(
  text: string,
  requiredTokens: readonly string[],
  /** Allowed on top of the common ones every message carries — this text's own optional values. */
  optionalTokens: readonly string[] = [],
): string[] {
  const allowed = [...requiredTokens, ...optionalTokens, ...COMMON_MESSAGE_TOKENS];
  const present = smsTemplateTokens(text);
  const missing = requiredTokens.filter((t) => !present.includes(t));
  const unknown = present.filter((t) => !allowed.includes(t as CommonMessageToken));
  const list = (tokens: readonly string[]) => tokens.map((t) => `{{${t}}}`).join(', ');
  const problems: string[] = [];
  if (missing.length) {
    problems.push(`The wording must still contain ${list(missing)} — the real value is filled in there when the text is sent.`);
  }
  if (unknown.length) {
    problems.push(`${list(unknown)} cannot be filled in for this text. Use only ${list(allowed)}.`);
  }
  return problems;
}

/** A DLT template or entity id as the portal issues it: digits only (19 of them, in practice). */
export const DLT_ID_PATTERN = /^\d{1,30}$/;

/** A DLT sender header for transactional and service texts: exactly six letters. */
export const DLT_SENDER_ID_PATTERN = /^[A-Za-z]{6}$/;

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsSegmentCount {
  encoding: SmsEncoding;
  /** What the gateway counts: GSM-7 septets (an extension character is two), or UTF-16 units. */
  length: number;
  /** How many SMS parts it goes out as — and is billed as. Zero for an empty text. */
  segments: number;
  /** How much fits in one part at this length: 160/153 for GSM-7, 70/67 for UCS-2. */
  perSegment: number;
}

/** GSM 03.38 default alphabet (the escape character itself excluded). */
const GSM7_BASIC = new Set(Array.from(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
));
/** GSM 03.38 extension table: each costs an escape plus itself, two septets. */
const GSM7_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

/**
 * How a text is encoded and how many SMS parts it takes.
 *
 * One character outside the GSM-7 alphabet — a rupee sign, a curly quote pasted from a document,
 * any Indian script — switches the WHOLE text to UCS-2, where a part holds 70 instead of 160, so
 * the same sentence can cost three texts instead of one. A long text is split into parts that each
 * lose room to the joining header: 153 (GSM-7) or 67 (UCS-2) per part once there is more than one.
 */
export function countSmsSegments(text: string): SmsSegmentCount {
  const s = String(text ?? '');
  let septets = 0;
  let gsm = true;
  for (const ch of s) {
    if (GSM7_BASIC.has(ch)) septets += 1;
    else if (GSM7_EXTENSION.has(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', length: septets, segments, perSegment: segments > 1 ? 153 : 160 };
  }
  const units = s.length;
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', length: units, segments, perSegment: segments > 1 ? 67 : 70 };
}
