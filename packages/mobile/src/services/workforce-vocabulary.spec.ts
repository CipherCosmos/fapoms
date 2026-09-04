import { cleanWorkforceVocabulary } from './workforce-vocabulary';

describe('cleanWorkforceVocabulary', () => {
  it('reads skills off SKILL and languages off LANGUAGE, dropping certifications and specializations', () => {
    const result = cleanWorkforceVocabulary({
      SKILL: [{ name: 'Gold assaying', assayerCount: 4 }],
      LANGUAGE: [{ name: 'Hindi', assayerCount: 9 }],
      CERTIFICATION: [{ name: 'ISO 9001', assayerCount: 1 }],
    });
    expect(result).toEqual({ skills: ['Gold assaying'], languages: ['Hindi'] });
  });

  it('de-duplicates and sorts alphabetically, ignoring the roster usage counts', () => {
    const result = cleanWorkforceVocabulary({
      SKILL: [
        { name: 'Silver testing', assayerCount: 1 },
        { name: 'Gold assaying', assayerCount: 50 },
        { name: 'Gold assaying', assayerCount: 50 },
      ],
    });
    expect(result.skills).toEqual(['Gold assaying', 'Silver testing']);
  });

  it('drops entries with a missing or blank name instead of throwing', () => {
    const result = cleanWorkforceVocabulary({
      SKILL: [{ assayerCount: 1 }, { name: '' }, { name: '   ' }, { name: 'Gold assaying' }],
    });
    expect(result.skills).toEqual(['Gold assaying']);
  });

  it('returns empty lists for every shape a 403 or an empty roster can produce', () => {
    expect(cleanWorkforceVocabulary(undefined)).toEqual({ skills: [], languages: [] });
    expect(cleanWorkforceVocabulary(null)).toEqual({ skills: [], languages: [] });
    expect(cleanWorkforceVocabulary({})).toEqual({ skills: [], languages: [] });
    expect(cleanWorkforceVocabulary({ SKILL: null, LANGUAGE: 'not-an-array' })).toEqual({
      skills: [],
      languages: [],
    });
  });
});
