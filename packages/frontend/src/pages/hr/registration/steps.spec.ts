import {
  EmpanelmentStatus, SELF_EDITABLE_ASSAYER_FIELDS, standingAllowsPlanning,
} from '@fapoms/shared';
import {
  REGISTRATION_FIELDS, RATE_KEYS, REGISTRATION_STEP_KEYS, STANDING_CHOICES, STEP_FIELDS,
  activationGaps, firstIncompleteStep, isPlannableForSomeone, stepOfField, validateStep,
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
    'hrOwnerName', 'engagementType', 'experienceYears',
    'maxDailyWorkload', 'maxWeeklyWorkload',
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

  it.each(['department', 'managerId', 'employeeId'])(
    'no longer asks for %s, which is blank on all 1,163 people and read by nothing',
    (key) => {
      // Not a tidy-up. The owner's own words: an assayer has one job, the audit, and which audit
      // they do is decided by planning — so a department picker is a question with no consequence.
      // The column and the record page's box both survive, so an imported value is still visible.
      expect(REGISTRATION_FIELDS.some((f) => f.key === key)).toBe(false);
      expect(keysOnSomeStep.has(key)).toBe(false);
    },
  );

  it.each([
    'skills', 'languages', 'certifications',
    'preferredRegions', 'workingHoursStart', 'workingHoursEnd',
  ])('no longer asks a clerk at the counter for %s', (key) => {
    expect(REGISTRATION_FIELDS.some((f) => f.key === key)).toBe(false);
    expect(keysOnSomeStep.has(key)).toBe(false);
  });

  it.each([
    // The box key and the record key differ for the hours: the form has two times, the column
    // holds the pair, and the self-service rule is written against the column.
    ['skills', 'skills'], ['languages', 'languages'],
    ['preferredRegions', 'preferredRegions'],
    ['workingHoursStart', 'workingHours'], ['workingHoursEnd', 'workingHours'],
  ])('drops %s because the assayer maintains it themselves and can overwrite it', (_box, recordKey) => {
    // Blank on all 1,163 people, which is what this arrangement looks like when it works: nobody
    // at a desk knows which hours somebody will take work in on the day they enrol, and whatever
    // was guessed is replaced the first time the person opens the app.
    expect(SELF_EDITABLE_ASSAYER_FIELDS).toContain(recordKey);
  });

  it('drops certifications because a comma-separated box cannot hold an expiry date', () => {
    // Not a self-editable field — this one moved for a different reason. A certificate is only
    // useful with the date it lapses on, `daysUntilExpiry` is what withholds work from somebody
    // whose licence has run out, and this box could only ever have filed a name with a blank
    // expiry. The record's Skills tab takes both.
    expect(SELF_EDITABLE_ASSAYER_FIELDS).not.toContain('certifications');
  });

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

/**
 * The gate the desk has to tell the truth about.
 *
 * `ClientEligibilityFilter` admits an ACTIVE or RECOMMENDED standing and nothing else, and
 * `planning.eligibility.noEmpanelmentRow` defaults to BLOCK — so somebody with no standing at all
 * is dropped from every client's planning run. These assertions exist because the copy on the
 * screen makes a promise about work being offered, and a copy of the rule that drifted from the
 * engine's would turn that promise into a lie a clerk cannot check.
 */
describe('who they can be given work for', () => {
  it('counts only the two standings the planner actually admits', () => {
    expect(standingAllowsPlanning(EmpanelmentStatus.ACTIVE)).toBe(true);
    expect(standingAllowsPlanning(EmpanelmentStatus.RECOMMENDED)).toBe(true);
    // The one that reads like progress and is not: papers outstanding excludes exactly as hard
    // as a refusal does, and a clerk told otherwise files it and believes the job is done.
    expect(standingAllowsPlanning(EmpanelmentStatus.DOCUMENTS_PENDING)).toBe(false);
    expect(standingAllowsPlanning(EmpanelmentStatus.INACTIVE)).toBe(false);
    expect(standingAllowsPlanning(EmpanelmentStatus.NOT_RECOMMENDED)).toBe(false);
    expect(standingAllowsPlanning(null)).toBe(false);
  });

  it('says a person with no standing anywhere cannot be given work', () => {
    // The 245-of-548 case: a complete, ACTIVE record that no planning run will ever surface.
    expect(isPlannableForSomeone([])).toBe(false);
    expect(isPlannableForSomeone(null)).toBe(false);
    expect(isPlannableForSomeone([{ clientId: 'c1', status: EmpanelmentStatus.DOCUMENTS_PENDING }])).toBe(false);
  });

  it('needs only one client to say yes', () => {
    expect(isPlannableForSomeone([
      { clientId: 'c1', status: EmpanelmentStatus.NOT_RECOMMENDED },
      { clientId: 'c2', status: EmpanelmentStatus.RECOMMENDED },
    ])).toBe(true);
  });

  it('offers only standings a person being enrolled today could actually be in', () => {
    const offered = STANDING_CHOICES.map((c) => c.value);
    // Resigned, terminated and dormant all describe an empanelment that has ended, which cannot
    // be true of somebody joining today — the same argument that keeps `exitDate` off the form.
    expect(offered).not.toContain(EmpanelmentStatus.RESIGNED);
    expect(offered).not.toContain(EmpanelmentStatus.TERMINATED);
    expect(offered).not.toContain(EmpanelmentStatus.INACTIVE);
  });

  it('labels every choice without showing anybody an enum name', () => {
    for (const choice of STANDING_CHOICES) {
      expect(choice.label).not.toMatch(/_|^[A-Z]+$/);
      expect(choice.consequence.length).toBeGreaterThan(0);
      expect(choice.plannable).toBe(standingAllowsPlanning(choice.value));
    }
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
