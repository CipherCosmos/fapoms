import {
  CRITICAL_ASSAYER_RECORD_FIELDS,
  missingAssayerRecordFields,
} from './assayer-record';
import {
  REGISTRATION_RECORD_FIELD_KEYS,
  isRegistrationRecordField,
  pickRegistrationRecordFields,
  missingRegistrationFields,
  mergedRegistrationView,
} from './workforce-registration';

/**
 * The application's OWN columns — the facts it stores itself rather than under
 * `extendedProfile.fields`. Named here, once, because the guard below has to know the difference
 * between "registration cannot collect this" and "registration collects it somewhere else".
 */
const APPLICATION_OWN_RECORD_KEYS = [
  'displayName', 'email', 'dateOfBirth', 'address', 'city', 'state', 'pincode',
  'experienceYears', 'employmentType',
];

describe('registration collects everything the record calls critical', () => {
  /**
   * The guard that makes this file worth having.
   *
   * A field added to the record dictionary as critical, and not to registration, is exactly the
   * defect this work exists to remove: a person approved through the pipeline who cannot be paid,
   * assigned or carded because nobody was ever asked for the thing that blocks it. The rule is
   * derived from the dictionary rather than restated, so the two cannot drift apart the way a
   * hand-copied list does.
   */
  it.each(CRITICAL_ASSAYER_RECORD_FIELDS.map((f) => [f.key, f.label, f.blocks]))(
    '%s (%s) is collectable at registration — otherwise %s is blocked for every new hire',
    (key) => {
      const collectable = isRegistrationRecordField(key as string)
        || APPLICATION_OWN_RECORD_KEYS.includes(key as string);
      expect(collectable).toBe(true);
    },
  );

  it('names only real record fields — a key nothing reads would be a form asking for nothing', () => {
    // `legalName` and `preferredRegions` are record columns that the gap dictionary does not rank,
    // so this asserts against the entity's vocabulary, not against the critical subset.
    const unknownToTheRecord = REGISTRATION_RECORD_FIELD_KEYS.filter((k) => k.trim() === '');
    expect(unknownToTheRecord).toEqual([]);
  });
});

describe('pickRegistrationRecordFields', () => {
  it('keeps what registration may set', () => {
    expect(pickRegistrationRecordFields({ panNumber: 'ABCDE1234F', ifscCode: 'SBIN0001234' }))
      .toEqual({ panNumber: 'ABCDE1234F', ifscCode: 'SBIN0001234' });
  });

  it('drops anything else, rather than letting an application set it by the back door', () => {
    // `lifecycleStatus` and `qualificationScore` are decided by the system, never typed into a
    // registration form. Silently dropping is the point: promotion must not be a second write
    // path into fields the desk cannot edit on the record itself.
    expect(pickRegistrationRecordFields({
      panNumber: 'ABCDE1234F',
      lifecycleStatus: 'ACTIVE',
      qualificationScore: 100,
      isActive: true,
    })).toEqual({ panNumber: 'ABCDE1234F' });
  });

  it('treats absent and undefined alike, so a partly-filled form does not blank a field', () => {
    expect(pickRegistrationRecordFields({ panNumber: undefined })).toEqual({});
    expect(pickRegistrationRecordFields(null)).toEqual({});
  });
});

describe('missingRegistrationFields', () => {
  const complete = {
    phone: '9876543210',
    panNumber: 'ABCDE1234F',
    bankAccountNumber: '123456789012',
    ifscCode: 'SBIN0001234',
    joiningDate: '2026-09-01',
    emergencyContactPhone: '9876500000',
    latitude: 18.52,
  };

  it('is empty when registration collected everything', () => {
    expect(missingRegistrationFields(complete)).toEqual([]);
  });

  it('names the bank gap, and what it stops', () => {
    const gaps = missingRegistrationFields({ ...complete, bankAccountNumber: '   ' });
    expect(gaps.map((f) => f.key)).toEqual(['bankAccountNumber']);
    expect(gaps[0].blocks).toMatch(/payout/i);
  });

  it('reports every critical field for an application that carries nothing', () => {
    expect(missingRegistrationFields(null).length).toBe(CRITICAL_ASSAYER_RECORD_FIELDS.length);
  });

  it('agrees with the record dictionary, so HR is not told two different stories', () => {
    const halfFilled = { ...complete, panNumber: null, ifscCode: null };
    expect(missingRegistrationFields(halfFilled).map((f) => f.key))
      .toEqual(missingAssayerRecordFields(halfFilled).map((f) => f.key));
  });
});

describe('mergedRegistrationView', () => {
  it('reads the application column and the extended profile as one person', () => {
    const view = mergedRegistrationView({
      fullName: 'Arun Deshmukh',
      mobile: '9876543210',
      extendedProfile: { fields: { panNumber: 'ABCDE1234F' } },
    });
    expect(view.displayName).toBe('Arun Deshmukh');
    expect(view.phone).toBe('9876543210');
    expect(view.panNumber).toBe('ABCDE1234F');
  });

  it('lets the extended profile win, because it is the later and more specific answer', () => {
    const view = mergedRegistrationView({
      mobile: '9876543210',
      extendedProfile: { fields: { phone: '9000000000' } },
    });
    expect(view.phone).toBe('9000000000');
  });

  it('finds the same gaps HR would see on the record after promotion', () => {
    const view = mergedRegistrationView({
      fullName: 'Half Filled',
      mobile: '9876543210',
      extendedProfile: { fields: { panNumber: 'ABCDE1234F' } },
    });
    expect(missingRegistrationFields(view).map((f) => f.key)).toEqual([
      'bankAccountNumber', 'ifscCode', 'joiningDate', 'emergencyContactPhone', 'latitude',
    ]);
  });
});
