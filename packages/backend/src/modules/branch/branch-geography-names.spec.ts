/**
 * The geography check compares place names in one form on both sides.
 *
 * A 5,000-branch load test (2026-09-24) refused every branch in Daman, Diu, Silvassa and
 * Mayabunder: the bank's sheet wrote "Dadra & Nagar Haveli and Daman & Diu" and the place lookup
 * answered "Dadra and Nagar Haveli and Daman and Diu", and an exact comparison called real
 * union-territory branches misspelt.
 */
jest.mock('../geo/india-autocomplete.helper', () => ({
  isPlaceLookupConfigured: () => true,
  autocompleteIndia: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
import { autocompleteIndia } from '../geo/india-autocomplete.helper';
import { BranchService, samePlaceName, samePlaceState } from './branch.service';

const lookup = autocompleteIndia as jest.Mock;

/** Only the three reference repositories the check reads; none of them knows these places. */
function service(): BranchService {
  const none = { findOne: jest.fn().mockResolvedValue(null) };
  return Object.assign(Object.create(BranchService.prototype), {
    stateRepository: none,
    districtRepository: none,
    cityRepository: none,
  });
}

describe('place names compared in one form', () => {
  it('treats "&" and "and", case, punctuation and spacing as the same name', () => {
    expect(samePlaceName('North & Middle  Andaman')).toBe(samePlaceName('north and middle andaman'));
    expect(samePlaceName('Dadra and Nagar-Haveli')).toBe(samePlaceName('Dadra and Nagar Haveli'));
    expect(samePlaceName('Diu')).not.toBe(samePlaceName('Daman'));
  });

  it('compares states by their canonical name', () => {
    expect(samePlaceState('Dadra & Nagar Haveli and Daman & Diu')).toBe(
      samePlaceState('Dadra and Nagar Haveli and Daman and Diu'),
    );
    expect(samePlaceState('Andaman & Nicobar Islands')).toBe(samePlaceState('Andaman and Nicobar Islands'));
  });
});

describe('BranchService geography check — union territories written with "&"', () => {
  beforeEach(() => lookup.mockReset());

  it.each([
    ['Dadra & Nagar Haveli and Daman & Diu', 'Daman', 'Daman', 'Daman', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['Dadra & Nagar Haveli and Daman & Diu', 'Dadra and Nagar Haveli', 'Silvassa', 'Dadra and Nagar Haveli', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['Andaman & Nicobar Islands', 'North and Middle Andaman', 'Mayabunder', 'North and Middle Andaman', 'Andaman and Nicobar Islands'],
  ])('accepts %s / %s / %s as the lookup spells it', async (state, district, city, liveDistrict, liveState) => {
    // The city search finds the place; the state search finds nothing useful — so only a
    // name-for-name match of district and state can let this through.
    lookup.mockImplementation(async (q: string) =>
      q === city ? [{ type: 'city', district: liveDistrict, state: liveState }] : [],
    );
    await expect(service().assertGeographyVerifiable(state, district, city)).resolves.toBeUndefined();
  });

  it('still refuses a place the lookup puts in another state', async () => {
    lookup.mockImplementation(async (q: string) =>
      q === 'Daman' ? [{ type: 'village', district: 'Jalore', state: 'Rajasthan' }] : [],
    );
    await expect(
      service().assertGeographyVerifiable('Dadra & Nagar Haveli and Daman & Diu', 'Daman', 'Daman'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
