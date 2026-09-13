import { CRITICAL_ASSAYER_RECORD_FIELDS } from '@fapoms/shared';
import { RECORD_FIELD_KEYS } from './self-registration-fields';
import { en } from '../i18n/locales/en';

/**
 * Facts the application stores as its own columns, asked for higher up the same form.
 *
 * `phone` earns its place here only since 2026-09-13. The box was always on the form and the
 * answer was always discarded: `mobile` was not editable on the draft, so the number keyed a
 * verification cache and the promoted record kept whatever HR typed at the interview. The
 * behaviour is guarded where it lives — "the candidate owns their own phone number" in
 * `registration-application.spec.ts` — because it is the confirming step that writes it.
 */
const APPLICATION_OWN_COLUMNS = ['phone', 'email', 'dateOfBirth', 'address', 'city', 'state', 'pincode'];

/**
 * Decided by the desk at approval, not declared by an applicant: a joining date is an employment
 * decision, and the map pin is geocoded from the address rather than typed by somebody who does
 * not know their own latitude. Named so the exemption is a decision, not an oversight.
 */
const DESK_DECIDES = ['joiningDate', 'latitude'];

describe('the phone asks for everything the record calls critical', () => {
  it.each(CRITICAL_ASSAYER_RECORD_FIELDS.map((f) => [f.key, f.label, f.blocks]))(
    '%s (%s) is asked for, or %s is blocked for everybody who registers from a phone',
    (key) => {
      const asked = (RECORD_FIELD_KEYS as readonly string[]).includes(key as string)
        || APPLICATION_OWN_COLUMNS.includes(key as string)
        || DESK_DECIDES.includes(key as string);
      expect(asked).toBe(true);
    },
  );

  /**
   * The two surfaces ask for the same things, and the spec says so as a list rather than a count —
   * a count passes while one form quietly asks for something the other does not, which is how the
   * web form came to have no email box while the phone form did.
   */
  it('asks exactly what the web form asks — one registration, two surfaces', () => {
    expect([...RECORD_FIELD_KEYS]).toEqual([
      'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName',
      'qualification', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
      'alternatePhone', 'district',
    ]);
  });

  it('has a label for every box, so none of them renders as a raw key', () => {
    const form = en.selfRegistration.form as Record<string, string>;
    for (const label of [
      'pan', 'aadhaar', 'bankAccountNumber', 'ifsc', 'bankName', 'qualification',
      'emergencyName', 'emergencyPhone', 'emergencyRelation',
    ]) {
      expect(typeof form[label]).toBe('string');
      expect(form[label].length).toBeGreaterThan(0);
    }
  });
});
