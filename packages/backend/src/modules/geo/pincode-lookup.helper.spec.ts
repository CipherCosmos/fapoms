import { lookupPincodeDetailed, __resetPincodeCache } from './pincode-lookup.helper';
import * as osm from './osm-geocoder';

/**
 * WHY THE POSTAL DIRECTORY GOES FIRST.
 *
 * This helper asked the self-hosted geocoder first, for speed — ~260ms against India Post's
 * ~3.6s. Measured across twenty pincodes spanning the postal circles, the two agreed on the state
 * 18 times and on the district 14, and one disagreement was the map simply being wrong: 160017
 * reads as Punjab / Sahibzada Ajit Singh Nagar there and Chandigarh in the directory. A pincode is
 * a postal artefact, the directory is what defines it, and this address decides where somebody is
 * sent to work — so the register answers and the map only stands in when it cannot be reached.
 *
 * The three outcomes stay distinct throughout. `not-found` is the directory answering no;
 * `unavailable` is nobody having been able to answer, which is what the map's silence means too.
 */
describe('resolving a pincode to a place', () => {
  const realFetch = global.fetch;
  const directorySays = (postOffice: Record<string, string>) => jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ([{ Status: 'Success', PostOffice: [postOffice] }]),
  });

  beforeEach(() => __resetPincodeCache());
  afterEach(() => { jest.restoreAllMocks(); global.fetch = realFetch; });

  it('answers from the postal directory without consulting the map', async () => {
    const mapSpy = jest.spyOn(osm, 'pincodePlace');
    global.fetch = directorySays({
      State: 'Kerala', District: 'Ernakulam', Block: 'Kochi', Division: 'Ernakulam',
    }) as never;

    // The town is "Ernakulam", not the block's "Kochi": see `choosing the town` below for why an
    // uncorroborated block is not taken, and what filling one in did to Guwahati and Srinagar.
    await expect(lookupPincodeDetailed('682001')).resolves.toEqual({
      status: 'found',
      place: { state: 'Kerala', district: 'Ernakulam', city: 'Ernakulam', source: 'directory' },
    });
    expect(mapSpy).not.toHaveBeenCalled();
  });

  /**
   * The specific reading that decided the order. Both answers are inside postal circle 1, so no
   * offline check can separate them — only asking the register does.
   */
  it('prefers the directory over the map where the two disagree', async () => {
    const mapSpy = jest.spyOn(osm, 'pincodePlace')
      .mockResolvedValue({ state: 'Punjab', district: 'Sahibzada Ajit Singh Nagar', city: 'Mohali' });
    global.fetch = directorySays({ State: 'Chandigarh', District: 'Chandigarh', Block: 'NA' }) as never;

    await expect(lookupPincodeDetailed('160017')).resolves.toEqual({
      status: 'found',
      place: { state: 'Chandigarh', district: 'Chandigarh', city: 'Chandigarh', source: 'directory' },
    });
    expect(mapSpy).not.toHaveBeenCalled();
  });

  it('falls back to the map when the directory cannot be reached, and says so', async () => {
    jest.spyOn(osm, 'pincodePlace')
      .mockResolvedValue({ state: 'Karnataka', district: 'Bengaluru Urban', city: 'Bengaluru' });
    global.fetch = jest.fn().mockRejectedValue(new Error('getaddrinfo EAI_AGAIN')) as never;

    await expect(lookupPincodeDetailed('560066')).resolves.toEqual({
      status: 'found',
      place: { state: 'Karnataka', district: 'Bengaluru Urban', city: 'Bengaluru', source: 'map' },
    });
  });

  /**
   * The state has to be a value the form's own dropdown offers. India Post writes "Jammu &
   * Kashmir" and `INDIAN_STATES` offers "Jammu and Kashmir"; filling the first into a select
   * holding the second leaves it empty while the candidate watches it fill.
   */
  it('returns the state in the spelling the form can hold', async () => {
    global.fetch = directorySays({ State: 'Jammu & Kashmir', District: 'Srinagar', Block: 'NA' }) as never;

    await expect(lookupPincodeDetailed('190001')).resolves.toEqual({
      status: 'found',
      place: { state: 'Jammu and Kashmir', district: 'Srinagar', city: 'Srinagar', source: 'directory' },
    });
  });

  /** The first digit fixes the postal circle, so an answer outside it contradicts its own pincode. */
  it('refuses a reading whose state is outside the pincode\'s postal circle', async () => {
    jest.spyOn(osm, 'pincodePlace').mockResolvedValue(null);
    global.fetch = directorySays({ State: 'Kerala', District: 'Ernakulam', Block: 'Kochi' }) as never;

    // 110001 is circle 1 (Delhi, Haryana, Punjab…). Kerala is circle 6.
    await expect(lookupPincodeDetailed('110001')).resolves.toEqual({ status: 'unavailable' });
  });

  it('refuses a state it cannot match to a real one, rather than filling nonsense', async () => {
    jest.spyOn(osm, 'pincodePlace').mockResolvedValue(null);
    global.fetch = directorySays({ State: 'Wakanda', District: 'Birnin Zana', Block: 'NA' }) as never;

    await expect(lookupPincodeDetailed('682001')).resolves.toEqual({ status: 'unavailable' });
  });

  /** The distinction the old code could not make, and the reason for the bad message. */
  it('says "unavailable" when nobody could ask — never "not found"', async () => {
    jest.spyOn(osm, 'pincodePlace').mockResolvedValue(null);
    global.fetch = jest.fn().mockRejectedValue(new Error('getaddrinfo EAI_AGAIN')) as never;

    await expect(lookupPincodeDetailed('682001')).resolves.toEqual({ status: 'unavailable' });
  });

  it('says "not found" only when the directory itself answered no', async () => {
    const mapSpy = jest.spyOn(osm, 'pincodePlace');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ([{ Status: 'Error', Message: 'No records found' }]),
    }) as never;

    await expect(lookupPincodeDetailed('999999')).resolves.toEqual({ status: 'not-found' });
    // A directory "no" is an answer; asking the map after it would talk the candidate out of it.
    expect(mapSpy).not.toHaveBeenCalled();
  });

  it('treats a six-digit shape as the only thing worth asking about', async () => {
    const spy = jest.spyOn(osm, 'pincodePlace');
    await expect(lookupPincodeDetailed('68200')).resolves.toEqual({ status: 'not-found' });
    await expect(lookupPincodeDetailed('')).resolves.toEqual({ status: 'not-found' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('survives the map throwing when the directory is already down', async () => {
    jest.spyOn(osm, 'pincodePlace').mockRejectedValue(new Error('nominatim down'));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as never;

    await expect(lookupPincodeDetailed('110001')).resolves.toEqual({ status: 'unavailable' });
  });

  /**
   * The town, where the directory has no field that means one — see `townFromDirectory`. These are
   * the real answers for these six pincodes, and the first two are why the rule exists: the block
   * for Guwahati is "Gmc" and for Srinagar it is one locality's post office.
   */
  describe('choosing the town', () => {
    const town = async (pincode: string, postOffice: Record<string, string>) => {
      global.fetch = directorySays(postOffice) as never;
      const answer = await lookupPincodeDetailed(pincode);
      return answer.status === 'found' ? answer.place.city : null;
    };

    it('ignores a block no other field corroborates', async () => {
      await expect(town('781001', {
        State: 'Assam', District: 'Kamrup', Block: 'Gmc', Division: 'Guwahati', Name: 'Fancy Bazar',
      })).resolves.toBe('Kamrup');

      await expect(town('190001', {
        State: 'Jammu & Kashmir', District: 'Srinagar', Block: 'Badyar Balla',
        Division: 'Srinagar', Name: 'Badyar Balla',
      })).resolves.toBe('Srinagar');
    });

    /** Agreement is on whole words: Bagh and Baghpat are two places, not one abbreviated. */
    it('does not read one name as another just because it starts the same way', async () => {
      await expect(town('250609', {
        State: 'Uttar Pradesh', District: 'Baghpat', Block: 'Bagh', Division: 'Baghpat',
      })).resolves.toBe('Baghpat');
    });

    it('keeps a block the district or the division names too', async () => {
      await expect(town('560066', {
        State: 'Karnataka', District: 'Bangalore', Block: 'Bangalore', Division: 'Bangalore East',
      })).resolves.toBe('Bangalore');

      await expect(town('110001', {
        State: 'Delhi', District: 'Central Delhi', Block: 'New Delhi', Division: 'New Delhi Central',
      })).resolves.toBe('New Delhi');

      await expect(town('396210', {
        State: 'Dadra & Nagar Haveli and Daman & Diu', District: 'Daman', Block: 'Daman',
        Division: 'Valsad',
      })).resolves.toBe('Daman');
    });

    it('falls back to the district when there is no block at all', async () => {
      await expect(town('682001', {
        State: 'Kerala', District: 'Ernakulam', Block: 'NA', Division: 'Ernakulam',
      })).resolves.toBe('Ernakulam');
    });
  });

  /**
   * The directory costs about three and a half seconds and pincodes do not move, so a settled
   * answer is kept. A failure is not: remembering it would keep failing after the network came back.
   */
  describe('remembering answers', () => {
    it('asks the slow directory once per pincode', async () => {
      const fetchSpy = directorySays({ State: 'Bihar', District: 'Patna', Block: 'Patna Sadar' });
      global.fetch = fetchSpy as never;

      await lookupPincodeDetailed('800001');
      await lookupPincodeDetailed('800001');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not remember a failure', async () => {
      const failing = jest.fn().mockRejectedValue(new Error('down'));
      global.fetch = failing as never;
      jest.spyOn(osm, 'pincodePlace').mockResolvedValue(null);

      await expect(lookupPincodeDetailed('800001')).resolves.toEqual({ status: 'unavailable' });

      global.fetch = directorySays({ State: 'Bihar', District: 'Patna', Block: 'NA' }) as never;
      await expect(lookupPincodeDetailed('800001')).resolves.toEqual({
        status: 'found',
        place: { state: 'Bihar', district: 'Patna', city: 'Patna', source: 'directory' },
      });
    });
  });
});
