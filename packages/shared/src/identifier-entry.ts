import { AADHAAR_PATTERN, isBankAccountNumber, isValidAadhaar, isValidIfsc, isValidPan, normalisePhone } from './identity-validation';
import { looksMasked } from './assayer-qualification';

/**
 * What a form should say about a PAN, Aadhaar, IFSC, pincode or phone number while it is typed.
 *
 * Every surface that collects these — the desk wizard, the record's edit forms, the candidate's web
 * link and the phone app — used to phrase its own checks, and they disagreed: one flagged a
 * transposed Aadhaar digit at the box, another only at the server's checksum, after the candidate
 * had put the card away. The rules are the validators above; this says which one failed, and each
 * surface words it (the web in English, the phone through its translations).
 *
 * Advisory. The server is the authority, and a legitimate-but-unusual value must stay saveable.
 */
export type IdentifierFormatIssue = 'pan' | 'ifsc' | 'aadhaarLength' | 'aadhaarChecksum' | 'pincode' | 'bankAccount';

export function identifierFormatIssue(key: string, value: string): IdentifierFormatIssue | null {
  const v = (value || '').trim();
  if (!v) return null;
  // A masked value ("••••234F") is a number on file, not a malformed one.
  if (looksMasked(v)) return null;
  if (key === 'panNumber' && !isValidPan(v)) return 'pan';
  if (key === 'ifscCode' && !isValidIfsc(v)) return 'ifsc';
  if (key === 'aadhaarNumber') {
    const digits = v.replace(/\s/g, '');
    // Twelve digits failing the checksum look right on screen, so that one sends them back to the card.
    if (!isValidAadhaar(digits)) return AADHAAR_PATTERN.test(digits) ? 'aadhaarChecksum' : 'aadhaarLength';
  }
  if (key === 'pincode' && !/^\d{6}$/.test(v)) return 'pincode';
  if (key === 'bankAccountNumber' && !isBankAccountNumber(v)) return 'bankAccount';
  return null;
}

/** The boxes that hold a phone number, wherever they appear. */
export const PHONE_FIELD_KEYS: ReadonlySet<string> = new Set(['phone', 'alternatePhone', 'emergencyContactPhone']);

const stripSeparators = (v: string): string => v.trim().replace(/[\s-]/g, '');

/**
 * The tidy-up leaving a box should do, or null when nothing changed.
 *
 * Only the punctuation people paste from a printed card or a contact sheet — never a guess at a
 * wrong value. Aadhaar and account numbers lose internal spaces because `isValidAadhaar` takes
 * twelve bare digits: "1234 5678 9012" otherwise showed no hint and was then refused on save.
 */
export function normaliseIdentifierOnBlur(key: string, raw: string): string | null {
  const v = raw ?? '';
  if (!v.trim()) return null;
  if (key === 'pincode' || key === 'aadhaarNumber' || key === 'bankAccountNumber') {
    const clean = stripSeparators(v);
    return clean !== v ? clean : null;
  }
  if (key === 'panNumber' || key === 'ifscCode') {
    const clean = stripSeparators(v).toUpperCase();
    return clean !== v ? clean : null;
  }
  if (PHONE_FIELD_KEYS.has(key)) {
    const clean = normalisePhone(v);
    return clean && clean !== v ? clean : null;
  }
  return null;
}

/**
 * True once a full-length number still fails the mobile rule.
 *
 * Silent while fewer than ten digits are typed, so an unfinished number is not scolded.
 */
export function mobileNumberLooksWrong(value: string): boolean {
  const v = (value || '').trim();
  if (!v || normalisePhone(v) !== null) return false;
  return v.replace(/\D/g, '').length >= 10;
}
