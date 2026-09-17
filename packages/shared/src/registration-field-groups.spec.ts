import {
  REGISTRATION_RECORD_FIELD_KEYS, REGISTRATION_FIELD_GROUPS, groupRegistrationRecordFields,
  REGISTRATION_SECRET_FIELD_KEYS, isRegistrationSecretField, maskRegistrationFields, maskTail,
} from './index';

/**
 * Approval applies an application's fields to the new record one GROUP at a time, so a single
 * refused value costs its group instead of the whole payload. That only holds if every field the
 * application may carry is in exactly one group: a key in no group would silently never reach the
 * record, and a key in two would be applied twice.
 */
describe('the groups approval applies an application in', () => {
  it('puts every allowed field in exactly one group', () => {
    const grouped = REGISTRATION_FIELD_GROUPS.flatMap((g) => g.keys);
    for (const key of REGISTRATION_RECORD_FIELD_KEYS) {
      expect({ key, times: grouped.filter((k) => k === key).length }).toEqual({ key, times: 1 });
    }
    expect(new Set(grouped).size).toBe(REGISTRATION_RECORD_FIELD_KEYS.length);
  });

  /** Coordinates are only taken when both arrive, and the district is checked against the pincode. */
  it('keeps latitude, longitude and district together', () => {
    const location = REGISTRATION_FIELD_GROUPS.find((g) => g.keys.includes('latitude'));
    expect(location?.keys).toEqual(expect.arrayContaining(['latitude', 'longitude', 'district']));
  });

  /** Half a bank account is no more payable than none. */
  it('keeps the three things a payout needs together', () => {
    const bank = REGISTRATION_FIELD_GROUPS.find((g) => g.keys.includes('ifscCode'));
    expect(bank?.keys).toEqual(expect.arrayContaining(['bankAccountNumber', 'ifscCode', 'bankName']));
  });

  it('splits an application into groups and leaves out the empty ones', () => {
    const groups = groupRegistrationRecordFields({
      panNumber: 'ABCDE1234F',
      bankAccountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank',
    });
    expect(groups.map((g) => g.name)).toEqual(['identity', 'bank']);
    expect(groups[1].values).toEqual({ bankAccountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank' });
  });

  /** Grouping must never become a way around the allow-list. */
  it('drops a key the application is not allowed to set', () => {
    const groups = groupRegistrationRecordFields({ panNumber: 'ABCDE1234F', joiningDate: '2026-01-01', lifecycleStatus: 'ACTIVE' });
    expect(groups.flatMap((g) => Object.keys(g.values))).toEqual(['panNumber']);
  });
});

/**
 * The three numbers an application must never hold in the clear: the record encrypts them, and the
 * application held the same numbers as plain text, kept them after approval, and showed them whole
 * to every HR screen.
 */
describe('the identity numbers an application carries', () => {
  it('names exactly PAN, Aadhaar and the bank account', () => {
    expect([...REGISTRATION_SECRET_FIELD_KEYS].sort())
      .toEqual(['aadhaarNumber', 'bankAccountNumber', 'panNumber']);
  });

  it('only ever names fields an application is allowed to carry', () => {
    for (const key of REGISTRATION_SECRET_FIELD_KEYS) {
      expect(REGISTRATION_RECORD_FIELD_KEYS).toContain(key);
    }
  });

  /** An IFSC identifies a bank, not a person; masking it would only hide which bank it is. */
  it('does not treat the IFSC or the bank name as secret', () => {
    expect(isRegistrationSecretField('ifscCode')).toBe(false);
    expect(isRegistrationSecretField('bankName')).toBe(false);
    expect(isRegistrationSecretField('panNumber')).toBe(true);
  });

  it('masks every secret to its last four and leaves the rest alone', () => {
    const masked = maskRegistrationFields({
      panNumber: 'ABCDE1234F',
      aadhaarNumber: '234567890124',
      bankAccountNumber: '50100123456789',
      ifscCode: 'HDFC0001234',
      emergencyContactName: 'Sita',
    });
    expect(masked.panNumber).toBe(maskTail('ABCDE1234F'));
    expect(String(masked.panNumber)).not.toContain('ABCDE');
    expect(String(masked.aadhaarNumber)).not.toContain('23456789');
    expect(String(masked.bankAccountNumber)).not.toContain('5010012345');
    expect(masked.ifscCode).toBe('HDFC0001234');
    expect(masked.emergencyContactName).toBe('Sita');
  });

  it('has nothing to mask in an empty or absent set of answers', () => {
    expect(maskRegistrationFields(null)).toEqual({});
    expect(maskRegistrationFields({ panNumber: '' })).toEqual({ panNumber: '' });
  });
});
