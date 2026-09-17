import { INDIAN_STATES, matchIndianState, stateNameKey, canonicalStateName } from './index';

/**
 * A STATE IS ONLY FILLED IN CORRECTLY IF THE FORM CAN HOLD IT.
 *
 * Addresses arrive from two directories that spell states differently from each other and from
 * this app: India Post writes "Jammu & Kashmir", OpenStreetMap writes "Jammu and Kashmir", and
 * `INDIAN_STATES` — the list every state `<select>` is built from — offers exactly one of them.
 * Writing the wrong one leaves the select blank while the person watches it fill, and they submit
 * a record with no state at all. That is a worse outcome than not filling anything, because it
 * looks like it worked.
 */
describe('matching a state name to the one this app offers', () => {
  const values = INDIAN_STATES.map((s) => s.value);

  it('answers with a value the dropdown actually contains', () => {
    for (const name of ['Jammu & Kashmir', 'Jammu and Kashmir', 'ANDAMAN & NICOBAR ISLANDS', 'Delhi']) {
      const matched = matchIndianState(name);
      expect(matched).not.toBeNull();
      expect(values).toContain(matched as string);
    }
  });

  it('recovers the spellings the two directories disagree on', () => {
    expect(matchIndianState('Jammu & Kashmir')).toBe('Jammu and Kashmir');
    expect(matchIndianState('Jammu and Kashmir')).toBe('Jammu and Kashmir');
    expect(matchIndianState('Andaman & Nicobar Islands')).toBe('Andaman and Nicobar Islands');
  });

  it('recovers abbreviations and old names through the canonicaliser', () => {
    expect(matchIndianState('AP')).toBe('Andhra Pradesh');
    expect(matchIndianState('Pondicherry')).toBe('Puducherry');
    expect(matchIndianState('NCT of Delhi')).toBe('Delhi');
    expect(matchIndianState('Orissa')).toBe('Odisha');
  });

  it('answers nothing for a name that is not a state, rather than guessing', () => {
    expect(matchIndianState('Wakanda')).toBeNull();
    expect(matchIndianState('')).toBeNull();
    expect(matchIndianState(null)).toBeNull();
    expect(matchIndianState(undefined)).toBeNull();
    expect(matchIndianState('   ')).toBeNull();
  });

  /**
   * Every canonical state has to be reachable, or a correct directory answer for somebody's home
   * silently resolves to nothing. This is how the missing union territory was found: the list
   * offered 28 states and 7 of the 8 UTs, so a 396-series pincode matched no option on the form
   * and nobody living in Silvassa or Daman could pick where they live.
   */
  it('offers every state the app can canonicalise, with no gaps', () => {
    for (const value of values) {
      const canonical = canonicalStateName(value);
      expect(canonical).not.toBeNull();
      expect(matchIndianState(canonical)).toBe(value);
    }
    expect(matchIndianState('Dadra & Nagar Haveli and Daman & Diu'))
      .toBe('Dadra and Nagar Haveli and Daman and Diu');
    // 28 states + 8 union territories. The number is a fact about India, not about this list,
    // which is what makes it worth asserting: the loop above cannot notice a state that is gone.
    expect(values).toHaveLength(36);
  });

  it('reads "&" and "and" as the same word, and punctuation as noise', () => {
    expect(stateNameKey('Jammu & Kashmir')).toBe(stateNameKey('Jammu and Kashmir'));
    expect(stateNameKey('Tamil Nadu')).toBe(stateNameKey('TAMIL-NADU'));
    expect(stateNameKey('Kerala')).not.toBe(stateNameKey('Karnataka'));
  });
});
