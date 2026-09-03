import { buildAssayerEditBody } from './assayer-shared';

/**
 * What the edit form sends when a box is emptied.
 *
 * The form used to skip every field whose value was `''`. So clearing a phone number, an
 * address, a note or the last skill in a list sent nothing at all: the request succeeded, the
 * drawer closed, the roster refreshed, and the old value was still there. Deleting a value was
 * the one edit this form could not make, and it reported success every time — which is what
 * "the changes don't get saved" looked like from the outside.
 *
 * The empty each field takes was checked against the running API: a date column stores null, a
 * list stores `[]`, text stores `''`, and null on any of the four NOT NULL numeric columns is a
 * Postgres constraint violation that surfaces as a bare 500.
 */
describe('the assayer edit body', () => {
  const current = { workingHours: null, certifications: [] };
  const build = (fields: any[], form: Record<string, string | undefined>, cur: any = current) =>
    buildAssayerEditBody(fields, form, cur).body;
  const problemsFrom = (fields: any[], form: Record<string, string | undefined>, cur: any = current) =>
    buildAssayerEditBody(fields, form, cur).problems;

  describe('a box the operator emptied', () => {
    it('sends text as an empty string rather than omitting it', () => {
      const body = build([{ key: 'emergencyContactName' }], { emergencyContactName: '' });
      expect(body).toHaveProperty('emergencyContactName', '');
    });

    it('sends a cleared date as null', () => {
      const body = build([{ key: 'exitDate', type: 'date' }], { exitDate: '' });
      expect(body).toHaveProperty('exitDate', null);
    });

    it('sends an emptied list as an empty array, so the last skill can be removed', () => {
      const body = build([{ key: 'skills', vocab: 'skills' }], { skills: '' });
      expect(body).toHaveProperty('skills', []);
    });

    it('sends emptied certifications as an empty array', () => {
      const body = build([{ key: 'certifications', vocab: 'certifications' }], { certifications: '' });
      expect(body).toHaveProperty('certifications', []);
    });

    it.each(['experienceYears', 'performanceRating', 'maxDailyWorkload', 'maxWeeklyWorkload'])(
      'leaves %s alone, because the column is NOT NULL and has no empty',
      (key) => {
        const body = build([{ key, type: 'number' }], { [key]: '' });
        expect(body).not.toHaveProperty(key);
      },
    );
  });

  describe('a box the operator filled in', () => {
    it('keeps text as typed', () => {
      expect(build([{ key: 'city' }], { city: 'Nashik' })).toEqual({ city: 'Nashik' });
    });

    it('normalises a phone to +91, matching what the create form stores', () => {
      expect(build([{ key: 'phone' }], { phone: '9876543216' })).toEqual({ phone: '+919876543216' });
      expect(build([{ key: 'phone' }], { phone: '+91 98765 43216' })).toEqual({ phone: '+919876543216' });
    });

    it('sends a number as a number, not the string from the input', () => {
      expect(build([{ key: 'experienceYears', type: 'number' }], { experienceYears: '5' }))
        .toEqual({ experienceYears: 5 });
    });

    it('keeps the expiry already recorded against a certification it is re-sending', () => {
      const body = build(
        [{ key: 'certifications', vocab: 'certifications' }],
        { certifications: JSON.stringify(['Certified Gold Assayer']) },
        { workingHours: null, certifications: [{ name: 'Certified Gold Assayer', expiryDate: '2028-12-31' }] },
      );
      expect(body.certifications).toEqual([{ name: 'Certified Gold Assayer', expiryDate: '2028-12-31' }]);
    });

    it('sends both ends of the working day together', () => {
      const body = build(
        [{ key: 'workingHoursStart' }, { key: 'workingHoursEnd' }],
        { workingHoursStart: '09:00', workingHoursEnd: '18:00' },
      );
      expect(body.workingHours).toEqual({ start: '09:00', end: '18:00' });
    });

    it('keeps the end already recorded when only the start is being changed', () => {
      const body = build(
        [{ key: 'workingHoursStart' }, { key: 'workingHoursEnd' }],
        { workingHoursStart: '10:00', workingHoursEnd: undefined },
        { workingHours: { start: '09:00', end: '18:00' }, certifications: [] },
      );
      expect(body.workingHours).toEqual({ start: '10:00', end: '18:00' });
    });
  });

  /**
   * The working day is a pair the server will only store complete.
   *
   * Sending `{ start: '', end: '' }` is a 400 — which is what an assayer with no hours recorded
   * produced on every save the moment emptied fields started being sent at all. Both empty is
   * null; one empty is the operator's mistake and is named, rather than dropped or nulled.
   */
  describe('the working day', () => {
    const hourFields = [{ key: 'workingHoursStart' }, { key: 'workingHoursEnd' }];

    it('clears the pair when both boxes are empty, rather than failing validation', () => {
      const body = build(hourFields, { workingHoursStart: '', workingHoursEnd: '' });
      expect(body.workingHours).toBeNull();
      expect(problemsFrom(hourFields, { workingHoursStart: '', workingHoursEnd: '' })).toEqual([]);
    });

    it('never sends an empty string, which the server rejects as a malformed time', () => {
      const body = build(hourFields, { workingHoursStart: '', workingHoursEnd: '' });
      expect(JSON.stringify(body)).not.toContain('""');
    });

    it('says which box is missing when only one end is filled in', () => {
      expect(problemsFrom(hourFields, { workingHoursStart: '09:00', workingHoursEnd: '' }))
        .toEqual(['Working hours need an end time as well as a start.']);
      expect(problemsFrom(hourFields, { workingHoursStart: '', workingHoursEnd: '18:00' }))
        .toEqual(['Working hours need a start time as well as an end.']);
    });

    it('does not send a half a range', () => {
      const body = build(hourFields, { workingHoursStart: '09:00', workingHoursEnd: '' });
      expect(body).not.toHaveProperty('workingHours');
    });

    it('leaves the pair alone when the form is not editing it', () => {
      const body = build([{ key: 'city' }], { city: 'Nashik' });
      expect(body).not.toHaveProperty('workingHours');
    });
  });

  it('says nothing about a field the form never showed', () => {
    // `undefined` is "not on this form", which is different from "the operator cleared it".
    expect(build([{ key: 'notes' }], { notes: undefined })).toEqual({});
  });

  /**
   * A masked identifier must never be written over the real one.
   *
   * `GET /assayers/:id` returns the PAN, the Aadhaar and the bank account last-4 masked, and the
   * server refuses any write carrying an asterisk. Saving one would replace a real KYC identifier
   * with something that looks plausible on every screen afterwards — data loss with no symptom.
   *
   * The two masked cases are not the same and must not be treated alike, which is what these
   * pin. A mask identical to what the record holds is a field nobody touched: refusing it would
   * fail an unrelated save on a field the clerk never went near. A mask that differs is somebody
   * typing on top of one, and that is refused in words that say what to do about it.
   */
  describe('a masked identifier', () => {
    const onFile = { workingHours: null, certifications: [], panNumber: '******234F' };
    const pan = [{ key: 'panNumber', label: 'PAN Number' }];

    it('is dropped, not refused, when it is exactly what the record already holds', () => {
      const out = buildAssayerEditBody(pan, { panNumber: '******234F' }, onFile as any);
      expect(out.body).not.toHaveProperty('panNumber');
      expect(out.problems).toEqual([]);
    });

    it('lets an unrelated edit through in the same save', () => {
      const out = buildAssayerEditBody(
        [...pan, { key: 'city' }],
        { panNumber: '******234F', city: 'Nashik' },
        onFile as any,
      );
      expect(out.body).toEqual({ city: 'Nashik' });
      expect(out.problems).toEqual([]);
    });

    it('is refused, by name, when somebody has typed on top of it', () => {
      const out = buildAssayerEditBody(pan, { panNumber: '******234G' }, onFile as any);
      expect(out.body).not.toHaveProperty('panNumber');
      expect(out.problems).toHaveLength(1);
      expect(out.problems[0]).toContain('pan number');
      expect(out.problems[0]).toContain('Show it in full first');
    });

    it('lets a real revealed value through untouched', () => {
      const out = buildAssayerEditBody(pan, { panNumber: 'ABCDE1234F' }, onFile as any);
      expect(out.body).toEqual({ panNumber: 'ABCDE1234F' });
      expect(out.problems).toEqual([]);
    });

    it('still lets the field be cleared', () => {
      // Emptying a box is a deliberate act and has nothing to do with masking.
      const out = buildAssayerEditBody(pan, { panNumber: '' }, onFile as any);
      expect(out.body).toEqual({ panNumber: '' });
      expect(out.problems).toEqual([]);
    });

    /**
     * A short value's mask is still a mask.
     *
     * `maskTail` keeps the last four characters, so a five- or six-character bank account comes
     * back as `*2345` or `**3456` — one or two stars, not a run of them. This side used to want
     * three before it called something a mask, so those two went out with the save, the server
     * refused them, and the clerk was shown a 400 naming a field they never opened. Both ends read
     * one function now; this is the case that told them apart.
     */
    it('drops the mask of a short value, which used to be sent and refused', () => {
      const short = { workingHours: null, certifications: [], bankAccountNumber: '*2345' };
      const account = [{ key: 'bankAccountNumber', label: 'Bank Account' }];

      const out = buildAssayerEditBody(account, { bankAccountNumber: '*2345' }, short as any);

      expect(out.body).not.toHaveProperty('bankAccountNumber');
      expect(out.problems).toEqual([]);
    });

    it('refuses a short mask somebody has typed on top of', () => {
      const short = { workingHours: null, certifications: [], bankAccountNumber: '**3456' };
      const out = buildAssayerEditBody(
        [{ key: 'bankAccountNumber', label: 'Bank Account' }],
        { bankAccountNumber: '**3457' },
        short as any,
      );
      expect(out.body).not.toHaveProperty('bankAccountNumber');
      expect(out.problems[0]).toContain('Show it in full first');
    });

    it('never mistakes a real identifier for a mask', () => {
      // The test is a run of mask characters. Nothing in a PAN, an Aadhaar or an account number
      // is one — an earlier version of this also matched a run of the letter x, which a fake-
      // looking but legitimate value could carry.
      for (const real of ['ABCDE1234F', 'XXXXX1234X', '000111222333', '123456789012', 'HDFC0000001']) {
        const out = buildAssayerEditBody(
          [{ key: 'bankAccountNumber', label: 'Bank Account' }],
          { bankAccountNumber: real },
          onFile as any,
        );
        expect(out.problems).toEqual([]);
        expect(out.body).toHaveProperty('bankAccountNumber', real);
      }
    });
  });
});
