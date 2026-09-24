import {
  EMERGENCY_RELATIONS,
  EMERGENCY_RELATION_OTHER,
  resolveEmergencyRelation,
  composeEmergencyRelation,
  emergencyRelationForSave,
} from './profile-emergency-relation';

describe('resolveEmergencyRelation', () => {
  it('renders nothing chosen for a blank profile, not "Other" with an empty box', () => {
    expect(resolveEmergencyRelation('')).toEqual({ choice: '', otherText: '' });
    expect(resolveEmergencyRelation(null)).toEqual({ choice: '', otherText: '' });
    expect(resolveEmergencyRelation(undefined)).toEqual({ choice: '', otherText: '' });
  });

  it.each(EMERGENCY_RELATIONS)('selects the matching fixed option for %s', (relation) => {
    expect(resolveEmergencyRelation(relation)).toEqual({ choice: relation, otherText: '' });
  });

  it('falls into "Other" for a value that is not one of the six fixed relations, keeping the text', () => {
    expect(resolveEmergencyRelation('Cousin')).toEqual({
      choice: EMERGENCY_RELATION_OTHER,
      otherText: 'Cousin',
    });
  });

  it('never crashes on and never blanks an old free-text profile value', () => {
    expect(resolveEmergencyRelation('Neighbour and family friend')).toEqual({
      choice: EMERGENCY_RELATION_OTHER,
      otherText: 'Neighbour and family friend',
    });
  });

  it('is exact-match on the fixed relations - different casing falls into "Other"', () => {
    // Deliberately strict: "spouse" is not silently upgraded to "Spouse", it round-trips as
    // recorded, exactly like an unrecognised region token does in profile-preferred-regions.ts.
    expect(resolveEmergencyRelation('spouse')).toEqual({ choice: EMERGENCY_RELATION_OTHER, otherText: 'spouse' });
  });
});

describe('composeEmergencyRelation', () => {
  it('saves a fixed choice as-is', () => {
    expect(composeEmergencyRelation('Parent', '')).toBe('Parent');
  });

  it('saves the typed text, not the word "Other", when the choice is "Other"', () => {
    expect(composeEmergencyRelation(EMERGENCY_RELATION_OTHER, 'Cousin')).toBe('Cousin');
  });

  /**
   * The defect: "Other" with nothing typed composed to '', which reads back as nothing chosen - so
   * tapping "Other" did nothing and the box never appeared.
   */
  it('keeps "Other" selected, with an empty box, before anything is typed', () => {
    const draft = composeEmergencyRelation(EMERGENCY_RELATION_OTHER, '');
    expect(resolveEmergencyRelation(draft)).toEqual({ choice: EMERGENCY_RELATION_OTHER, otherText: '' });
  });

  /**
   * The other defect: the text was trimmed on every keystroke, so the space typed between two
   * words disappeared before the second word could be started.
   */
  it('keeps spaces while typing, so a two-word relation can be entered', () => {
    let value = composeEmergencyRelation(EMERGENCY_RELATION_OTHER, '');
    for (const typed of ['F', 'Family', 'Family ', 'Family f', 'Family friend']) {
      value = composeEmergencyRelation(EMERGENCY_RELATION_OTHER, typed);
      expect(resolveEmergencyRelation(value)).toEqual({ choice: EMERGENCY_RELATION_OTHER, otherText: typed });
    }
    expect(value).toBe('Family friend');
  });

  it('switching away from "Other" and back starts with an empty box', () => {
    expect(resolveEmergencyRelation(composeEmergencyRelation('Parent', ''))).toEqual({ choice: 'Parent', otherText: '' });
    expect(resolveEmergencyRelation(composeEmergencyRelation(EMERGENCY_RELATION_OTHER, ''))).toEqual({
      choice: EMERGENCY_RELATION_OTHER,
      otherText: '',
    });
  });
});

describe('emergencyRelationForSave', () => {
  it('trims only on save', () => {
    expect(emergencyRelationForSave('  Family friend  ')).toBe('Family friend');
    expect(emergencyRelationForSave('Family friend ')).toBe('Family friend');
  });

  it('never saves the bare word "Other" - an empty "Other" saves as no relation', () => {
    expect(emergencyRelationForSave(EMERGENCY_RELATION_OTHER)).toBe('');
    expect(emergencyRelationForSave(composeEmergencyRelation(EMERGENCY_RELATION_OTHER, '   '))).toBe('');
  });

  it('saves a fixed choice and a blank value unchanged', () => {
    expect(emergencyRelationForSave('Parent')).toBe('Parent');
    expect(emergencyRelationForSave('')).toBe('');
    expect(emergencyRelationForSave(null)).toBe('');
  });
});
