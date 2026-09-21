import type {
  IdentifierFormatIssue, RegistrationFormField, RegistrationFormValues, RegistrationProblem,
} from '@fapoms/shared';
import type { TranslationKey, TranslationVars } from '../../i18n/i18n';
import type { DraftPatch, RegistrationApplication } from '../../services/self-registration.service';
import { RECORD_FIELD_KEYS } from '../self-registration-fields';

/**
 * The phone's half of the candidate registration form: turning a saved application into boxes,
 * one box back into a save, and a shared rule's verdict into a sentence.
 *
 * WHAT is required and what shape an answer must have is `registrationStepProblems` in the shared
 * package — the web link runs the same function. Only the wording lives here, so it can be
 * translated.
 */

export type StepErrors = Partial<Record<RegistrationFormField, string>>;

export function seedRegistrationForm(app: RegistrationApplication): RegistrationFormValues {
  const fields = app.extendedProfile?.fields ?? {};
  const record = Object.fromEntries(RECORD_FIELD_KEYS.map((k) => [k, String(fields[k] ?? '')]));
  return {
    fullName: app.fullName ?? '',
    email: app.email ?? '',
    dateOfBirth: app.dateOfBirth ? String(app.dateOfBirth).slice(0, 10) : '',
    gender: app.gender ?? '',
    address: app.address ?? '',
    state: app.state ?? '',
    city: app.city ?? '',
    pincode: app.pincode ?? '',
    experienceYears: app.experienceYears != null ? String(app.experienceYears) : '',
    currentEmployer: app.currentEmployer ?? '',
    expertise: app.expertise ?? '',
    availability: app.availability ?? '',
    employmentCategory: app.employmentCategory ?? '',
    ...(record as Pick<RegistrationFormValues, typeof RECORD_FIELD_KEYS[number]>),
  };
}

/**
 * The save for ONE box — never the whole form.
 *
 * Two saves can leave within milliseconds of each other (blurring a box by tapping a choice), and
 * the server applies each field last-write-wins, so a wide snapshot from the slower one would
 * overwrite what the other had just written. Disjoint patches cannot.
 */
export function registrationFieldPatch(key: RegistrationFormField, value: string): DraftPatch {
  const trimmed = (value ?? '').trim();
  if (key === 'experienceYears') {
    if (trimmed === '') return { experienceYears: null };
    const years = Number(trimmed);
    return Number.isNaN(years) ? {} : { experienceYears: years };
  }
  if (key === 'employmentCategory') {
    return trimmed ? { employmentCategory: trimmed as DraftPatch['employmentCategory'] } : {};
  }
  if ((RECORD_FIELD_KEYS as readonly string[]).includes(key)) {
    return { record: { [key]: trimmed } };
  }
  return { [key]: trimmed } as DraftPatch;
}

/** Every box at once — used only when moving between steps, after the step's own checks pass. */
export function wholeFormPatch(f: RegistrationFormValues): DraftPatch {
  const patch: DraftPatch = {};
  const record: Record<string, string | number> = {};
  for (const key of Object.keys(f) as RegistrationFormField[]) {
    const one = registrationFieldPatch(key, String(f[key] ?? ''));
    if (one.record) Object.assign(record, one.record);
    else Object.assign(patch, one);
  }
  if (Object.keys(record).length > 0) patch.record = record;
  return patch;
}

type Message = { key: TranslationKey; vars?: TranslationVars } | { text: string };

const REQUIRED: Partial<Record<RegistrationFormField, TranslationKey>> = {
  fullName: 'selfRegistration.errors.fullNameRequired',
  dateOfBirth: 'selfRegistration.errors.dateOfBirthRequired',
  pincode: 'selfRegistration.errors.pincodeRequired',
  state: 'selfRegistration.errors.stateRequired',
  city: 'selfRegistration.errors.cityRequired',
  address: 'selfRegistration.errors.addressRequired',
  employmentCategory: 'selfRegistration.errors.employmentCategoryRequired',
};

const TOO_SHORT: Partial<Record<RegistrationFormField, TranslationKey>> = {
  fullName: 'selfRegistration.errors.fullNameTooShort',
  address: 'selfRegistration.errors.addressTooShort',
};

const INVALID: Partial<Record<RegistrationFormField, TranslationKey>> = {
  email: 'selfRegistration.errors.emailInvalid',
  pincode: 'selfRegistration.errors.pincodeInvalid',
  panNumber: 'selfRegistration.errors.panInvalid',
  aadhaarNumber: 'selfRegistration.errors.aadhaarInvalid',
  ifscCode: 'selfRegistration.errors.ifscInvalid',
  bankAccountNumber: 'selfRegistration.errors.bankAccountInvalid',
  alternatePhone: 'selfRegistration.errors.phoneInvalid',
  emergencyContactPhone: 'selfRegistration.errors.phoneInvalid',
};

export function problemMessage(field: RegistrationFormField, problem: RegistrationProblem): Message {
  switch (problem.code) {
    case 'tooLong':
      return { key: 'selfRegistration.errors.tooLong', vars: { max: problem.max, length: problem.length } };
    case 'outOfRange':
      return { key: 'selfRegistration.errors.outOfRange', vars: { min: problem.min, max: problem.max } };
    case 'dateOfBirth':
      return { text: problem.message };
    case 'required':
      return { key: REQUIRED[field] ?? 'selfRegistration.errors.checkAnswer' };
    case 'tooShort':
      return { key: TOO_SHORT[field] ?? 'selfRegistration.errors.checkAnswer' };
    case 'invalid':
      return { key: INVALID[field] ?? 'selfRegistration.errors.checkAnswer' };
  }
}

export const FORMAT_HINT_KEYS: Record<IdentifierFormatIssue, TranslationKey> = {
  pan: 'selfRegistration.errors.hintPan',
  ifsc: 'selfRegistration.errors.hintIfsc',
  aadhaarLength: 'selfRegistration.errors.hintAadhaarLength',
  aadhaarChecksum: 'selfRegistration.errors.hintAadhaarChecksum',
  pincode: 'selfRegistration.errors.hintPincode',
};

export function renderMessage(
  message: Message,
  tr: (key: TranslationKey, vars?: TranslationVars) => string,
): string {
  return 'text' in message ? message.text : tr(message.key, message.vars);
}

export const STEP_TITLE_KEYS: readonly TranslationKey[] = [
  'selfRegistration.steps.personal',
  'selfRegistration.steps.address',
  'selfRegistration.steps.bank',
  'selfRegistration.steps.documents',
];

/** `#APP-1A2B3C4D` — the reference a candidate quotes to the office. */
export function applicationRef(id: string): string {
  return `APP-${(id || '').slice(0, 8).toUpperCase()}`;
}
