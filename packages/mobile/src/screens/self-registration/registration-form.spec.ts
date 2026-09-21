jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../services/api.service', () => ({ getApiBaseUrl: () => 'http://localhost:3001/api/v1' }));

import { ApplicationStatus, EmploymentCategory, registrationStepProblems } from '@fapoms/shared';
import { en } from '../../i18n/locales/en';
import type { RegistrationApplication } from '../../services/self-registration.service';
import {
  FORMAT_HINT_KEYS, STEP_TITLE_KEYS, applicationRef, problemMessage, registrationFieldPatch, seedRegistrationForm,
  wholeFormPatch,
} from './registration-form';

/**
 * The phone asks the same questions as the web link, under the same shared rules; these pin the
 * phone's half — that a saved application fills the boxes, that one box saves only itself, and that
 * every problem the shared rules can report has a real sentence rather than a raw key.
 */

const application: RegistrationApplication = {
  id: '5854c1c1-aaaa-bbbb-cccc-dddddddddddd',
  fullName: 'Nishant Nishu',
  mobile: '9876543210',
  email: 'n@example.com',
  dateOfBirth: '1990-04-21T00:00:00.000Z',
  gender: 'Male',
  address: '12 Marine Drive',
  state: 'Maharashtra',
  city: 'Mumbai',
  pincode: '400001',
  experienceYears: 0,
  currentEmployer: null,
  expertise: null,
  availability: null,
  employmentCategory: EmploymentCategory.FREELANCER,
  consentAcceptedAt: null,
  consentVersion: null,
  status: ApplicationStatus.DRAFT,
  reviewNotes: null,
  extendedProfile: { fields: { panNumber: 'ABCDE1234F', district: 'Mumbai' } },
};

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);

describe('the phone registration form', () => {
  it('fills every box from what is already saved, keeping a fresher as 0 rather than blank', () => {
    const form = seedRegistrationForm(application);
    expect(form).toMatchObject({
      fullName: 'Nishant Nishu', dateOfBirth: '1990-04-21', experienceYears: '0', currentEmployer: '',
      employmentCategory: EmploymentCategory.FREELANCER, panNumber: 'ABCDE1234F', district: 'Mumbai', ifscCode: '',
    });
  });

  it('saves one box as itself: a column, a record field, or a cleared number', () => {
    expect(registrationFieldPatch('city', ' Pune ')).toEqual({ city: 'Pune' });
    expect(registrationFieldPatch('panNumber', 'ABCDE1234F')).toEqual({ record: { panNumber: 'ABCDE1234F' } });
    expect(registrationFieldPatch('experienceYears', '')).toEqual({ experienceYears: null });
    expect(registrationFieldPatch('employmentCategory', '')).toEqual({});
  });

  it('gathers record fields under one record when a whole step is saved', () => {
    const patch = wholeFormPatch(seedRegistrationForm(application));
    expect(patch.record).toMatchObject({ panNumber: 'ABCDE1234F', district: 'Mumbai' });
    expect(patch).not.toHaveProperty('panNumber');
  });

  it('has a sentence for every problem a blank form produces on every step', () => {
    const blank = seedRegistrationForm({
      ...application, fullName: null, dateOfBirth: null, address: null, state: null, city: null, pincode: null,
      employmentCategory: null, experienceYears: null, extendedProfile: null,
    });
    for (const step of [1, 2, 3]) {
      for (const [field, problem] of Object.entries(registrationStepProblems(step, blank))) {
        const message = problemMessage(field as never, problem!);
        const text = 'text' in message ? message.text : lookup(message.key);
        expect(typeof text).toBe('string');
        if ('key' in message) expect(message.key).not.toBe('selfRegistration.errors.checkAnswer');
      }
    }
  });

  it('names every step and every identifier hint in the catalogue', () => {
    [...STEP_TITLE_KEYS, ...Object.values(FORMAT_HINT_KEYS)].forEach((key) => {
      expect(typeof lookup(key)).toBe('string');
    });
  });

  it('quotes the same reference the web shows', () => {
    expect(applicationRef(application.id)).toBe('APP-5854C1C1');
  });
});
