import { canonicalStateName } from './regions';
import { canonicalState } from './utils';

/**
 * Three state-name canonicalisers used to disagree: `regions.ts:canonicalStateName` (full
 * coverage, proper-case, e.g. "Jammu & Kashmir") and `utils.ts:canonicalState` (a 13-entry
 * abbreviation table — AP/TS/TN/KL/KA/MH/OD/RJ/UP/PY/DL/GJ/WB — upper-case) each recognised
 * spellings the other did not. `pincode.ts` had to chain both together to cover the roster at
 * all (see its own history in `pincode.ts`'s `stateForms`).
 *
 * `canonicalState` is now a thin wrapper over the (extended) `canonicalStateName`, so this file
 * asserts the two things that consolidation promises:
 *   1. Every spelling either function used to accept still resolves, through the single table.
 *   2. The two functions never disagree about WHICH state a spelling names — only about casing.
 */
describe('state canonicalisation, consolidated', () => {
  /**
   * Every key `utils.ts:canonicalState`'s old `STATE_ALIASES` table carried by hand, mapped to
   * the state it named. `canonicalStateName` did not resolve the short codes on the left before
   * this consolidation (it had no abbreviation lookup at all) — this table is what pins that
   * regression down: delete `STATE_ABBREVIATIONS` from `canonicalStateName`, or stop consulting
   * it there, and the short-code rows below start failing.
   */
  const OLD_UTILS_ALIASES: Array<[string, string]> = [
    ['AP', 'Andhra Pradesh'], ['A P', 'Andhra Pradesh'], ['ANDRAPRADESH', 'Andhra Pradesh'],
    ['ANDHRAPRADESH', 'Andhra Pradesh'], ['ANDHRA PRADESH', 'Andhra Pradesh'],
    ['TS', 'Telangana'], ['TELANGANA', 'Telangana'],
    ['TN', 'Tamil Nadu'], ['TAMILNADU', 'Tamil Nadu'], ['TAMIL NADU', 'Tamil Nadu'],
    ['KL', 'Kerala'], ['KERALA', 'Kerala'],
    ['KA', 'Karnataka'], ['KARNATAKA', 'Karnataka'],
    ['MH', 'Maharashtra'], ['MAHARASHTRA', 'Maharashtra'],
    ['OD', 'Odisha'], ['ORISSA', 'Odisha'], ['ODISHA', 'Odisha'],
    ['RJ', 'Rajasthan'], ['RAJASTHAN', 'Rajasthan'],
    ['UP', 'Uttar Pradesh'], ['UTTARPRADESH', 'Uttar Pradesh'], ['UTTAR PRADESH', 'Uttar Pradesh'],
    ['PY', 'Puducherry'], ['PONDICHERRY', 'Puducherry'], ['PUDUCHERRY', 'Puducherry'],
    ['DL', 'Delhi'], ['NEW DELHI', 'Delhi'], ['DELHI', 'Delhi'],
    ['GJ', 'Gujarat'], ['GUJARAT', 'Gujarat'],
    ['WB', 'West Bengal'], ['WEST BENGAL', 'West Bengal'],
  ];

  /**
   * The abbreviations `regions.ts:canonicalStateName` already recognised through
   * `STATE_ABBREVIATIONS` before this consolidation (used only by `resolveRegion` until now).
   * Lower-case here because that table's keys are post-normalisation; the assertions below feed
   * them through both cases to prove the public functions are case-insensitive either way.
   */
  const OLD_REGIONS_ABBREVIATIONS: Array<[string, string]> = [
    ['AP', 'Andhra Pradesh'], ['MP', 'Madhya Pradesh'], ['UP', 'Uttar Pradesh'],
    ['CG', 'Chhattisgarh'], ['HP', 'Himachal Pradesh'], ['WB', 'West Bengal'],
    ['TN', 'Tamil Nadu'], ['JK', 'Jammu & Kashmir'],
  ];

  it.each(OLD_UTILS_ALIASES)(
    'canonicalStateName now resolves %s (previously utils-only) to %s',
    (input, expected) => {
      expect(canonicalStateName(input)).toBe(expected);
    },
  );

  it.each(OLD_UTILS_ALIASES)(
    'canonicalState still resolves %s, upper-cased, via the shared table',
    (input, expected) => {
      expect(canonicalState(input)).toBe(expected.toUpperCase());
    },
  );

  it.each(OLD_REGIONS_ABBREVIATIONS)(
    'canonicalStateName keeps resolving the abbreviation %s to %s',
    (input, expected) => {
      expect(canonicalStateName(input)).toBe(expected);
      expect(canonicalStateName(input.toLowerCase())).toBe(expected);
    },
  );

  it.each(OLD_REGIONS_ABBREVIATIONS)(
    'canonicalState agrees with canonicalStateName on the abbreviation %s',
    (input) => {
      expect(canonicalState(input)).toBe(canonicalStateName(input)!.toUpperCase());
    },
  );

  it('canonicalState recovers a misspelling canonicalStateName\'s fuzzy match catches, which the old alias table never could', () => {
    // "Gujrat" cost 4 real rows on import. The old STATE_ALIASES table had no entry for it — an
    // exact key lookup, nothing more — so canonicalState('Gujrat') used to return the raw
    // stripped input, 'GUJRAT', not the corrected state.
    expect(canonicalState('Gujrat')).toBe('GUJARAT');
    expect(canonicalStateName('Gujrat')).toBe('Gujarat');
  });

  it('the two functions never disagree about which state a spelling names', () => {
    const allInputs = [
      ...OLD_UTILS_ALIASES.map(([input]) => input),
      ...OLD_REGIONS_ABBREVIATIONS.map(([input]) => input),
      'Gujrat', 'Kerela', 'M.P', 'A.P', 'U.P', 'J&K', 'Jammu and Kashmir', 'ANDRAPRADESH',
    ];
    for (const input of allInputs) {
      const viaRegions = canonicalStateName(input);
      const viaUtils = canonicalState(input);
      expect(viaRegions).not.toBeNull();
      expect(viaUtils).toBe(viaRegions!.toUpperCase());
    }
  });

  it('still falls back to the cleaned raw value, never null, for a genuinely unknown state', () => {
    expect(canonicalState('NARNIA')).toBe('NARNIA');
    expect(canonicalState(null)).toBe('UNKNOWN');
    expect(canonicalState('')).toBe('UNKNOWN');
  });
});
