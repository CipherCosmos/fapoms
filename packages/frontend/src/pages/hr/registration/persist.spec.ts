import { REGISTRATION_FIELDS } from './steps';
import {
  buildCreateBody, buildUpdatePlan, finaliseAssayerBody, ratePayload, ratesChanged,
} from './persist';

// `services/api` pulls in the socket client, which reads `import.meta.env` and cannot be
// parsed by jest's CommonJS runtime. Mocked here purely to keep this pure module's tests pure —
// nothing below makes a request.
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));


/**
 * What actually reaches the API.
 *
 * Three rules are load-bearing and each of them has a failure behind it:
 *  - a create must strip empties (`@IsEmail()` rejects `""`, `@IsNotEmpty()` rejects `""` on the
 *    assayer code, `@IsDateString()` rejects `null` on the joining date);
 *  - an update must send only what moved, or step 5 rewrites the address step 2 wrote;
 *  - a pay rate must never appear in the record body, because the global
 *    `forbidNonWhitelisted` pipe rejects the whole request rather than the stray field.
 */

const nothing = { workingHours: null, certifications: null };

describe('creating the record', () => {
  it('sends the three required fields and nothing that is blank', () => {
    const body = buildCreateBody(REGISTRATION_FIELDS, {
      firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala',
      assayerCode: '', email: '', phone: '', joiningDate: '', notes: '',
    });
    expect(body).toEqual({ firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala' });
  });

  it('keeps the defaults the step opens with, which a dirty diff would have dropped', () => {
    const body = buildCreateBody(REGISTRATION_FIELDS, {
      firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala',
      employmentType: 'FULL_TIME', joiningDate: '2026-09-02',
    });
    expect(body.employmentType).toBe('FULL_TIME');
    expect(String(body.joiningDate)).toContain('2026-09-02');
  });

  it('normalises a phone to the +91 form the rest of the system stores', () => {
    const body = buildCreateBody(REGISTRATION_FIELDS, {
      firstName: 'A', lastName: 'B', state: 'Kerala', phone: '9876543210',
    });
    expect(body.phone).toBe('+919876543210');
  });

  it('creates a person who has no phone at all', () => {
    const body = buildCreateBody(REGISTRATION_FIELDS, {
      firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala', phone: '', email: '',
    });
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('email');
  });

  it('sends the regions they will travel to as an array, not the JSON string the box holds', () => {
    const body = buildCreateBody(REGISTRATION_FIELDS, {
      firstName: 'A', lastName: 'B', state: 'Kerala',
      preferredRegions: JSON.stringify(['SOUTH', 'WEST']),
    });
    expect(body.preferredRegions).toEqual(['SOUTH', 'WEST']);
  });
});

describe('saving a step onto an existing record', () => {
  const saved = { firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala', address: '12 MG Road', panNumber: '' };

  it('sends only the boxes that moved', () => {
    const plan = buildUpdatePlan(REGISTRATION_FIELDS, { ...saved, panNumber: 'ABCDE1234F' }, saved, nothing);
    expect(plan.body).toEqual({ panNumber: 'ABCDE1234F' });
    expect(plan.changedCount).toBe(1);
  });

  it('sends nothing at all when the clerk only looked', () => {
    expect(buildUpdatePlan(REGISTRATION_FIELDS, { ...saved }, saved, nothing).body).toBeNull();
  });

  it('lets a box be emptied, which is the one edit the old form could not perform', () => {
    const plan = buildUpdatePlan(REGISTRATION_FIELDS, { ...saved, address: '' }, saved, nothing);
    expect(plan.body).toEqual({ address: '' });
  });

  it('keeps a pay rate out of the record body even though it shares the form', () => {
    const plan = buildUpdatePlan(REGISTRATION_FIELDS, { ...saved, baseFee: '1500' }, saved, nothing);
    expect(plan.body).toBeNull();
  });

  it('reports a half-entered working day rather than silently dropping the time typed', () => {
    const plan = buildUpdatePlan(REGISTRATION_FIELDS, { ...saved, workingHoursStart: '09:00' }, saved, nothing);
    expect(plan.body).toBeNull();
    expect(plan.problems[0]).toContain('end time');
  });
});

describe('the regions array', () => {
  it('parses the box, and leaves a cleared one as an empty array the API accepts', () => {
    expect(finaliseAssayerBody({ preferredRegions: '["NORTH"]' }).preferredRegions).toEqual(['NORTH']);
    expect(finaliseAssayerBody({ preferredRegions: '' }).preferredRegions).toEqual([]);
  });

  it('leaves a body without the field untouched', () => {
    expect(finaliseAssayerBody({ phone: '+919876543210' })).toEqual({ phone: '+919876543210' });
  });
});

describe('the pay card', () => {
  it('files nothing when no rate was agreed, rather than a profile of zeroes', () => {
    expect(ratePayload({ baseFee: '', dailyRate: '0' })).toBeNull();
  });

  it('sends every one of the six numbers, because each is @IsNotEmpty on the server', () => {
    const payload = ratePayload({ baseFee: '1500' });
    expect(payload).toMatchObject({
      baseFee: 1500, hourlyRate: 0, dailyRate: 0,
      travelReimbursement: 0, accommodationAllowance: 0, mealAllowance: 0, currency: 'INR',
    });
  });

  it('is not re-filed when nothing about it changed', () => {
    expect(ratesChanged({ baseFee: '1500' }, { baseFee: '1500' })).toBe(false);
    expect(ratesChanged({ baseFee: '1600' }, { baseFee: '1500' })).toBe(true);
  });
});
