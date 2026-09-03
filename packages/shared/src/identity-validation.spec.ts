import {
  PAN_PATTERN, IFSC_PATTERN, AADHAAR_PATTERN,
  isValidPan, isValidIfsc, isValidAadhaar, isPlaceholderAadhaar, normalisePhone, verhoeffCheckDigit,
} from './identity-validation';

/**
 * Identity validation, held still.
 *
 * Every block below is a value the live database actually holds (or a typo one keystroke away
 * from one): the import of 2026-08 stored 129 cells containing the word "Inactive" as Aadhaar
 * numbers, and `POST /assayers` accepted anything at all into panNumber/aadhaarNumber/ifscCode.
 */
describe('isValidPan', () => {
  it('accepts the canonical shape, either case, padded or not', () => {
    expect(isValidPan('ABCDE1234F')).toBe(true);
    expect(isValidPan('abcde1234f')).toBe(true); // roster sheets carry lowercase PANs
    expect(isValidPan('  ABCDE1234F  ')).toBe(true);
  });

  it('rejects the status words and placeholders the roster stored as PANs', () => {
    for (const junk of ['Inactive', 'N.A', '-', 'PENDING', '']) {
      expect(isValidPan(junk)).toBe(false);
    }
  });

  /**
   * The masked round-trip hazard: list/detail responses show `******234F`. A client that
   * echoes a masked value back into an edit body must be refused at the format gate, or the
   * mask itself becomes the stored PAN.
   */
  it('rejects a masked PAN', () => {
    expect(isValidPan('******234F')).toBe(false);
  });

  it('rejects near-misses (wrong segment lengths, digits where letters go)', () => {
    expect(isValidPan('ABCD1234F')).toBe(false); // 4 letters
    expect(isValidPan('ABCDE123F')).toBe(false); // 3 digits
    expect(isValidPan('ABCDE12345')).toBe(false); // digit where the last letter goes
    expect(isValidPan('ABCDE 1234F')).toBe(false); // interior space is the importer's job to compact
  });

  it('is the same rule the importer applies (pattern parity)', () => {
    expect(PAN_PATTERN.source).toBe('^[A-Z]{5}\\d{4}[A-Z]$');
    expect(PAN_PATTERN.flags).toContain('i');
  });
});

describe('isValidIfsc', () => {
  it('accepts a real IFSC, either case', () => {
    expect(isValidIfsc('SBIN0001234')).toBe(true);
    expect(isValidIfsc('sbin0001234')).toBe(true);
    expect(isValidIfsc(' HDFC0000523 ')).toBe(true);
  });

  /**
   * The fifth character is a reserved zero. A code without it routes to no branch — the
   * importer's own message says why this matters: "payments to this account would fail".
   */
  it('rejects a code whose reserved zero is missing', () => {
    expect(isValidIfsc('SBIN1001234')).toBe(false);
  });

  it('rejects wrong lengths and the sheet\'s nothing-values', () => {
    for (const junk of ['SBIN000123', 'SBIN00012345', 'N.A', '-', '']) {
      expect(isValidIfsc(junk)).toBe(false);
    }
  });

  it('is the same rule the importer applies (pattern parity)', () => {
    expect(IFSC_PATTERN.source).toBe('^[A-Z]{4}0[A-Z0-9]{6}$');
    expect(IFSC_PATTERN.flags).toContain('i');
  });
});

