import { RELATIONSHIPS, relationshipOptions } from './reference-vocabulary';

/**
 * The one list both the registration wizard and the vetting tab render.
 *
 * `RegistrationWizard.tsx` and `AssayerVettingTab.tsx` write the same column
 * (`assayer_reference.relationship`) through separate forms — a reference is first added on one
 * screen and corrected on the other. Component-level tests in each file prove the dropdown is
 * actually wired to this module; what belongs here is the shared logic itself, so a mutation that
 * breaks the escape hatch (e.g. always returning the fixed list, or dropping the current value
 * instead of appending it) fails a fast, file-local test rather than only a slower UI one.
 */
describe('reference-vocabulary', () => {
  it('is the fixed set of relationships, not open-ended text', () => {
    expect(RELATIONSHIPS).toEqual([
      'Former manager', 'Former colleague', 'Current colleague', 'Client contact',
      'Friend', 'Neighbour', 'Relative',
    ]);
  });

  it('offers "Not recorded" plus every relationship when nothing off-list is on file', () => {
    const options = relationshipOptions('');
    expect(options.map((o) => o.value)).toEqual(['', ...RELATIONSHIPS]);
    expect(options[0]).toEqual({ value: '', label: 'Not recorded' });
  });

  it('leaves a value already in the list exactly as it is, with no extra entry appended', () => {
    const options = relationshipOptions('Friend');
    expect(options).toHaveLength(RELATIONSHIPS.length + 1);
    expect(options.filter((o) => o.value === 'Friend')).toHaveLength(1);
  });

  it('keeps an unrecognised on-file value visible instead of dropping it', () => {
    // 'Ex-manager' stands in for exactly what free text used to produce: a real relationship,
    // spelled a way this fixed list does not contain.
    const options = relationshipOptions('Ex-manager');
    expect(options).toContainEqual({ value: 'Ex-manager', label: 'Ex-manager — as recorded' });
  });

  it('adds nothing extra for a blank or null value', () => {
    expect(relationshipOptions(null)).toHaveLength(RELATIONSHIPS.length + 1);
    expect(relationshipOptions(undefined)).toHaveLength(RELATIONSHIPS.length + 1);
  });
});
