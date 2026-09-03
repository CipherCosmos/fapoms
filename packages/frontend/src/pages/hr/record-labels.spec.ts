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
      joiningDate: '2024-01-01', emergencyContactPhone: '+919000000000', latitude: 19.076,
    };
    expect(missingCriticalFields(noPhone as any).map((f) => f.key)).toEqual(['phone']);
  });

  /**
   * The gap that was invisible on every screen.
   *
   * Coordinates were never in the record-fields list, so nothing counted them and nothing
   * flagged them — while the planner's distance check quietly passes any candidate whose
   * coordinates are missing, rather than excluding them. 1,155 of 1,163 imported records had
   * none. It is a critical field on both sides now, and this is the screen's half of that.
   */
  it('flags a record with no map location', () => {
    const noCoordinates = {
      phone: '+919000000000', panNumber: 'ABCDE1234F', bankAccountNumber: '123',
      ifscCode: 'HDFC0000123', joiningDate: '2024-01-01', emergencyContactPhone: '+919000000001',
    };
    expect(missingCriticalFields(noCoordinates as any).map((f) => f.key)).toEqual(['latitude']);
  });

  /**
   * The screens print this after the word "blocks", so an ordinary word is de-capitalised — but
   * an acronym is a name, not a first letter.
   *
   * This test used to require a lower-case first character of EVERY reason, which is the rule
   * that produced "blocks tDS deduction and statutory filing" on the record summary and the
   * roster drawer. The assertion was not catching the defect; it was the reason the defect
   * survived four rewrites of the code around it.
   */
  it('gives each field a reason a person can read, with acronyms left intact', () => {
    for (const f of CRITICAL_FIELDS) {
      expect(f.why.length).toBeGreaterThan(0);
      const startsWithAcronym = /^[A-Z]{2}/.test(f.why);
      if (!startsWithAcronym) expect(f.why[0]).toBe(f.why[0].toLowerCase());
    }
  });

  it('never mangles TDS into tDS, on either route to the reason', () => {
    const tds = CRITICAL_FIELDS.find((f) => /TDS/i.test(f.why));
    // If this ever goes undefined the shared list stopped naming TDS and the guard is dead.
    expect(tds).toBeDefined();
    expect(tds!.why).toMatch(/^TDS/);

    // `missingCriticalFields` builds the same sentence by a second path; both must agree.
    const missing = missingCriticalFields({} as any).find((f) => f.key === tds!.key);
    expect(missing!.why).toBe(tds!.why);
  });
});

/*
  The attrition-rate block that used to sit here has moved to hr-attrition.spec.tsx, and was
  rewritten on the way rather than relocated.

  It declared a local helper that applied the attrition formula and then asserted that helper
  against the same formula — one assertion was the identical expression on both sides. It imported
  neither the screens nor the service, so a change of denominator on either side would have left
  it green, while its docblock claimed to pin "the denominator is sent now rather than guessed at
  by the screen". The replacement renders the two screens that print the percentage. It also does
  not belong in a file about field labels, which is half of why nobody noticed.
*/