describe('Verhoeff checksum', () => {
  /** The worked example from the algorithm's own literature: 236 takes check digit 3. */
  it('reproduces the published reference vector (236 -> 3)', () => {
    expect(verhoeffCheckDigit('236')).toBe(3);
    expect(isValidAadhaar('2363')).toBe(false); // right checksum, but not 12 digits — shape still rules
  });

  /**
   * Known-good vectors computed from the algorithm itself (11-digit payload -> check digit),
   * hard-coded so a broken table edit cannot silently agree with itself.
   * 999941057058 is also inside UIDAI's published 9999-... test range — an external cross-check
   * that this implementation and the issuer's agree.
   */
  it.each([
    ['12345678901', 0],
    ['99994105705', 8],
    ['23456789012', 4],
    ['11111111111', 5],
    ['00000000000', 3],
  ])('computes the check digit of %s as %i, and the full number validates', (payload, digit) => {
    expect(verhoeffCheckDigit(payload)).toBe(digit);
    const full = payload + String(digit);
    // Degenerate repeats are refused by policy even when the checksum holds (see isValidAadhaar).
    if (!/^(\d)\1{11}$/.test(full)) expect(isValidAadhaar(full)).toBe(true);
  });

  it('catches every wrong final digit for a given payload', () => {
    const payload = '99994105705';
    for (let d = 0; d <= 9; d++) {
      if (d === 8) continue;
      expect(isValidAadhaar(payload + String(d))).toBe(false);
    }
  });

  /**
   * The two mistakes Verhoeff exists for: one digit mistyped, two neighbours swapped.
   * A mod-10 scheme misses some transpositions; this must not.
   */
  it('catches a single-digit substitution and an adjacent transposition', () => {
    const good = '999941057058';
    expect(isValidAadhaar(good)).toBe(true);
    expect(isValidAadhaar('999941057059')).toBe(false); // last digit off by one
    expect(isValidAadhaar('999941057508')).toBe(false); // 0 and 5 swapped
    expect(isValidAadhaar('999914057058')).toBe(false); // 4 and 1 swapped
  });

  it('refuses to compute a check digit for non-digit input instead of returning nonsense', () => {
    expect(() => verhoeffCheckDigit('12345 67890')).toThrow();
    expect(() => verhoeffCheckDigit('Inactive')).toThrow();
  });
});

describe('isValidAadhaar', () => {
  /**
   * The founding failure: the Aadhaar column doubled as a status note, and 129 cells holding
   * the word "Inactive" were stored — encrypted — as identity numbers.
   */
  it('rejects the words the roster wrote in the Aadhaar column', () => {
    for (const junk of ['Inactive', 'N.A', 'Left', '', '  ']) {
      expect(isValidAadhaar(junk)).toBe(false);
    }
  });

  it('rejects a 12-digit number whose checksum does not hold (the typo case)', () => {
    expect(isValidAadhaar('123456789012')).toBe(false); // check digit for 12345678901 is 0, not 2
    expect(isValidAadhaar('123456789010')).toBe(true);
  });

  /**
   * All-same-digit placeholders. `999999999999` passes raw Verhoeff (and 9999-prefixed is
   * UIDAI's test range), so without the explicit refusal the classic keyboard-lean placeholder
   * would be stored as a real identity. `000000000000` fails the checksum anyway, but the rule
   * must not depend on that accident.
   */
  it('rejects every all-same-digit value, checksum-valid or not', () => {
    for (let d = 0; d <= 9; d++) {
      expect(isValidAadhaar(String(d).repeat(12))).toBe(false);
    }
  });

  it('rejects wrong lengths even when the digits are otherwise fine', () => {
    expect(isValidAadhaar('99994105705')).toBe(false); // 11 digits
    expect(isValidAadhaar('9999410570581')).toBe(false); // 13 digits
  });

  it('rejects the card-print grouping — storage is compact digits only', () => {
    // "9999 4105 7058" is how the card prints it; the importer compacts before validating,
    // and the API asks the clerk to enter it without spaces so stored values stay comparable.
    expect(isValidAadhaar('9999 4105 7058')).toBe(false);
  });

  it('rejects a masked Aadhaar echoed back from a list view', () => {
    expect(isValidAadhaar('********7058')).toBe(false);
  });

  it('keeps the historical shape rule exported for shape-vs-checksum error wording', () => {
    expect(AADHAAR_PATTERN.test('123456789012')).toBe(true); // shape fine…
    expect(isValidAadhaar('123456789012')).toBe(false); // …checksum not
  });
});

/**
 * The placeholder predicate exists so the two rejection paths can say WHY, and it only earns its
 * keep if it is consulted BEFORE the checksum. `999999999999` is the case that proves it: it is
 * a valid Verhoeff string, so a caller that reaches for the checksum first reports a mistyped
 * digit in a number that has none, and sends a clerk to re-read a card for nothing.
 */
