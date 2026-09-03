import {
  REGISTRATION_FIELDS, RATE_KEYS, REGISTRATION_STEP_KEYS, STEP_FIELDS,
  activationGaps, firstIncompleteStep, stepOfField, validateStep,
} from './steps';

// `services/api` pulls in the socket client, which reads `import.meta.env` and cannot be
// parsed by jest's CommonJS runtime. Mocked here purely to keep this pure module's tests pure —
// nothing below makes a request.
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));


/**
 * The shape of the registration, pinned.
 *
 * These are the assertions that stop the flow quietly regressing into the form it replaced: that
 * only three boxes can ever block a step, that the fields the old create form simply did not have
 * are present, and that "what is still missing" is read from the same shared list every other HR
 * screen counts rather than a fourth private copy of it.
 */

const keysOnSomeStep = new Set(REGISTRATION_STEP_KEYS.flatMap((k) => [...STEP_FIELDS[k]]));

describe('what a step may refuse', () => {
  it('blocks only on the three the create API itself declares NOT NULL', () => {
    expect(validateStep('person', {})).toEqual([
      'a first name', 'a last name', 'the state they work in',
    ]);
  });

  it('lets a person with no phone, no email and no device through page one', () => {
    // The mission in one test: "every assayer doesn't have a smartphone, so HR should be able to
    // register them end to end from their side." A registration that asks for a mobile number
    // cannot do that, and the form this replaces made phone mandatory in its fast path while the
    // server treated it as optional — so the quick route was the one that could not enrol them.
    expect(validateStep('person', { firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala' })).toEqual([]);
  });

  it('never blocks any later step, however empty it is', () => {
    for (const step of REGISTRATION_STEP_KEYS.filter((s) => s !== 'person')) {
      expect(validateStep(step, {})).toEqual([]);
    }
  });
});

describe('the fields a registration offers', () => {
  it.each([
    'dateOfBirth', 'qualification', 'aadhaarNumber', 'vstsCode', 'bankName',
    'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
    'managerId', 'hrOwnerName', 'engagementType',
    'maxDailyWorkload', 'maxWeeklyWorkload', 'workingHoursStart', 'workingHoursEnd',
    'preferredRegions',
  ])('offers %s, which the old create form had no box for at all', (key) => {
    expect(REGISTRATION_FIELDS.some((f) => f.key === key) || keysOnSomeStep.has(key)).toBe(true);
    expect(keysOnSomeStep.has(key)).toBe(true);
  });

  it.each(['exitDate', 'terminationDate', 'unavailableReason', 'performanceRating'])(
    'does not ask a clerk enrolling somebody today about %s',
    (key) => {
      expect(REGISTRATION_FIELDS.some((f) => f.key === key)).toBe(false);
      expect(keysOnSomeStep.has(key)).toBe(false);
    },
  );

  it('keeps the pay rates out of the record field list, because the record PUT would 400 on them', () => {
    // `ValidationPipe({ forbidNonWhitelisted: true })` is global, and `UpdateAssayerRequestDto`
    // declares no rate — so one leaking into the record body rejects the whole save, not the field.
    for (const key of RATE_KEYS) {
      expect(REGISTRATION_FIELDS.some((f) => f.key === key)).toBe(false);
    }
  });

  it('marks the state mandatory here even though the record page leaves it optional', () => {
    expect(REGISTRATION_FIELDS.find((f) => f.key === 'state')?.required).toBe(true);
  });
});

describe('what is still missing, and where to fix it', () => {
  const bare = {
    id: 'a-1', firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala',
    phone: null, panNumber: null, bankAccountNumber: null, ifscCode: null,
    joiningDate: null, emergencyContactPhone: null, latitude: null,
  };

  it('names every critical gap and what it blocks', () => {
    const gaps = activationGaps(bare as never);
    expect(gaps.map((g) => g.key).sort()).toEqual([
      'bankAccountNumber', 'emergencyContactPhone', 'ifscCode', 'joiningDate',
      'latitude', 'panNumber', 'phone',
    ]);
    expect(gaps.find((g) => g.key === 'bankAccountNumber')?.why).toBe('payouts');
  });

  it('sends each gap to the step its box is actually on', () => {
    expect(stepOfField('panNumber')).toBe('identity');
    expect(stepOfField('emergencyContactPhone')).toBe('people');
    expect(stepOfField('phone')).toBe('person');
    // The coordinate has no box — it is placed with the map pin — so it still has to route
    // somewhere, or "Map location is missing" would be a dead end on the one screen that can fix it.
    expect(stepOfField('latitude')).toBe('address');
  });

  it('reports nothing missing on a complete record', () => {
    expect(activationGaps({
      ...bare, phone: '+919876543210', panNumber: 'ABCDE1234F', bankAccountNumber: '1234',
      ifscCode: 'HDFC0001234', joiningDate: '2026-01-01', emergencyContactPhone: '+919876543211',
      latitude: 10.1,
    } as never)).toEqual([]);
  });
});

describe('reopening an interrupted registration', () => {
  it('starts a brand-new registration at page one', () => {
    expect(firstIncompleteStep(null)).toBe('person');
  });

  it('reopens on the first page that still has a gap, not back at the beginning', () => {
    // Somebody whose name, phone and address are in but whose bank details are not should land on
    // the ID step. Sending them back to page one is how a resumed registration becomes a re-typed
    // one, which is how it stops being used.
    expect(firstIncompleteStep({
      firstName: 'Ramesh', lastName: 'Iyer', phone: '+919876543210', latitude: 10.1,
      panNumber: null, bankAccountNumber: null, ifscCode: null,
      joiningDate: '2026-01-01', emergencyContactPhone: '+919876543211',
    } as never)).toBe('identity');
  });

  it('lands on the summary when nothing critical is outstanding', () => {
    expect(firstIncompleteStep({
      phone: '+919876543210', panNumber: 'ABCDE1234F', bankAccountNumber: '1',
      ifscCode: 'HDFC0001234', joiningDate: '2026-01-01', emergencyContactPhone: '+919876543211',
      latitude: 10.1,
    } as never)).toBe('review');
  });
});
