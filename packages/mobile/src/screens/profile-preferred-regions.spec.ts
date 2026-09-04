import { Region } from '@fapoms/shared';
import {
  parsePreferredRegions,
  composePreferredRegions,
  toggleRegionSelection,
  removeLegacyRegionValue,
} from './profile-preferred-regions';

describe('parsePreferredRegions', () => {
  it('returns nothing selected and nothing legacy for a blank profile', () => {
    expect(parsePreferredRegions('')).toEqual({ selected: [], legacy: [] });
    expect(parsePreferredRegions(null)).toEqual({ selected: [], legacy: [] });
    expect(parsePreferredRegions(undefined)).toEqual({ selected: [], legacy: [] });
  });

  it('recognises the six canonical enum values regardless of case', () => {
    expect(parsePreferredRegions('NORTH, south, West')).toEqual({
      selected: [Region.NORTH, Region.WEST, Region.SOUTH],
      legacy: [],
    });
  });

  it('recognises a dashed/spaced NORTH_EAST spelling', () => {
    expect(parsePreferredRegions('north-east')).toEqual({ selected: [Region.NORTH_EAST], legacy: [] });
    expect(parsePreferredRegions('North East')).toEqual({ selected: [Region.NORTH_EAST], legacy: [] });
  });

  it('orders the selected list geographically (REGION_ORDER), not by input order', () => {
    // Typed south-first; the picker always renders the fixed north-to-south order.
    expect(parsePreferredRegions('SOUTH, NORTH').selected).toEqual([Region.NORTH, Region.SOUTH]);
  });

  it('de-duplicates a region listed twice', () => {
    expect(parsePreferredRegions('NORTH, NORTH').selected).toEqual([Region.NORTH]);
  });

  it('keeps a value that fails to resolve at all as legacy - the "Delhi NCR" case', () => {
    expect(parsePreferredRegions('Delhi NCR')).toEqual({ selected: [], legacy: ['Delhi NCR'] });
  });

  it('keeps a value that names a zone rather than a region as legacy - the "Western India" case', () => {
    expect(parsePreferredRegions('Western India')).toEqual({ selected: [], legacy: ['Western India'] });
  });

  it('does NOT silently reinterpret a state name into its region, even though resolveRegion could', () => {
    // resolveRegion('Maharashtra') === Region.WEST, but a profile whose preferredRegions field
    // literally holds the string "Maharashtra" was never told this is a region field - showing
    // it back as "West" selected would rewrite what is on file without the assayer doing anything.
    expect(parsePreferredRegions('Maharashtra')).toEqual({ selected: [], legacy: ['Maharashtra'] });
  });

  it('never crashes on an old free-text profile and mixes recognised and unrecognised tokens', () => {
    const parsed = parsePreferredRegions('NORTH, Maharashtra, south, some nonsense');
    expect(parsed.selected).toEqual([Region.NORTH, Region.SOUTH]);
    expect(parsed.legacy).toEqual(['Maharashtra', 'some nonsense']);
  });
});

describe('composePreferredRegions', () => {
  it('joins selected regions before legacy tokens, in geographic order', () => {
    expect(
      composePreferredRegions({ selected: [Region.SOUTH, Region.NORTH], legacy: ['Delhi NCR'] }),
    ).toBe('NORTH, SOUTH, Delhi NCR');
  });

  it('round-trips a parse with nothing selected and nothing legacy to an empty string', () => {
    expect(composePreferredRegions({ selected: [], legacy: [] })).toBe('');
  });

  it('round-trips parse -> compose for a value with no legacy tokens', () => {
    const value = 'NORTH, WEST';
    expect(composePreferredRegions(parsePreferredRegions(value))).toBe('NORTH, WEST');
  });
});

describe('toggleRegionSelection', () => {
  it('adds a region not yet selected', () => {
    const next = toggleRegionSelection({ selected: [], legacy: [] }, Region.EAST);
    expect(next.selected).toEqual([Region.EAST]);
  });

  it('removes a region already selected', () => {
    const next = toggleRegionSelection({ selected: [Region.EAST, Region.WEST], legacy: [] }, Region.EAST);
    expect(next.selected).toEqual([Region.WEST]);
  });

  it('leaves legacy tokens untouched', () => {
    const next = toggleRegionSelection({ selected: [], legacy: ['Delhi NCR'] }, Region.NORTH);
    expect(next.legacy).toEqual(['Delhi NCR']);
  });
});

describe('removeLegacyRegionValue', () => {
  it('drops the named legacy token and leaves the others and the selection alone', () => {
    const next = removeLegacyRegionValue(
      { selected: [Region.NORTH], legacy: ['Delhi NCR', 'Maharashtra'] },
      'Delhi NCR',
    );
    expect(next).toEqual({ selected: [Region.NORTH], legacy: ['Maharashtra'] });
  });
});
