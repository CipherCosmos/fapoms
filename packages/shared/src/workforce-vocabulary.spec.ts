import { cleanVocabularyList } from './workforce-vocabulary';

describe('cleanVocabularyList', () => {
  it('extracts names, de-duplicates and sorts them', () => {
    expect(cleanVocabularyList([{ name: 'Gold Valuation' }, { name: 'Fire Assay' }, { name: 'Gold Valuation' }]))
      .toEqual(['Fire Assay', 'Gold Valuation']);
  });

  it('drops entries with no usable name', () => {
    expect(cleanVocabularyList([{ name: 'Fire Assay' }, { name: '' }, { name: '   ' }, {}, { name: null }]))
      .toEqual(['Fire Assay']);
  });

  it('drops non-object entries rather than throwing', () => {
    expect(cleanVocabularyList(['Fire Assay', null, 42, { name: 'Gold Valuation' }]))
      .toEqual(['Gold Valuation']);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(cleanVocabularyList(undefined)).toEqual([]);
    expect(cleanVocabularyList(null)).toEqual([]);
    expect(cleanVocabularyList('not-an-array')).toEqual([]);
    expect(cleanVocabularyList({ SKILL: [] })).toEqual([]);
  });
});
