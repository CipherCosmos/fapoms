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

  it('gives each field a reason a person can read', () => {
    for (const f of CRITICAL_FIELDS) {
      expect(f.why.length).toBeGreaterThan(0);
      // Sentence-cased in the shared list, lower-cased where the screen says "blocks …".
      expect(f.why[0]).toBe(f.why[0].toLowerCase());
    }
  });
});

/**
 * The attrition tile explains itself with the numbers it used.
 *
 * The percentage is `exits / (still on the roster + exits)` — you cannot leave a population you
 * were never in. The hover used to quote `headcount.total` instead, which counts every live
 * record including people who left before the window, so a tile reading 25% was explained
 * underneath by two numbers that work out to 20%. The denominator is sent now rather than
 * guessed at by the screen.
 */
describe('the attrition rate', () => {
  const rate = (exits12m: number, onRoster: number) => ({
    attritionRate12m: onRoster ? Math.round((exits12m / (onRoster + exits12m)) * 1000) / 10 : 0,
    averageHeadcount12m: onRoster + exits12m,
    exits12m,
  });

  it('divides by the population it names', () => {
    const a = rate(2, 6);
    expect(a.averageHeadcount12m).toBe(8);
    expect(a.attritionRate12m).toBe(25);
    // The hover's own arithmetic has to land on the tile's number.
    expect(Math.round((a.exits12m / a.averageHeadcount12m) * 1000) / 10).toBe(a.attritionRate12m);
  });

  it('holds for a roster with no leavers', () => {
    const a = rate(0, 8);
    expect(a.attritionRate12m).toBe(0);
    expect(a.averageHeadcount12m).toBe(8);
  });

  it('reports zero rather than dividing by nothing when the roster is empty', () => {
    expect(rate(0, 0).attritionRate12m).toBe(0);
  });
});
