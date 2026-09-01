import { canonicalStateName, resolveRegion } from '@fapoms/shared';

/**
 * Misspelled states in branch imports.
 *
 * A real import of 3,759 branches lost 4 rows to "Gujrat". The fix is deliberately NOT another
 * alias entry: there is no finite list of misspellings to write, and every hardcoded variant is
 * one that had to fail in production first to be found. `canonicalStateName` falls back to an
 * edit-distance budget instead.
 *
 * The budget is the risky part, so most of this file is about what must NOT match. A branch filed
 * under the wrong state gets the wrong region, zone and public-holiday calendar, and nothing
 * downstream flags it — that is strictly worse than refusing the row and asking a human.
 */
describe('state spelling tolerance', () => {
  /** Every state and union territory, spelled canonically. */
  const STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
    'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
    'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
    'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Delhi', 'Ladakh', 'Puducherry', 'Chandigarh', 'Lakshadweep',
  ];

  it.each(STATES)('resolves %s to itself', (state) => {
    expect(canonicalStateName(state)).toBe(state);
  });

  it.each([
    ['Gujrat', 'Gujarat'],           // the spelling that cost 4 rows on the real import
    ['Kerela', 'Kerala'],
    ['Panjab', 'Punjab'],
    ['Maharastra', 'Maharashtra'],
    ['Karnatka', 'Karnataka'],
    ['Rajastan', 'Rajasthan'],
    ['Telengana', 'Telangana'],
    ['Jharkand', 'Jharkhand'],
    ['Odissa', 'Odisha'],
    ['Uttarpradesh', 'Uttar Pradesh'],
    ['Himachal Pradsh', 'Himachal Pradesh'],
  ])('recovers the misspelling %s as %s', (typo, expected) => {
    expect(canonicalStateName(typo)).toBe(expected);
  });

  it('is case- and whitespace-insensitive about it', () => {
    expect(canonicalStateName('GUJRAT')).toBe('Gujarat');
    expect(canonicalStateName('  gujrat  ')).toBe('Gujarat');
  });

  it('refuses anything that is not a state, rather than snapping to the nearest one', () => {
    // The columns these actually arrive in: a branch name, an office label, a region word.
    for (const value of [
      'NARNIA', 'UnknownState', 'Nowhereville', 'Region', 'North', 'Bank', 'Branch',
      'Main Branch', 'Head Office', 'XYZ', 'Gujarat Region', '',
    ]) {
      expect(canonicalStateName(value)).toBeNull();
    }
  });

  it('does not guess at short names, where one edit is already a different word', () => {
    // "Goa" has no safe neighbourhood: at three letters, a single edit reaches unrelated words.
    expect(canonicalStateName('Goaa')).toBeNull();
    expect(canonicalStateName('Delh')).toBeNull();
  });

  /**
   * The guarantee that matters. Every single-letter deletion of every state is fed back in; each
   * one must return either the state it came from or nothing at all. A mutation that lands on a
   * DIFFERENT state is the silent-corruption case this tolerance could otherwise introduce.
   */
  it('never resolves a typo of one state to a different state', () => {
    const misassigned: string[] = [];

    for (const state of STATES) {
      const letters = state.toLowerCase().replace(/[^a-z]/g, '');
      for (let i = 0; i < letters.length; i++) {
        const mutant = letters.slice(0, i) + letters.slice(i + 1);
        const resolved = canonicalStateName(mutant);
        if (resolved !== null && resolved !== state) {
          misassigned.push(`"${mutant}" (from ${state}) -> ${resolved}`);
        }
      }
    }

    expect(misassigned).toEqual([]);
  });

  it('keeps the region in step with the state it recovered', () => {
    // A row accepted by canonicalStateName must place somewhere, or a branch is created with a
    // valid state and no region — invisible to every region-scoped desk.
    for (const typo of ['Gujrat', 'Kerela', 'Panjab', 'Maharastra', 'Telengana', 'Jharkand']) {
      const state = canonicalStateName(typo);
      expect(state).not.toBeNull();
      expect(resolveRegion(typo)).toBe(resolveRegion(state));
      expect(resolveRegion(typo)).not.toBeNull();
    }
  });
});
