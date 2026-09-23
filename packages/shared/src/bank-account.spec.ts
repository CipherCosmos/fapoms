import {
  isBankAccountNumber, normaliseBankAccountNumber, BANK_ACCOUNT_NUMBER_RULE,
} from './identity-validation';
import { bankAccountConfirmProblem, registrationStepProblems, REGISTRATION_REQUIRED_DOCUMENTS } from './registration-form';
import { identifierFormatIssue } from './identifier-entry';
import {
  OnboardingDocument, isVerifiableDocument, isIdentityDocument, DOCUMENTS_PRINTING_A_NAME, DOCUMENT_PRINTED_FIELDS,
} from './assayer-roster-vocabulary';

/**
 * The bank account a payout goes to — the free checks, since Indian account numbers carry no check
 * digit and nothing short of a bank can prove one real.
 *
 * Shape (9–18 digits), typed twice, and a passbook the reviewer verifies it against.
 */
describe('the bank account number', () => {
  it.each(['123456789', '123456789012', '123456789012345678', '1234 5678 9012', '1234-5678-9012'])(
    'accepts %s — separators are what people copy out of a passbook', (v) => {
      expect(isBankAccountNumber(v)).toBe(true);
    },
  );

  it.each(['12345678', '1234567890123456789', 'ABCD12345678', '', 'SBI 12345'])('refuses %s', (v) => {
    expect(isBankAccountNumber(v)).toBe(false);
  });

  it('stores the digits only', () => {
    expect(normaliseBankAccountNumber(' 1234 5678-9012 ')).toBe('123456789012');
    expect(normaliseBankAccountNumber(null)).toBe('');
  });

  it('is flagged as a format issue as it is typed, like PAN and IFSC', () => {
    expect(identifierFormatIssue('bankAccountNumber', '12345')).toBe('bankAccount');
    expect(identifierFormatIssue('bankAccountNumber', '123456789012')).toBeNull();
    expect(BANK_ACCOUNT_NUMBER_RULE).toMatch(/9 to 18 digits/);
  });
});

describe('typing it twice', () => {
  it('agrees however each was spaced', () => {
    expect(bankAccountConfirmProblem('123456789012', '1234 5678 9012')).toBeNull();
  });

  it('asks for the second typing, then names a mismatch', () => {
    expect(bankAccountConfirmProblem('123456789012', '')).toMatch(/second time to confirm/);
    expect(bankAccountConfirmProblem('123456789012', '123456789099')).toMatch(/do not match/);
  });

  it('asks nothing when there is no account number', () => {
    expect(bankAccountConfirmProblem('', '')).toBeNull();
  });

  const step3 = (over: Record<string, unknown>) => registrationStepProblems(3, {
    fullName: 'A', email: '', dateOfBirth: '', gender: '', address: '', state: '', city: '', pincode: '',
    experienceYears: '', currentEmployer: '', expertise: '', availability: '', employmentCategory: 'FREELANCER',
    panNumber: '', aadhaarNumber: '', bankAccountNumber: '', ifscCode: '', bankName: '', qualification: '',
    emergencyContactName: '', emergencyContactPhone: '', emergencyContactRelation: '', alternatePhone: '',
    ...over,
  } as never);

  /** The step rule both forms use; a form that carries the second box must have it agree. */
  it('holds the bank step until the two agree, on a form that asks for it', () => {
    expect(step3({ bankAccountNumber: '123456789012', bankAccountNumberConfirm: '1' }).bankAccountNumberConfirm)
      .toMatchObject({ code: 'mismatch' });
    expect(step3({ bankAccountNumber: '123456789012', bankAccountNumberConfirm: '123456789012' }).bankAccountNumberConfirm)
      .toBeUndefined();
    // A form without the box is judged only on shape.
    expect(step3({ bankAccountNumber: '123456789012' }).bankAccountNumberConfirm).toBeUndefined();
  });
});

describe('the passbook', () => {
  it('is required to submit', () => {
    expect(REGISTRATION_REQUIRED_DOCUMENTS).toContain(OnboardingDocument.BANK_PASSBOOK);
  });

  /**
   * Verified, and its holder name compared — but NOT an identity document: that list also means
   * "counts towards KYC", "feeds the score" and "carries its own number", none of which it does.
   */
  it('is verified and name-checked without becoming an identity document', () => {
    expect(isVerifiableDocument(OnboardingDocument.BANK_PASSBOOK)).toBe(true);
    expect(isIdentityDocument(OnboardingDocument.BANK_PASSBOOK)).toBe(false);
    expect(DOCUMENTS_PRINTING_A_NAME).toContain(OnboardingDocument.BANK_PASSBOOK);
    expect(DOCUMENT_PRINTED_FIELDS[OnboardingDocument.BANK_PASSBOOK]).toMatchObject({ name: true });
  });

  it('leaves the ordinary joining paperwork unverified', () => {
    expect(isVerifiableDocument(OnboardingDocument.EXPERIENCE_LETTER)).toBe(false);
  });
});
