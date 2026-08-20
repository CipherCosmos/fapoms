import { FIELD_LABELS, CRITICAL_FIELDS, missingCriticalFields } from './assayer-shared';
import { ASSAYER_RECORD_FIELDS, CRITICAL_ASSAYER_RECORD_FIELDS } from '@fapoms/shared';

/**
 * Workforce says the same thing on every screen.
 *
 * "Which fields does a record need" was written down three times: `CRITICAL_FIELDS` here,
 * `RECORD_FIELDS` in the HR service's SQL, and `FIELD_LABELS` for the words on the paperwork
 * page. They disagreed in two ways at once. The first two differed on the phone number, so the
 * roster's "Incomplete record" filter and the paperwork page's incomplete list named different
 * people — and precisely on the common case, because the client rosters this system imports
 * arrive with no phone column at all. The third covered five of the eleven columns, so any
 * field outside those five printed its raw database name at an HR clerk.
 */
describe('the workforce record, across screens', () => {
  it('labels every field the server can report as missing', () => {
    for (const field of ASSAYER_RECORD_FIELDS) {
      expect(FIELD_LABELS[field.column]).toBe(field.label);
    }
  });

  it('never leaves a column to print its own database name', () => {
    for (const column of Object.keys(FIELD_LABELS)) {
      expect(FIELD_LABELS[column]).not.toMatch(/_/);
    }
  });

  it('asks for the same critical fields the server counts', () => {
    expect(CRITICAL_FIELDS.map((f) => f.key).sort())
      .toEqual(CRITICAL_ASSAYER_RECORD_FIELDS.map((f) => f.key).sort());
  });

  it('flags a record with no phone, which the two lists used to disagree about', () => {
    const noPhone = {
      phone: '', panNumber: 'ABCDE1234F', bankAccountNumber: '123', ifscCode: 'HDFC0000123',
      joiningDate: '2024-01-01', emergencyContactPhone: '+919000000000',
    };
    expect(missingCriticalFields(noPhone as any).map((f) => f.key)).toEqual(['phone']);
  });

  it('gives each field a reason a person can read', () => {
    for (const f of CRITICAL_FIELDS) {
      expect(f.why.length).toBeGreaterThan(0);
      // Sentence-cased in the shared list, lower-cased where the screen says "blocks …".
      expect(f.why[0]).toBe(f.why[0].toLowerCase());
    }
  });
});
