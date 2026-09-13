import { CRITICAL_ASSAYER_RECORD_FIELDS } from '@fapoms/shared';
import { RECORD_KEYS } from './PublicRegistration';

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
 * `joiningDate` and `latitude` are deliberately not asked of the candidate.
 *
 * A joining date is an employment decision the desk makes at approval, not something an applicant
 * declares. The map pin is geocoded from the address they gave, and asking somebody for their own
 * latitude is asking for a number they do not have. Both are named here rather than silently
 * excluded, so the exemption is a decision on the record rather than an oversight.
 */
const DESK_DECIDES = ['joiningDate', 'latitude'];

describe('the candidate form asks for everything the record calls critical', () => {
  it.each(CRITICAL_ASSAYER_RECORD_FIELDS.map((f) => [f.key, f.label, f.blocks]))(
    '%s (%s) is asked for, or %s is blocked for everybody who registers here',
    (key) => {
      const asked = (RECORD_KEYS as readonly string[]).includes(key as string)
        || APPLICATION_OWN_COLUMNS.includes(key as string)
        || DESK_DECIDES.includes(key as string);
      expect(asked).toBe(true);
    },
  );

  it('asks the same record fields the phone form does — one registration, two surfaces', () => {
    expect([...RECORD_KEYS]).toEqual([
      'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName',
      'qualification', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
      'alternatePhone', 'district',
    ]);
  });

  it('asks for the numbers, not only the scans', () => {
    expect(RECORD_KEYS).toEqual(expect.arrayContaining([
      'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode',
    ]));
  });

  it('asks who to call if something happens at a branch', () => {
    expect(RECORD_KEYS).toEqual(expect.arrayContaining([
      'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
    ]));
  });
});
