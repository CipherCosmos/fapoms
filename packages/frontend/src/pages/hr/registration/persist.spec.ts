import { REGISTRATION_FIELDS } from './steps';
import { buildApplicationPatch, ratePayload, ratesChanged } from './persist';

// `services/api` pulls in the socket client, which reads `import.meta.env` and cannot be
// parsed by jest's CommonJS runtime. Mocked here purely to keep this pure module's tests pure —
// nothing below makes a request.
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));


/**
 * What actually reaches the API.
 *
 * This form writes a candidate's APPLICATION now, not a live roster row, so the rules changed with
 * the destination. The create body is gone — there is nothing to create, the application exists
 * because somebody passed an interview — and what is left is a patch that has to put every box in
 * the right one of the two places an application keeps things.
 *
 * Three rules are load-bearing and each has a failure behind it:
 *  - a key on the registration allow-list rides under `record` and reaches
 *    `extendedProfile.fields`; an application column goes at the top level. Put one in the other
 *    place and the server filters it out without complaint;
 *  - a patch must send only what moved, or step 5 rewrites the address step 2 wrote — and now,
 *    worse, can drop a field the CANDIDATE answered on their phone a moment ago, because
 *    `extended_profile` is one jsonb column written whole;
 *  - a pay rate is not a field on anybody. It rides as its own group.
 */

describe('saving a step onto the application', () => {
  const saved = { fullName: 'Ramesh Iyer', state: 'Kerala', address: '12 MG Road', panNumber: '' };

  it('sends only the boxes that moved', () => {
    const plan = buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, panNumber: 'ABCDE1234F' }, saved);
    expect(plan.body).toEqual({ record: { panNumber: 'ABCDE1234F' } });
    expect(plan.changedCount).toBe(1);
  });

  it('sends nothing at all when the clerk only looked', () => {
    expect(buildApplicationPatch(REGISTRATION_FIELDS, { ...saved }, saved).body).toBeNull();
  });

  /**
   * The split this whole function exists for. `address` and `state` are the application's own
   * columns; `panNumber` and `bankName` are on the registration allow-list and belong under
   * `record`, which the server folds into `extendedProfile.fields`. A box in the wrong half is
   * dropped silently — the filter is doing exactly what it should, to a value nobody meant to
   * send that way.
   */
  it('puts a column at the top level and an allow-list field under record', () => {
    const plan = buildApplicationPatch(REGISTRATION_FIELDS, {
      ...saved, city: 'Kochi', panNumber: 'ABCDE1234F', bankName: 'State Bank',
    }, saved);
    expect(plan.body).toEqual({
      city: 'Kochi',
      record: { panNumber: 'ABCDE1234F', bankName: 'State Bank' },
    });
  });

  /**
   * `phone` is on the allow-list, so it goes under `record` and NOT into the application's
   * `mobile` column. That column is the number the invite and the verification code are keyed to,
   * and it belongs to the candidate — `verifyOtp` writes it, because that is where it is proven.
   * The desk typing a contact number must not silently replace a confirmed one.
   */
  it('never writes the candidate’s own mobile column', () => {
    const plan = buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, phone: '9822014455' }, saved);
    expect(plan.body).toEqual({ record: { phone: '9822014455' } });
    expect(plan.body).not.toHaveProperty('mobile');
  });

  it('lets a box be emptied, which is the one edit the old form could not perform', () => {
    const plan = buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, address: '' }, saved);
    expect(plan.body).toEqual({ address: '' });
  });

  it('keeps a pay rate out of the field body — it rides as its own group', () => {
    const plan = buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, baseFee: '1500' }, saved);
    expect(plan.body).toBeNull();
  });

  /**
   * `experienceYears` is the one number among the application's own columns and its DTO declares
   * `@IsInt()`. An empty box means "not answered", and `""` would 400 the whole save.
   */
  it('sends a number as a number, and an unanswered one as nothing at all', () => {
    expect(buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, experienceYears: '7' }, saved).body)
      .toEqual({ experienceYears: 7 });
    expect(buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, experienceYears: '' }, saved).body)
      .toEqual({ experienceYears: undefined });
  });

  it('ignores a key the form does not define, however it arrives in state', () => {
    const plan = buildApplicationPatch(REGISTRATION_FIELDS, { ...saved, joiningDate: '2026-09-02' }, saved);
    expect(plan.body).toBeNull();
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
