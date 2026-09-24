import { ApplicationStatus } from './assayer-application';
import { dateOfBirthProblem } from './assayer-record';
import { EmploymentCategory } from './assayer-roster-vocabulary';
import { identifierFormatIssue, mobileNumberLooksWrong } from './identifier-entry';
import { isBankAccountNumber, normaliseBankAccountNumber } from './identity-validation';

/**
 * THE CANDIDATE'S REGISTRATION FORM, AS EVERY SURFACE ASKS IT.
 *
 * A candidate can fill their application in from the emailed web link or from the phone app. The
 * two used to decide separately what a step needed before it let them on, which is how the phone
 * came to take a two-letter address and a blank date of birth that the web refused. What is
 * required, what shape each answer must have and where a returning candidate resumes are decided
 * here once; each surface only words the problems — the web in English, the phone through its
 * translations — so the rules cannot drift apart again.
 *
 * Nothing here is the server's validation. Submit re-checks what matters; these rules exist so a
 * candidate hears about a problem at the box, not after the whole form is filled.
 */

export const REGISTRATION_STEP_COUNT = 4;

/** Backend `UpdateDraftRequestDto.experienceYears` is `@IsInt() @Min(0) @Max(60)`. */
export const REGISTRATION_EXPERIENCE_MIN = 0;
export const REGISTRATION_EXPERIENCE_MAX = 60;

/** The record keeps gender as free text; these are the values both forms offer. */
export const REGISTRATION_GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'] as const;

/**
 * Longest value each box may hold: the draft DTO's limits, and the record columns an answer is
 * promoted into — so an over-long answer is refused at its box, not as a generic save failure.
 */
export const REGISTRATION_FIELD_LIMITS: Readonly<Record<string, number>> = {
  fullName: 200,
  email: 255,
  city: 100,
  currentEmployer: 200,
  expertise: 300,
  availability: 200,
  bankName: 150,
  qualification: 150,
  emergencyContactName: 200,
  emergencyContactRelation: 100,
};

/** Documents asked for only when they apply to the candidate's circumstances. */
export const REGISTRATION_CONDITIONAL_DOCUMENTS: readonly string[] = ['RENT_AGREEMENT', 'ELECTRICITY_BILL'];

/** Every answer the form holds, as the text in its box. */
export interface RegistrationFormValues {
  fullName: string;
  dateOfBirth: string;
  gender: string;
  email: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string;
  experienceYears: string;
  currentEmployer: string;
  expertise: string;
  availability: string;
  employmentCategory: EmploymentCategory | '';
  panNumber: string;
  aadhaarNumber: string;
  bankAccountNumber: string;
  /**
   * The account number typed a second time. Only on forms that ask for it; when present, step 3
   * refuses to continue until it agrees with `bankAccountNumber`. A form seeds it with the number
   * already on file, so only a number typed NOW has to be typed twice.
   */
  bankAccountNumberConfirm?: string;
  ifscCode: string;
  bankName: string;
  qualification: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  alternatePhone: string;
}

export type RegistrationFormField = keyof RegistrationFormValues;

/** Why a box stops the candidate moving on. Each surface turns these into its own sentence. */
export type RegistrationProblem =
  | { code: 'required' }
  | { code: 'tooShort' }
  | { code: 'tooLong'; max: number; length: number }
  | { code: 'invalid' }
  /** Typed twice and the two disagree, or the second has not been typed. */
  | { code: 'mismatch'; message: string }
  | { code: 'outOfRange'; min: number; max: number }
  /** The shared age-and-calendar rule, which already speaks in full sentences the server also uses. */
  | { code: 'dateOfBirth'; message: string };

export type RegistrationStepProblems = Partial<Record<RegistrationFormField, RegistrationProblem>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isSixDigitPincode(value: string): boolean {
  return /^\d{6}$/.test((value || '').trim());
}


/**
 * Whether the account number was typed the same way twice — or why not.
 *
 * The check that actually catches a slip: nothing about a wrong digit makes the number invalid, so
 * the only defence short of asking a bank is having it typed a second time, from the passbook,
 * not pasted. Null when they agree or when there is no account number to confirm.
 */
export function bankAccountConfirmProblem(account: string, confirm: string): string | null {
  const a = normaliseBankAccountNumber(account);
  if (!a) return null;
  const c = normaliseBankAccountNumber(confirm);
  if (!c) return 'Type the account number a second time to confirm it.';
  return a === c ? null : 'The two account numbers do not match — check each digit against the passbook.';
}

/**
 * Documents a candidate cannot submit without. The server refuses the submit; both forms mark
 * these and stop at the documents step first, so all three say the same thing.
 *
 * The passbook is here because it is the one evidence of the account a payout goes to: a number
 * with nothing to check it against is a number nobody can say is theirs.
 */
export const REGISTRATION_REQUIRED_DOCUMENTS: readonly string[] = ['BANK_PASSBOOK'];

export function registrationLengthProblem(key: string, value: string): RegistrationProblem | null {
  const max = REGISTRATION_FIELD_LIMITS[key];
  const length = (value ?? '').length;
  return max && length > max ? { code: 'tooLong', max, length } : null;
}

