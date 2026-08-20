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
});
