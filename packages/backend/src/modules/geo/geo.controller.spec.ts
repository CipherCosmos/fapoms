import { GeoController } from './geo.controller';
import * as indiaAutocomplete from './india-autocomplete.helper';

/**
 * `GET /geo/autocomplete` — whether an empty result can be told apart from "the integration
 * isn't configured".
 *
 * `autocompleteIndia`'s own doc comment: with no `GOOGLE_MAPS_API_KEY`, every query returns an
 * empty list, and that is "indistinguishable from 'no such place' unless the caller asks" via
 * the already-exported `isPlaceLookupConfigured()`. Confirmed live on this deployment (no key
 * configured): `q=Mumbai`, `q=Maharashtra` and a real 6-digit pincode all came back
 * `{success:true, data:[]}` — structurally identical to a genuine "no match", with nothing in
 * the response to tell a caller the whole integration is absent rather than the place not
 * existing. The controller was exactly the caller the helper's comment warns about: it never
 * asked. This suite pins the fix — `meta.configured` now carries that answer — directly against
 * the real handler, with only `india-autocomplete.helper` mocked (everything else the
 * constructor takes is unused by this method).
 */
describe('GeoController#autocomplete — tells "no match" apart from "not configured"', () => {
  // The handler reads none of the injected dependencies, so a real GeoController can be built
  // with none provided rather than standing up a full Nest TestingModule for one method.
  const controller = new GeoController(
    undefined as any, undefined as any, undefined as any, undefined as any,
    undefined as any, undefined as any, undefined as any,
  );

  afterEach(() => jest.restoreAllMocks());

  it('says configured:false alongside the empty list when GOOGLE_MAPS_API_KEY is absent', async () => {
    jest.spyOn(indiaAutocomplete, 'autocompleteIndia').mockResolvedValue([]);
    jest.spyOn(indiaAutocomplete, 'isPlaceLookupConfigured').mockReturnValue(false);

    const result = await controller.autocomplete('Mumbai');

    expect(result).toEqual({ success: true, data: [], meta: { configured: false } });
  });

  it('says configured:true and still returns real matches once a key is set', async () => {
    const hits: indiaAutocomplete.IndiaPlaceResult[] = [
      { label: 'Mumbai, Maharashtra', type: 'city', state: 'Maharashtra', district: '', pincode: '' },
    ];
    jest.spyOn(indiaAutocomplete, 'autocompleteIndia').mockResolvedValue(hits);
    jest.spyOn(indiaAutocomplete, 'isPlaceLookupConfigured').mockReturnValue(true);

    const result = await controller.autocomplete('Mumbai');

    expect(result).toEqual({ success: true, data: hits, meta: { configured: true } });
  });

  it('an unconfigured empty result and a configured genuine miss both say configured accurately, not the same thing', async () => {
    // Unconfigured: configured:false is itself the signal, whatever `data` holds.
    jest.spyOn(indiaAutocomplete, 'autocompleteIndia').mockResolvedValue([]);
    jest.spyOn(indiaAutocomplete, 'isPlaceLookupConfigured').mockReturnValue(false);
    expect((await controller.autocomplete('Nonexistentplace')).meta.configured).toBe(false);

    // Configured, but this particular query genuinely has no match: configured:true, data:[].
    jest.spyOn(indiaAutocomplete, 'autocompleteIndia').mockResolvedValue([]);
    jest.spyOn(indiaAutocomplete, 'isPlaceLookupConfigured').mockReturnValue(true);
    const genuineMiss = await controller.autocomplete('Nonexistentplace');
    expect(genuineMiss).toEqual({ success: true, data: [], meta: { configured: true } });
  });
});
