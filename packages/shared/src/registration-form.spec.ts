import { ApplicationStatus } from './assayer-application';
import { EmploymentCategory } from './assayer-roster-vocabulary';
import { identifierFormatIssue, mobileNumberLooksWrong, normaliseIdentifierOnBlur } from './identifier-entry';
import {
  inferRegistrationStep, registrationStepProblems, resumableRegistrationStep, type RegistrationFormValues,
} from './registration-form';

/**
 * The web link and the phone app both ask these questions; this is what they agree a complete
 * answer is. A rule changed here changes on both surfaces, which is the point.
 */

const blank: RegistrationFormValues = {
  fullName: '', dateOfBirth: '', gender: '', email: '', address: '', state: '', district: '', city: '',
  pincode: '', experienceYears: '', currentEmployer: '', expertise: '', availability: '',
  employmentCategory: '', panNumber: '', aadhaarNumber: '', bankAccountNumber: '', ifscCode: '',
  bankName: '', qualification: '', emergencyContactName: '', emergencyContactPhone: '',
  emergencyContactRelation: '', alternatePhone: '',
};

const complete: RegistrationFormValues = {
  ...blank,
  fullName: 'Ramesh Kumar Sharma',
  dateOfBirth: '1985-04-21',
  pincode: '400001',
  state: 'Maharashtra',
  city: 'Mumbai',
  address: '12 Marine Drive, Churchgate',
  employmentCategory: EmploymentCategory.FREELANCER,
};

describe('what each step needs before the candidate moves on', () => {
  it('asks for a name, a date of birth, a pincode, state, city, address and a category — and nothing else', () => {
    expect(Object.keys(registrationStepProblems(1, blank)).sort()).toEqual(['dateOfBirth', 'fullName']);
    expect(Object.keys(registrationStepProblems(2, blank)).sort()).toEqual(['address', 'city', 'pincode', 'state']);
    expect(Object.keys(registrationStepProblems(3, blank))).toEqual(['employmentCategory']);
    [1, 2, 3].forEach((step) => expect(registrationStepProblems(step, complete)).toEqual({}));
  });

  it('refuses a name or an address too short to be real', () => {
    expect(registrationStepProblems(1, { ...complete, fullName: 'Ra' }).fullName).toEqual({ code: 'tooShort' });
    expect(registrationStepProblems(2, { ...complete, address: 'Flat 2' }).address).toEqual({ code: 'tooShort' });
  });

  it('passes the age rule through in its own words', () => {
    const problem = registrationStepProblems(1, { ...complete, dateOfBirth: '2020-01-01' }).dateOfBirth;
    expect(problem).toMatchObject({ code: 'dateOfBirth' });
    expect((problem as { message: string }).message.length).toBeGreaterThan(0);
  });

  it('checks optional identifiers only once something is typed', () => {
    const typed = { ...complete, panNumber: 'ABCDE12', ifscCode: 'SBIN001', aadhaarNumber: '1234', bankAccountNumber: '12' };
    expect(Object.keys(registrationStepProblems(3, typed)).sort())
      .toEqual(['aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'panNumber']);
  });

  it('names the limit and the length when an answer is too long', () => {
    expect(registrationStepProblems(2, { ...complete, city: 'x'.repeat(101) }).city)
      .toEqual({ code: 'tooLong', max: 100, length: 101 });
  });

  it('keeps experience within what the server accepts', () => {
    expect(registrationStepProblems(2, { ...complete, experienceYears: '61' }).experienceYears)
      .toEqual({ code: 'outOfRange', min: 0, max: 60 });
    expect(registrationStepProblems(2, { ...complete, experienceYears: '0' })).toEqual({});
  });
});

describe('where a returning candidate picks up', () => {
  const draft = { status: ApplicationStatus.DRAFT };

  it('goes as far as what they saved', () => {
    expect(inferRegistrationStep(draft, [])).toBe(1);
    expect(inferRegistrationStep({ ...draft, pincode: '400001' }, [])).toBe(2);
    expect(inferRegistrationStep({ ...draft, extendedProfile: { fields: { ifscCode: 'SBIN0001234' } } }, [])).toBe(3);
    expect(inferRegistrationStep(draft, [{ filePaths: ['a'] }])).toBe(4);
  });

  it('never resumes past a step that would not let them continue', () => {
    expect(resumableRegistrationStep(4, complete)).toBe(4);
    expect(resumableRegistrationStep(4, { ...complete, address: '' })).toBe(2);
    expect(resumableRegistrationStep(3, blank)).toBe(1);
  });
});

describe('identifier hints', () => {
  it('tells a mistyped Aadhaar apart from one that fails the checksum', () => {
    expect(identifierFormatIssue('aadhaarNumber', '1234')).toBe('aadhaarLength');
    expect(identifierFormatIssue('aadhaarNumber', '123456789012')).toBe('aadhaarChecksum');
  });

  it('says nothing about a masked number on file', () => {
    expect(identifierFormatIssue('panNumber', '******234F')).toBeNull();
  });

  it('tidies pasted punctuation and nothing more', () => {
    expect(normaliseIdentifierOnBlur('panNumber', 'abcde 1234-f')).toBe('ABCDE1234F');
    expect(normaliseIdentifierOnBlur('aadhaarNumber', '1234 5678 9012')).toBe('123456789012');
    expect(normaliseIdentifierOnBlur('pincode', '400001')).toBeNull();
  });

  it('waits for ten digits before calling a mobile number wrong', () => {
    expect(mobileNumberLooksWrong('12345')).toBe(false);
    expect(mobileNumberLooksWrong('1234567890')).toBe(true);
    expect(mobileNumberLooksWrong('9876543210')).toBe(false);
  });
});
