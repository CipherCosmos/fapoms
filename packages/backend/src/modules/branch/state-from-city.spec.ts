import { stateFromCity, canonicalStateName } from '@fapoms/shared';

/**
 * Bank branch files put a city in the State column. The importer recovers the state from the city
 * (see branch.service importExcel) rather than dropping a real branch; these pin that recovery and,
 * just as importantly, that an unknown value still fails so a genuine typo is caught, not guessed.
 */
describe('stateFromCity — recover the state a city stands in for', () => {
  it.each([
    ['Chennai', 'Tamil Nadu'],
    ['chennai', 'Tamil Nadu'],
    ['CHENNAI', 'Tamil Nadu'],
    ['Bangalore', 'Karnataka'],
    ['Bengaluru', 'Karnataka'],
    ['Mumbai', 'Maharashtra'],
    ['Pune', 'Maharashtra'],
    ['Hyderabad', 'Telangana'],
    ['Kolkata', 'West Bengal'],
    ['New Delhi', 'Delhi'],
    ['Gurgaon', 'Haryana'],
    ['Kochi', 'Kerala'],
  ])('reads "%s" as %s', (city, state) => {
    expect(stateFromCity(city)).toBe(state);
  });

  it('tolerates spacing/punctuation the same way the state map does', () => {
    expect(stateFromCity('navi-mumbai')).toBe('Maharashtra');
    expect(stateFromCity('  Bengaluru ')).toBe('Karnataka');
  });

  it('returns null for a value that is neither a known city nor a state', () => {
    expect(stateFromCity('Nowhereville')).toBeNull();
    expect(stateFromCity('')).toBeNull();
    expect(stateFromCity(undefined)).toBeNull();
  });

  it('does not resolve an actual state name (that path is canonicalStateName)', () => {
    // A real state should be handled by the state check first; the city map simply does not carry it.
    expect(stateFromCity('Tamil Nadu')).toBeNull();
    expect(canonicalStateName('Tamil Nadu')).toBe('Tamil Nadu');
  });
});
