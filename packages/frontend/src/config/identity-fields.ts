import { BANK_ACCOUNT_NUMBER_RULE,
  identifierFormatIssue, normaliseIdentifierOnBlur, PHONE_FIELD_KEYS as SHARED_PHONE_FIELD_KEYS,
  type IdentifierFormatIssue,
} from '@fapoms/shared';

/**
 * What the app says about a PAN, an Aadhaar, an IFSC code or a pincode while it is being typed.
 *
 * There are four doors onto the roster — the HR desk's wizard, the record's own edit forms, the
 * candidate's self-registration link, and the review drawer the desk approves from — plus the phone
 * app's registration, and they collect the same identifiers. Two of them once checked the shape
 * and two did not, so a transposed Aadhaar digit looked right until the server refused it on the
 * Verhoeff checksum, after the candidate had put the card away.
 *
 * WHICH check failed is decided once, in `@fapoms/shared/identifier-entry`, on the same validators
 * `POST/PUT /assayers` runs. This file only words it, so a hint and a refusal cannot disagree.
 *
 * Advisory, never a submit blocker. The server is the authority, and a legitimate-but-unusual
 * value must not be made unsaveable by a regex on a screen. (The one identifier that IS blocked at
 * the form is a client's tax id — see `pages/clients/field-hints.ts`, where the API refuses it
 * outright and the form has to say so rather than suggest a second look.)
 */
const FORMAT_HINTS: Record<IdentifierFormatIssue, string> = {
  pan: 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.',
  ifsc: 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.',
  aadhaarChecksum: 'These 12 digits do not add up to a real Aadhaar number — check them against the card.',
  aadhaarLength: 'An Aadhaar number is 12 digits.',
  pincode: 'A pincode is exactly 6 digits.',
  bankAccount: BANK_ACCOUNT_NUMBER_RULE,
};

export function identityFormatHint(key: string, value: string): string | null {
  const issue = identifierFormatIssue(key, value);
  return issue ? FORMAT_HINTS[issue] : null;
}

/** The three boxes that hold a phone number, wherever they appear. */
export const PHONE_FIELD_KEYS = SHARED_PHONE_FIELD_KEYS;

/**
 * What leaving the box should tidy up, and whether that actually changed anything — a caller only
 * shows its "Cleaned up: X → Y" caption when this returns non-null.
 */
export const normaliseIdentityOnBlur = normaliseIdentifierOnBlur;
