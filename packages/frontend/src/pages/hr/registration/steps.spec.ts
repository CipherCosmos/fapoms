import {
  EmpanelmentStatus, SELF_EDITABLE_ASSAYER_FIELDS, standingAllowsPlanning,
} from '@fapoms/shared';
import {
  REGISTRATION_FIELDS, RATE_KEYS, REGISTRATION_STEP_KEYS, STANDING_CHOICES, STEP_FIELDS,
  activationGaps, firstIncompleteStep, isPlannableForSomeone, mappedFieldsFromError, stepOfField,
  validateStep,
} from './steps';
import { fromResponse } from '../../../services/errors';

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
  it('blocks only on the two the create API itself declares NOT NULL', () => {
    // Was three problems — one each for a first and a last name. The server now takes a single
    // `fullName` and derives the legacy pair itself, so there is one name to be missing, and the
    // message it is missing with matches the server's own 400 rather than a Western-shaped pair.
    expect(validateStep('person', {})).toEqual([
      'their full name — exactly as printed on their Aadhaar or PAN', 'the state they work in',
    ]);
  });

  it('lets a person with no phone, no email and no device through page one', () => {
    // The mission in one test: "every assayer doesn't have a smartphone, so HR should be able to
    // register them end to end from their side." A registration that asks for a mobile number
    // cannot do that, and the form this replaces made phone mandatory in its fast path while the
    // server treated it as optional — so the quick route was the one that could not enrol them.
    expect(validateStep('person', { fullName: 'Ramesh Iyer', state: 'Kerala' })).toEqual([]);
  });

  it('accepts a single-token name — the roster is full of people with only one', () => {
    // "First Name" + "Last Name" was the Western assumption this field replaced. A name is not a
    // PAN: there is no format to police, and a name with nothing to put in a second box is not an
    // incomplete one.
    expect(validateStep('person', { fullName: 'Kumaran', state: 'Tamil Nadu' })).toEqual([]);
  });

  it('never blocks any later step, however empty it is', () => {
    for (const step of REGISTRATION_STEP_KEYS.filter((s) => s !== 'person')) {
      expect(validateStep(step, {})).toEqual([]);
    }
  });
});

describe('the fields a registration offers', () => {
  it.each([
    'dateOfBirth', 'qualification', 'aadhaarNumber', 'bankName',
    'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
    'experienceYears',
    // The four the application has and the record does not — the spec's Personal and Professional
    // Details, which the candidate's own form has always asked for and this one could not.
    'gender', 'currentEmployer', 'expertise', 'availability',
    // And the one that decides which documents they are asked for. `submit()` refuses without it.
    'employmentCategory',
  ])('offers %s, which the old create form had no box for at all', (key) => {
    expect(REGISTRATION_FIELDS.some((f) => f.key === key) || keysOnSomeStep.has(key)).toBe(true);
    expect(keysOnSomeStep.has(key)).toBe(true);
  });

  /**
   * What moved, and where it went.
   *
   * This form writes an application now, not a roster row. An employment term is not a candidate
   * answer — a joining date is an employment decision, a workload ceiling is a scheduling policy,
   * a reporting line is an org chart — so all of them are asked for at APPROVAL instead, where
   * somebody with the authority to hire is looking at the person. `assayerCode` is minted when the
   * record is created, so there was never anything to type; `vstsCode`, `employeeCode` and `notes`
   * have no application equivalent and stay on the record page.
   *
   * Every one of these used to be on this form, so they are named rather than merely absent: a
   * question that quietly stops being asked is indistinguishable from one nobody thought of.
   */
  it.each([
    'joiningDate', 'employmentType', 'engagementType', 'region', 'hrOwnerName',
    'maxDailyWorkload', 'maxWeeklyWorkload',
    'assayerCode', 'vstsCode', 'employeeCode', 'notes',
  ])('no longer asks for %s — an application cannot hold it', (key) => {
    expect(REGISTRATION_FIELDS.some((f) => f.key === key)).toBe(false);
    expect(keysOnSomeStep.has(key)).toBe(false);
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

  it('offers one full-name field instead of the old First/Last pair', () => {
    expect(REGISTRATION_FIELDS.some((f) => f.key === 'fullName')).toBe(true);
    expect(REGISTRATION_FIELDS.some((f) => f.key === 'firstName' || f.key === 'lastName')).toBe(false);
    expect(keysOnSomeStep.has('fullName')).toBe(true);
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

/**
 * "Go to field", and the two ways it can know which field.
 *
 * The banner shows the server's sentence and offers a jump to each box it named. Where those names
 * come from changed: `AppError` keeps the property off each class-validator message now, so the
 * keys are read directly. The prose parsing underneath stays, because it is what a locally-composed
 * problem sentence and an older server still go through — and because it is the half that breaks
 * silently, being a text match against a message nobody here controls.
 */
describe('mappedFieldsFromError', () => {
  const validation = (messages: string[]) => fromResponse(400, { message: messages });

  it('places every box a validation failure named, from the keys it kept', () => {
    const err = validation([
      'panNumber must match /^[A-Z]{5}[0-9]{4}[A-Z]$/',
      'ifscCode must match /^[A-Z]{4}0[A-Z0-9]{6}$/',
    ]);
    const mapped = mappedFieldsFromError(err.userMessage, err.fields);
    expect(mapped.map((f) => f.key)).toEqual(['panNumber', 'ifscCode']);
    // Each jump has to land somewhere: a key with no step is dropped, never guessed at.
    expect(mapped.every((f) => REGISTRATION_STEP_KEYS.includes(f.step))).toBe(true);
    expect(mapped.map((f) => f.label)).not.toContain('panNumber');
  });

  /**
   * The half that has to keep working when the keys are not there, exercised with the exact
   * sentence `joinServerMessage` produces — including its new spaced field names, which one
   * whitespace token is no longer enough to recognise.
   */
  it('recovers them from the banner sentence alone when no keys came with it', () => {
    const err = validation(['panNumber should not be empty', 'bankName should not be empty']);
    expect(mappedFieldsFromError(err.userMessage, []).map((f) => f.key))
      .toEqual(['panNumber', 'bankName']);
  });

  it('reads a single-field failure, which never goes through that sentence at all', () => {
    const err = validation(['aadhaarNumber must be a valid Aadhaar number']);
    expect(mappedFieldsFromError(err.userMessage, []).map((f) => f.key)).toEqual(['aadhaarNumber']);
  });

  it('takes the longest matching label, so "Bank Name" is not read as "Bank"', () => {
    const mapped = mappedFieldsFromError('Bank Name should not be empty.', []);
    expect(mapped.map((f) => f.key)).toEqual(['bankName']);
  });

  it('offers nothing rather than a guess, for a message about no box in this flow', () => {
    expect(mappedFieldsFromError('Someone else changed this record while you were editing.', []))
      .toEqual([]);
    expect(mappedFieldsFromError('', [])).toEqual([]);
  });

  it('names a box once, however many of its rules failed', () => {
    const err = validation([
      'panNumber should not be empty',
      'panNumber must match /^[A-Z]{5}[0-9]{4}[A-Z]$/',
    ]);
    expect(mappedFieldsFromError(err.userMessage, err.fields).map((f) => f.key)).toEqual(['panNumber']);
  });
});
