import { referencePhoneForDisplay,
  APPLICATION_REFERENCES_MAX,
  normalizeApplicationReferences,
  referenceSubmitProblem,
  type ApplicationReference,
} from './application-references';

describe('normalizeApplicationReferences', () => {
  it('trims, drops empties and keeps up to three', () => {
    expect(normalizeApplicationReferences([
      { fullName: '  Meera Rao ', phone: '98 220 14455', relationship: ' Former manager ' },
      { fullName: '', phone: '' },
      null,
    ])).toEqual({
      references: [{ fullName: 'Meera Rao', phone: '9822014455', relationship: 'Former manager' }],
      error: null,
    });
  });

  it('refuses a fourth reference rather than silently dropping it', () => {
    const four = [1, 2, 3, 4].map((n) => ({ fullName: `Ref ${n}`, phone: '9822014455' }));
    const { references, error } = normalizeApplicationReferences(four);
    expect(references).toEqual([]);
    expect(error).toMatch(/Only 3 references/);
  });

  it('refuses a number with no name attached', () => {
    expect(normalizeApplicationReferences([{ phone: '9822014455' }]).error)
      .toMatch(/needs a name/);
  });

  it('treats an absent payload as no references, not a failure', () => {
    expect(normalizeApplicationReferences(undefined)).toEqual({ references: [], error: null });
  });

  it('keeps a valid email, lowercased', () => {
    expect(normalizeApplicationReferences([
      { fullName: 'Meera Rao', phone: '9822014455', email: 'Meera@Example.COM' },
    ])).toEqual({
      references: [{ fullName: 'Meera Rao', phone: '9822014455', email: 'meera@example.com' }],
      error: null,
    });
  });

  it('refuses a bad email, naming whose it is', () => {
    const { references, error } = normalizeApplicationReferences([
      { fullName: 'Meera Rao', phone: '9822014455', email: 'not-an-email' },
    ]);
    expect(references).toEqual([]);
    expect(error).toMatch(/Meera Rao/);
    expect(error).toMatch(/email/);
  });

  it('an email alone does not make a reference without a name', () => {
    expect(normalizeApplicationReferences([{ email: 'meera@example.com' }]).error)
      .toMatch(/needs a name/);
  });
});

describe('normalizeApplicationReferences — how a number is kept', () => {
  /**
   * Every form shows the number behind a fixed "+91", so what is stored has to be the 10 digits.
   * Keeping raw digits turned "+91 98765 43210" into "919876543210", shown as "+91 919876543210".
   */
  it.each([
    ['9822014455'],
    ['+91 98220 14455'],
    ['919822014455'],
    ['098220-14455'],
  ])('stores %s as the 10-digit number', (typed) => {
    const { references, error } = normalizeApplicationReferences([{ fullName: 'Meera Rao', phone: typed }]);
    expect(error).toBeNull();
    expect(references[0].phone).toBe('9822014455');
  });

  /** Not a mobile yet: kept as its digits so the candidate sees it and submit can name it. */
  it('keeps a number that does not dial as typed digits, for submit to name', () => {
    const { references } = normalizeApplicationReferences([{ fullName: 'Old Boss', phone: '12-3' }]);
    expect(references[0].phone).toBe('123');
    expect(referenceSubmitProblem(references)).toMatch(/at least one reference/);
  });
});

describe('referenceSubmitProblem', () => {
  it('passes with one ringable reference', () => {
    expect(referenceSubmitProblem([{ fullName: 'Meera Rao', phone: '9822014455' }])).toBeNull();
  });

  it('fails with none, or a name with no number', () => {
    expect(referenceSubmitProblem([])).toMatch(/at least one reference/);
    expect(referenceSubmitProblem([{ fullName: 'Meera Rao' }])).toMatch(/at least one reference/);
  });

  it('names the reference whose number does not dial', () => {
    expect(referenceSubmitProblem([
      { fullName: 'Meera Rao', phone: '9822014455' },
      { fullName: 'Old Boss', phone: '123' },
    ])).toMatch(/Old Boss/);
  });

  it('caps the rule at three names', () => {
    expect(APPLICATION_REFERENCES_MAX).toBe(3);
    const ref: ApplicationReference = { fullName: 'Meera Rao', phone: '9822014455' };
    expect(ref.fullName).toBe('Meera Rao');
  });
});

describe('referencePhoneForDisplay', () => {
  it('shows a mobile the same way however it was stored', () => {
    for (const stored of ['9822014455', '+919822014455', '919822014455']) {
      expect(referencePhoneForDisplay(stored)).toBe('+91 98220 14455');
    }
  });

  it('does not put +91 in front of something that is not a mobile', () => {
    expect(referencePhoneForDisplay('020 2612 3456')).toBe('020 2612 3456');
  });

  it('shows nothing for nothing', () => {
    expect(referencePhoneForDisplay(null)).toBe('');
    expect(referencePhoneForDisplay('  ')).toBe('');
  });
});

