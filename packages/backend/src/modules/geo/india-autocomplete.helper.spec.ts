/**
 * Address type-ahead answers from the Nominatim we run — or honestly says it cannot.
 *
 * This feature was dead for its whole life: it asked Google Places, `GOOGLE_MAPS_API_KEY` was
 * never set, and every query returned `[]`. Because an empty list reads exactly like "no such
 * place", `BranchService.validateGeography` had to be taught to skip verification entirely
 * rather than refuse real branches. The owner chose self-hosting over buying a key (2026-09-19),
 * so the source is now the Nominatim instance `osm-geocoder` already talks to.
 *
 * Two things are pinned here, and the first is a licence rule, not a preference: the public
 * nominatim.openstreetmap.org names auto-complete in its unacceptable-use list, so a deployment
 * without its own instance must report itself unconfigured rather than quietly querying someone
 * else's server. The rest is the mapping — Nominatim's address vocabulary is not this product's,
 * and a suburb promoted to 'city' puts a neighbourhood in the city field.
 */

// Hermetic: no disk writes, no cross-test cache bleed through the on-disk type-ahead cache.
jest.mock('./geo-cache-store', () => ({
  JsonFileCache: jest.fn().mockImplementation(() => {
    const entries = new Map<string, unknown>();
    return {
      get: (k: string) => entries.get(k),
      set: (k: string, v: unknown) => { entries.set(k, v); },
      prune: () => { /* nothing to age out in a per-test map */ },
    };
  }),
}));

jest.mock('./osm-geocoder', () => ({
  nominatimPlaceSearch: jest.fn(),
  nominatimIsSelfHosted: jest.fn(),
}));

import { autocompleteIndia, isPlaceLookupConfigured } from './india-autocomplete.helper';
import { nominatimPlaceSearch, nominatimIsSelfHosted } from './osm-geocoder';

const search = nominatimPlaceSearch as jest.Mock;
const selfHosted = nominatimIsSelfHosted as jest.Mock;

const row = (
  addressType: string,
  address: Record<string, string>,
  displayName = 'X, India',
  category = 'place',
) => ({ displayName, category, addressType, address, lat: 18.5, lon: 73.8 });

describe('autocompleteIndia — one self-hosted source, mapped to this product\'s vocabulary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selfHosted.mockReturnValue(true);
    search.mockResolvedValue([]);
  });

  describe('the public server is not a fallback', () => {
    it('reports itself unconfigured when Nominatim is not self-hosted', () => {
      selfHosted.mockReturnValue(false);
      expect(isPlaceLookupConfigured()).toBe(false);
    });

    it('never queries at all when it is not self-hosted — auto-complete is unacceptable use', async () => {
      selfHosted.mockReturnValue(false);
      await expect(autocompleteIndia('Pune')).resolves.toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });

    it('is configured, and queries, when we run the instance', async () => {
      expect(isPlaceLookupConfigured()).toBe(true);
      await autocompleteIndia('Pune');
      expect(search).toHaveBeenCalledWith('Pune', 20);
    });
  });

  describe('mapping Nominatim\'s vocabulary onto the form\'s', () => {
    it('labels a state by its own name, not "State, State"', async () => {
      search.mockResolvedValue([row('state', { state: 'Maharashtra' })]);
      await expect(autocompleteIndia('Mahar')).resolves.toEqual([
        { label: 'Maharashtra', type: 'state', state: 'Maharashtra', district: '', pincode: '' },
      ]);
    });

    it('labels a city as "City, District, State"', async () => {
      search.mockResolvedValue([
        row('city', { city: 'Pune', state_district: 'Pune District', state: 'Maharashtra', postcode: '411001' }),
      ]);
      const [hit] = await autocompleteIndia('Pune c');
      expect(hit).toEqual({
        label: 'Pune, Pune District, Maharashtra',
        type: 'city', state: 'Maharashtra', district: 'Pune District', pincode: '411001',
      });
    });

    it('does not repeat a name when the district matches the city', async () => {
      search.mockResolvedValue([row('city', { city: 'Nagpur', state_district: 'Nagpur', state: 'Maharashtra' })]);
      const [hit] = await autocompleteIndia('Nagp');
      expect(hit.label).toBe('Nagpur, Maharashtra');
    });

    it('reads a district from `county` when `state_district` is absent', async () => {
      search.mockResolvedValue([row('county', { county: 'Bagalkot', state: 'Karnataka' })]);
      const [hit] = await autocompleteIndia('Bagal');
      expect(hit).toMatchObject({ type: 'district', district: 'Bagalkot', state: 'Karnataka' });
    });

    it('calls an unrecognised address type a locality rather than guessing', async () => {
      search.mockResolvedValue([row('neighbourhood', { suburb: 'Koregaon Park', state: 'Maharashtra' })]);
      const [hit] = await autocompleteIndia('Koreg');
      // 'suburb' must NOT become 'city' — the type decides which dropdown the hit may fill.
      expect(hit.type).toBe('locality');
      expect(hit.label).toContain('Koregaon Park');
    });
  });

  describe('what it refuses to show', () => {
    /**
     * Measured against the live instance: "Bagalkot" ranks a cement works, an office and five
     * roads above the city. A type-ahead that offers those files a branch under a road.
     */
    it('drops roads and POIs that merely share the name, keeping the place', async () => {
      search.mockResolvedValue([
        row('industrial', { state: 'Karnataka' }, 'Bagalkot Cement', 'landuse'),
        row('road', { state: 'Karnataka' }, 'Bagalkot Road', 'highway'),
        row('city', { city: 'Bagalkote', state_district: 'Bagalkot', state: 'Karnataka' }, 'Bagalkote', 'place'),
      ]);
      const hits = await autocompleteIndia('Bagalkot');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ type: 'city', state: 'Karnataka' });
    });

    it('keeps administrative boundaries, which is how districts and states arrive', async () => {
      search.mockResolvedValue([
        row('state_district', { state_district: 'Pune', state: 'Maharashtra' }, 'Pune', 'boundary'),
      ]);
      await expect(autocompleteIndia('Pune d')).resolves.toHaveLength(1);
    });

    it('drops a row with no state — no form field could use it', async () => {
      search.mockResolvedValue([row('city', { city: 'Somewhere' }), row('city', { city: 'Pune', state: 'Maharashtra' })]);
      const hits = await autocompleteIndia('Some');
      expect(hits).toHaveLength(1);
      expect(hits[0].state).toBe('Maharashtra');
    });

    it('collapses duplicate suggestions', async () => {
      const dup = row('city', { city: 'Pune', state_district: 'Pune District', state: 'Maharashtra' });
      search.mockResolvedValue([dup, { ...dup }]);
      await expect(autocompleteIndia('dup')).resolves.toHaveLength(1);
    });

    it('caps the dropdown at eight', async () => {
      search.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => row('city', { city: `Town${i}`, state: 'Maharashtra' })),
      );
      await expect(autocompleteIndia('many')).resolves.toHaveLength(8);
    });

    it('answers a blank query without a network call', async () => {
      await expect(autocompleteIndia('   ')).resolves.toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });
  });

  it('serves a repeated query from cache instead of asking twice', async () => {
    search.mockResolvedValue([row('city', { city: 'Nashik', state: 'Maharashtra' })]);
    await autocompleteIndia('Nashik');
    await autocompleteIndia('nashik  ');
    expect(search).toHaveBeenCalledTimes(1);
  });
});
