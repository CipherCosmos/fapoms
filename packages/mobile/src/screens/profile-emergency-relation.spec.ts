import {
  EMERGENCY_RELATIONS,
  EMERGENCY_RELATION_OTHER,
  resolveEmergencyRelation,
  composeEmergencyRelation,
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

  it('trims the typed "Other" text', () => {
    expect(composeEmergencyRelation(EMERGENCY_RELATION_OTHER, '  Cousin  ')).toBe('Cousin');
  });

  it('saves an empty string when "Other" is chosen but nothing has been typed yet', () => {
    expect(composeEmergencyRelation(EMERGENCY_RELATION_OTHER, '')).toBe('');
  });
});
