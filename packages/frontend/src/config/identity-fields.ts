import {
  AADHAAR_PATTERN, isValidAadhaar, isValidIfsc, isValidPan, normalisePhone,
} from '@fapoms/shared';

/**
 * What the app says about a PAN, an Aadhaar, an IFSC code or a pincode while it is being typed.
 *
 * There are four doors onto the roster — the HR desk's wizard, the record's own edit forms, the
 * candidate's self-registration link, and the review drawer the desk approves from — and they
 * collect the same identifiers. Two of them checked the shape; two did not. On those two, a
 * transposed Aadhaar digit looked perfectly right until the whole form had been filled and the
 * server refused it on the Verhoeff checksum, which is the worst possible moment: the candidate is
 * no longer holding the card.
 *
 * The rules themselves are `@fapoms/shared/identity-validation` — the same functions
 * `POST/PUT /assayers` runs through `IsPanFormat` / `IsAadhaarNumber` / `IsIfscFormat`. Nothing
 * here restates them, so a hint and a refusal can never disagree about what "looks right" means.
 *
 * Advisory, never a submit blocker. The server is the authority, and a legitimate-but-unusual
 * value must not be made unsaveable by a regex on a screen. (The one identifier that IS blocked at
 * the form is a client's tax id — see `pages/clients/field-hints.ts`, where the API refuses it
 * outright and the form has to say so rather than suggest a second look.)
 */
export function identityFormatHint(key: string, value: string): string | null {
  const v = (value || '').trim();
  if (!v) return null;
  if (key === 'panNumber' && !isValidPan(v)) {
    return 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.';
  }
  if (key === 'ifscCode' && !isValidIfsc(v)) {
    return 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.';
  }
  if (key === 'aadhaarNumber' && !isValidAadhaar(v.replace(/\s/g, ''))) {
    // Two failure modes, two sentences: a wrong-length value is a typing slip the person can see,
    // while twelve digits that fail the checksum look perfectly right on screen — that one has to
    // send them back to the card rather than back to the keyboard.
    return AADHAAR_PATTERN.test(v.replace(/\s/g, ''))
      ? 'These 12 digits do not add up to a real Aadhaar number — check them against the card.'
      : 'An Aadhaar number is 12 digits.';
  }
  if (key === 'pincode' && !/^\d{6}$/.test(v)) return 'A pincode is exactly 6 digits.';
  return null;
}

/** The three boxes that hold a phone number, wherever they appear. */
export const PHONE_FIELD_KEYS = new Set(['phone', 'alternatePhone', 'emergencyContactPhone']);

const stripSeparators = (v: string): string => v.trim().replace(/[\s-]/g, '');

/**
 * What leaving the box should tidy up, and whether that actually changed anything — a caller only
 * shows its "Cleaned up: X → Y" caption when this returns non-null.
 *
 * Deliberately narrow: this fixes the punctuation a person pastes from a printed card or a phone's
 * own contact sheet, never a genuinely wrong value. A PAN that still fails after the spaces and
 * dashes are gone is `identityFormatHint`'s job to flag, not this function's to keep guessing at.
 */
export function normaliseIdentityOnBlur(key: string, raw: string): string | null {
  const v = raw ?? '';
  if (!v.trim()) return null;
  if (key === 'pincode') {
    const clean = stripSeparators(v);
    return clean !== v ? clean : null;
  }
  if (key === 'panNumber' || key === 'ifscCode') {
    const clean = stripSeparators(v).toUpperCase();
    return clean !== v ? clean : null;
  }
  if (key === 'aadhaarNumber' || key === 'bankAccountNumber') {
    /*
      Added when this moved out of `AssayerForms`, because the pair above had a gap between them.
      `isValidAadhaar` takes twelve digits and nothing else — no internal spaces — while the hint
      strips them before asking. So "1234 5678 9012" showed no hint at all and was then refused by
      the server: the form said it was fine and the save said it was not. Tidying it on blur is
      what makes both true at once, and it also keeps the stored value canonical, which the
      duplicate fingerprint depends on (it normalises case and edges, not internal spaces).
    */
    const clean = stripSeparators(v);
    return clean !== v ? clean : null;
  }
  if (PHONE_FIELD_KEYS.has(key)) {
    const clean = normalisePhone(v);
    return clean && clean !== v ? clean : null;
  }
  return null;
}
