import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { identityFormatHint, normaliseIdentityOnBlur, PHONE_FIELD_KEYS } from './identity-fields';

/**
 * Every door onto the roster checks the same identifiers the same way.
 *
 * There are four: the HR desk's wizard, the record's own inline editor, the candidate's
 * self-registration link, and the review drawer. Two of them checked a PAN, an Aadhaar and an IFSC
 * code against the shared rulebook. Two did not — including the candidate-facing one, filled in by
 * the person least equipped to interpret a server error, who found out about a transposed digit
 * after the whole form was done and the card was back in their pocket.
 */

const SRC = join(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [full] : [];
  });

/**
 * A screen that EDITS one of these, found by the thing only an editor has: an `onChange` writing
 * the field. A screen that merely displays a PAN is not a door and is not asked to hint at one.
 */
const EDITORS = walk(join(SRC, 'pages'))
  .map((file) => ({ path: relative(SRC, file), text: readFileSync(file, 'utf8') }))
  .filter(({ text }) => /(panNumber|aadhaarNumber|ifscCode)/.test(text)
    && /onChange=\{[^}]*(updateField|onChange|set)\(/.test(text));

describe('one rulebook for the identifiers', () => {
  it('finds the doors, so this cannot pass by checking nothing', () => {
    expect(EDITORS.length).toBeGreaterThan(2);
  });

  it.each(EDITORS.map((e) => [e.path, e.text]))(
    '%s asks the shared rulebook rather than a regex of its own',
    (path, text) => {
      const source = (text as string)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (!/panNumber|aadhaarNumber|ifscCode/.test(source)) return; // named only in prose
      // Either it hints here, or it delegates to a component that does — both are the rulebook.
      /*
        Only the shared names count. An earlier version of this also accepted the local component
        names those files happen to use (`FieldHint`, `InlineControl`) — which made it pass on a
        file whose hint had been gutted, because the component was still called that. A guard that
        matches a name rather than a call is the failure mode a source-scanning test is most prone
        to, and it was caught by deliberately breaking one of these files to see if this noticed.

        `isValid*` counts: `BillingPanel` checks a client's IFSC with `isValidIfsc` directly, which
        is the same rulebook one layer down.
      */
      const consults = /\bidentityFormatHint\(|\bnormaliseIdentityOnBlur\(|\bisValidPan\(|\bisValidIfsc\(|\bisValidAadhaar\(/
        .test(source);
      expect(consults).toBe(true);
    },
  );

  it('carries no second copy of the shapes', () => {
    // The specific regexes that used to live on individual screens. A screen writing its own is
    // how the Aadhaar check drifted to "twelve digits" and stopped agreeing with the server.
    const offenders = walk(join(SRC, 'pages'))
      .map((file) => ({ path: relative(SRC, file), text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => /\[A-Z\]\{5\}.{0,12}\[0-9\]\{4\}|\[A-Z\]\{4\}0\[A-Z0-9\]\{6\}/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe('identityFormatHint', () => {
  it('stays quiet on a blank box — nobody is told off for not having started', () => {
    expect(identityFormatHint('panNumber', '')).toBeNull();
    expect(identityFormatHint('aadhaarNumber', '   ')).toBeNull();
  });

  it('accepts what the API accepts', () => {
    expect(identityFormatHint('panNumber', 'ABCDE1234F')).toBeNull();
    expect(identityFormatHint('ifscCode', 'HDFC0001234')).toBeNull();
    expect(identityFormatHint('pincode', '411038')).toBeNull();
  });

  it('shows what a PAN and an IFSC code look like, rather than saying "invalid"', () => {
    expect(identityFormatHint('panNumber', 'ABCD1234F')).toContain('ABCDE1234F');
    expect(identityFormatHint('ifscCode', 'HDFC1001234')).toContain('HDFC0001234');
  });

  /**
   * The two Aadhaar failures are different problems and get different sentences. A wrong-length
   * value is a slip the person can see on screen; twelve digits that fail the checksum look
   * perfectly right, and that one has to send them back to the card.
   */
  it('tells a short Aadhaar from one that does not add up', () => {
    expect(identityFormatHint('aadhaarNumber', '1234')).toBe('An Aadhaar number is 12 digits.');
    expect(identityFormatHint('aadhaarNumber', '123456789011')).toContain('check them against the card');
  });

  it('says nothing about a field it has no rule for', () => {
    expect(identityFormatHint('bankName', 'State Bank')).toBeNull();
    expect(identityFormatHint('displayName', '!!!')).toBeNull();
  });
});

describe('normaliseIdentityOnBlur', () => {
  it('returns null when there was nothing to tidy, so no caption is shown', () => {
    expect(normaliseIdentityOnBlur('panNumber', 'ABCDE1234F')).toBeNull();
    expect(normaliseIdentityOnBlur('panNumber', '')).toBeNull();
  });

  it('strips what people paste off a printed card', () => {
    expect(normaliseIdentityOnBlur('panNumber', 'abcde-1234 f')).toBe('ABCDE1234F');
    expect(normaliseIdentityOnBlur('ifscCode', 'hdfc 0001234')).toBe('HDFC0001234');
    expect(normaliseIdentityOnBlur('pincode', '411 038')).toBe('411038');
  });

  /**
   * The gap this closed. `isValidAadhaar` takes twelve digits and nothing else, while the hint
   * strips spaces before asking — so an Aadhaar typed in the card's own four-four-four grouping
   * showed no hint at all and was then refused by the server.
   */
  it('closes the spaced-Aadhaar gap between the hint and the server', () => {
    expect(identityFormatHint('aadhaarNumber', '1234 5678 9010')).toBeNull();
    expect(normaliseIdentityOnBlur('aadhaarNumber', '1234 5678 9010')).toBe('123456789010');
  });

  it('tidies a bank account number the same way', () => {
    expect(normaliseIdentityOnBlur('bankAccountNumber', '1234 5678 9012')).toBe('123456789012');
  });

  it('leaves a value it has no rule for exactly as typed', () => {
    expect(normaliseIdentityOnBlur('bankName', '  State Bank of India ')).toBeNull();
  });

  it('knows which boxes hold a phone number', () => {
    expect([...PHONE_FIELD_KEYS].sort()).toEqual(['alternatePhone', 'emergencyContactPhone', 'phone']);
  });
});

/**
 * Applications now hand staff screens the last four digits of a PAN, Aadhaar or account number.
 * Telling a clerk that "••••234F" does not look like a PAN would be true and useless: the number is
 * on file, and it is not theirs to retype.
 */
describe('a masked identifier on screen', () => {
  it.each(['panNumber', 'aadhaarNumber'])('has nothing to complain about for %s', (key) => {
    expect(identityFormatHint(key, '••••••234F')).toBeNull();
    expect(identityFormatHint(key, '********9012')).toBeNull();
  });

  it('still catches a genuinely malformed number', () => {
    expect(identityFormatHint('panNumber', 'ABCD1234F')).toMatch(/PAN looks like/);
    expect(identityFormatHint('aadhaarNumber', '1234')).toMatch(/12 digits/);
  });
});
