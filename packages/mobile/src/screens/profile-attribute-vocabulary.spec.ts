import {
  parseAttributeList,
  composeAttributeList,
  addAttributeValue,
  removeAttributeValue,
  attributeSuggestions,
} from './profile-attribute-vocabulary';

describe('parseAttributeList / composeAttributeList', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseAttributeList('Gold assaying,  purity testing ,, ')).toEqual([
      'Gold assaying',
      'purity testing',
    ]);
  });

  it('treats a blank or missing value as no chips at all', () => {
    expect(parseAttributeList('')).toEqual([]);
    expect(parseAttributeList(null)).toEqual([]);
    expect(parseAttributeList(undefined)).toEqual([]);
  });

  it('round-trips a list through compose then parse', () => {
    const list = ['Hindi', 'English'];
    expect(parseAttributeList(composeAttributeList(list))).toEqual(list);
  });
});

describe('addAttributeValue', () => {
  it('appends a new value to an empty list', () => {
    expect(addAttributeValue('', 'Hindi')).toBe('Hindi');
  });

  it('appends a genuinely new value that is not in any vocabulary - the add-new escape hatch', () => {
    expect(addAttributeValue('Hindi', 'Konkani')).toBe('Hindi, Konkani');
  });

  it('does not add a case-insensitive duplicate of a value already present', () => {
    expect(addAttributeValue('Hindi', 'hindi')).toBe('Hindi');
  });

  it('leaves the list unchanged when the typed value is blank or only whitespace', () => {
    expect(addAttributeValue('Hindi', '   ')).toBe('Hindi');
    expect(addAttributeValue('Hindi', '')).toBe('Hindi');
  });

  it('trims the value before adding it', () => {
    expect(addAttributeValue('', '  Marathi  ')).toBe('Marathi');
  });
});

describe('removeAttributeValue', () => {
  it('drops the named value and keeps the rest', () => {
    expect(removeAttributeValue('Hindi, English, Marathi', 'English')).toBe('Hindi, Marathi');
  });

  it('is a no-op when the value is not present', () => {
    expect(removeAttributeValue('Hindi', 'Bengali')).toBe('Hindi');
  });
});

describe('attributeSuggestions', () => {
  const vocabulary = ['Gold assaying', 'Silver testing', 'Purity testing'];

  it('excludes values already selected', () => {
    expect(attributeSuggestions(vocabulary, ['Gold assaying'], '')).toEqual([
      'Purity testing',
      'Silver testing',
    ]);
  });

  it('excludes an already-selected value case-insensitively', () => {
    expect(attributeSuggestions(vocabulary, ['gold assaying'], '')).not.toContain('Gold assaying');
  });

  it('filters by a case-insensitive substring query', () => {
    expect(attributeSuggestions(vocabulary, [], 'testing')).toEqual(['Purity testing', 'Silver testing']);
    expect(attributeSuggestions(vocabulary, [], 'TESTING')).toEqual(['Purity testing', 'Silver testing']);
  });

  it('returns everything unselected, sorted, when the query is blank', () => {
    expect(attributeSuggestions(vocabulary, [], '')).toEqual([
      'Gold assaying',
      'Purity testing',
      'Silver testing',
    ]);
  });

  it('returns nothing when no vocabulary entry matches the query', () => {
    expect(attributeSuggestions(vocabulary, [], 'zzz')).toEqual([]);
  });

  it('handles an empty vocabulary - the HR-scoped 403 case - without throwing', () => {
    expect(attributeSuggestions([], [], 'anything')).toEqual([]);
  });
});