/** What blocks leaving `step`. Empty means the candidate may continue. */
export function registrationStepProblems(step: number, f: RegistrationFormValues): RegistrationStepProblems {
  const problems: RegistrationStepProblems = {};
  const set = (key: RegistrationFormField, problem: RegistrationProblem | null) => {
    if (problem) problems[key] = problem;
  };
  const tooLong = (key: RegistrationFormField) => set(key, registrationLengthProblem(key, String(f[key] ?? '')));

  if (step === 1) {
    if (!f.fullName.trim()) set('fullName', { code: 'required' });
    else if (f.fullName.trim().length < 3) set('fullName', { code: 'tooShort' });
    else tooLong('fullName');

    if (f.email.trim() && !EMAIL_PATTERN.test(f.email.trim())) set('email', { code: 'invalid' });
    else tooLong('email');

    // Required: HR chased a missing date of birth afterwards anyway, and the age rule needs one.
    if (!f.dateOfBirth.trim()) set('dateOfBirth', { code: 'required' });
    else {
      const message = dateOfBirthProblem(f.dateOfBirth);
      if (message) set('dateOfBirth', { code: 'dateOfBirth', message });
    }
  }

  if (step === 2) {
    if (!f.pincode.trim()) set('pincode', { code: 'required' });
    else if (!isSixDigitPincode(f.pincode)) set('pincode', { code: 'invalid' });
    if (!f.state.trim()) set('state', { code: 'required' });
    if (!f.city.trim()) set('city', { code: 'required' });
    if (!f.address.trim()) set('address', { code: 'required' });
    else if (f.address.trim().length < 8) set('address', { code: 'tooShort' });
    if (f.experienceYears.trim()) {
      const years = Number(f.experienceYears);
      if (!Number.isInteger(years) || years < REGISTRATION_EXPERIENCE_MIN || years > REGISTRATION_EXPERIENCE_MAX) {
        set('experienceYears', { code: 'outOfRange', min: REGISTRATION_EXPERIENCE_MIN, max: REGISTRATION_EXPERIENCE_MAX });
      }
    }
    (['city', 'currentEmployer', 'expertise', 'availability'] as const).forEach(tooLong);
  }

  if (step === 3) {
    if (!f.employmentCategory) set('employmentCategory', { code: 'required' });
    (['panNumber', 'aadhaarNumber', 'ifscCode'] as const).forEach((key) => {
      if (f[key].trim() && identifierFormatIssue(key, f[key])) set(key, { code: 'invalid' });
    });
    if (f.bankAccountNumber.trim() && !isBankAccountNumber(f.bankAccountNumber)) {
      set('bankAccountNumber', { code: 'invalid' });
    } else if (f.bankAccountNumberConfirm !== undefined) {
      const mismatch = bankAccountConfirmProblem(f.bankAccountNumber, f.bankAccountNumberConfirm);
      if (mismatch) set('bankAccountNumberConfirm', { code: 'mismatch', message: mismatch });
    }
    (['alternatePhone', 'emergencyContactPhone'] as const).forEach((key) => {
      if (mobileNumberLooksWrong(f[key])) set(key, { code: 'invalid' });
    });
    (['bankName', 'qualification', 'emergencyContactName', 'emergencyContactRelation'] as const).forEach(tooLong);
  }

  return problems;
}

/** The subset of an application `inferRegistrationStep` reads. */
export interface RegistrationProgressView {
  status: ApplicationStatus | string;
  consentAcceptedAt?: string | Date | null;
  employmentCategory?: string | null;
  address?: string | null;
  pincode?: string | null;
  state?: string | null;
  city?: string | null;
  experienceYears?: number | null;
  currentEmployer?: string | null;
  expertise?: string | null;
  availability?: string | null;
  extendedProfile?: { fields?: Record<string, unknown> } | null;
}

/** The furthest step a returning candidate has visibly started, judged from what is saved. */
export function inferRegistrationStep(
  app: RegistrationProgressView,
  documents: ReadonlyArray<{ filePaths?: readonly string[] | null }>,
): number {
  if (app.status !== ApplicationStatus.DRAFT && app.status !== ApplicationStatus.AWAITING_INFO) return 1;
  if (documents.some((d) => (d.filePaths?.length ?? 0) > 0) || app.consentAcceptedAt) return 4;
  const fields = app.extendedProfile?.fields ?? {};
  if (app.employmentCategory || fields.panNumber || fields.aadhaarNumber || fields.bankAccountNumber
    || fields.ifscCode || fields.bankName) {
    return 3;
  }
  if (app.address || app.pincode || app.state || app.city || app.experienceYears != null
    || app.currentEmployer || app.expertise || app.availability) {
    return 2;
  }
  return 1;
}

/**
 * Where to reopen the form: the step asked for, pulled back to the first earlier step that would
 * not let them continue — so nobody resumes past a problem they never fixed.
 */
export function resumableRegistrationStep(target: number, f: RegistrationFormValues): number {
  let step = 1;
  while (step < target && step < REGISTRATION_STEP_COUNT
    && Object.keys(registrationStepProblems(step, f)).length === 0) {
    step += 1;
  }
  return step;
}