describe('isPlaceholderAadhaar', () => {
  it('is true for every all-same-digit twelve, and false for a real number', () => {
    for (let d = 0; d <= 9; d++) {
      expect(isPlaceholderAadhaar(String(d).repeat(12))).toBe(true);
    }
    expect(isPlaceholderAadhaar('999941057058')).toBe(false); // checksum-valid, genuine shape
    expect(isPlaceholderAadhaar('999941057059')).toBe(false); // an ordinary typo, not a placeholder
  });

  it('tolerates the surrounding whitespace a pasted cell carries, like the validator', () => {
    expect(isPlaceholderAadhaar('  999999999999  ')).toBe(true);
  });

  it('is false for anything that is not a twelve-digit string', () => {
    for (const v of ['99999999999', '9999999999999', '9999 9999 9999', 'Inactive', '', 999999999999, null, undefined]) {
      expect(isPlaceholderAadhaar(v)).toBe(false);
    }
  });

  /**
   * The ordering guarantee the callers' messages depend on. `999999999999` walks the Verhoeff
   * tables back to 0, so the checksum ALONE would accept it; the placeholder rule is what
   * refuses it, which means "invalid" here never means "the checksum failed".
   */
  it('catches the one placeholder the checksum would otherwise wave through', () => {
    expect(verhoeffCheckDigit('99999999999')).toBe(9); // the checksum really does hold for 999999999999…
    expect(isPlaceholderAadhaar('999999999999')).toBe(true); // …and this is what stops it
    expect(isValidAadhaar('999999999999')).toBe(false);
  });

  it('agrees with isValidAadhaar on every value it claims: a placeholder is never valid', () => {
    for (let d = 0; d <= 9; d++) {
      const v = String(d).repeat(12);
      expect(isPlaceholderAadhaar(v) && isValidAadhaar(v)).toBe(false);
    }
  });
});

describe('normalisePhone', () => {
  it('canonicalises the three real prefixes onto the ten-digit national form', () => {
    expect(normalisePhone('9876543210')).toBe('9876543210');
    expect(normalisePhone('+919876543210')).toBe('9876543210');
    expect(normalisePhone('919876543210')).toBe('9876543210');
    expect(normalisePhone('09876543210')).toBe('9876543210');
  });

  it('strips the separators people actually type', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('(+91) 98765 43210')).toBe('9876543210');
    expect(normalisePhone(' 98765 43210 ')).toBe('9876543210');
  });

  /**
   * A ten-digit number STARTING with 91 is itself a mobile (the 91xxxxxxxx ranges are live).
   * Stripping "91" by prefix alone would silently turn it into an eight-digit wreck — the
   * country code is only ever removed from a twelve-digit string.
   */
  it('does not mistake a 91-leading mobile for a country code', () => {
    expect(normalisePhone('9198765432')).toBe('9198765432');
  });

  it('accepts a spreadsheet-typed number cell', () => {
    expect(normalisePhone(9876543210)).toBe('9876543210');
  });

  it('returns null for landline-shaped and short numbers rather than guessing', () => {
    expect(normalisePhone('0712345678')).toBeNull(); // 10 digits starting 0: not a mobile range
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('5876543210')).toBeNull(); // mobiles start 6-9
  });

  /**
   * Two numbers in one cell is the roster's habit ("9404410787 / 9850042526"). Splitting a
   * cell is `readPhoneNumbers`' job; a NORMALISER handed two numbers must refuse, because
   * returning either one silently drops the other.
   */
  it('returns null when handed more than one number, or any letters', () => {
    expect(normalisePhone('9404410787 / 9850042526')).toBeNull();
    expect(normalisePhone('Mob: 9876543210')).toBeNull();
    expect(normalisePhone('N.A')).toBeNull();
  });

  it('returns null for null, undefined and objects instead of coercing them', () => {
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
    expect(normalisePhone({})).toBeNull();
  });
});
