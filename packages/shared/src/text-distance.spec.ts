import { editDistance } from './text-distance';

describe('editDistance', () => {
  it('is 0 for identical strings, without doing any work', () => {
    expect(editDistance('kitten', 'kitten', 5)).toBe(0);
    expect(editDistance('', '', 5)).toBe(0);
  });

  it('matches the textbook Levenshtein example', () => {
    expect(editDistance('kitten', 'sitting', 5)).toBe(3);
  });

  it('is symmetric', () => {
    expect(editDistance('kitten', 'sitting', 5)).toBe(editDistance('sitting', 'kitten', 5));
  });

  it('counts one insertion and one deletion correctly', () => {
    expect(editDistance('cat', 'cats', 3)).toBe(1);
    expect(editDistance('cats', 'cat', 3)).toBe(1);
  });

  it('bounds a hopeless pair at ceiling + 1 rather than reporting the true distance', () => {
    // True distance between these is large; the caller only asked "within budget 1".
    expect(editDistance('completely', 'different', 1)).toBe(2);
  });

  it('short-circuits on length difference alone, before comparing any characters', () => {
    // Length differs by 7, over a ceiling of 2 — must reject without needing the content.
    expect(editDistance('a', 'abcdefgh', 2)).toBe(3);
  });

  it('treats a transposition as two edits when transpositions are off (the default)', () => {
    // "parkash" -> "prakash" swaps two adjacent letters. Plain Levenshtein pays for two
    // substitutions (or a delete+insert) — never fewer than 2.
    expect(editDistance('prakash', 'parkash', 3, false)).toBe(2);
  });

  it('treats the same adjacent-letter transposition as ONE edit when transpositions are on', () => {
    expect(editDistance('prakash', 'parkash', 1, true)).toBe(1);
  });

  it('does not let transpositions=true find a discount that is not actually there', () => {
    // Two substitutions with no adjacent swap between them must still cost 2, even with
    // transpositions enabled — the discount is specifically for a swap, not a general amnesty.
    expect(editDistance('abcd', 'axcy', 3, true)).toBe(2);
  });

  it('defaults transpositions to off, matching the region-canonicaliser behaviour it was extracted from', () => {
    expect(editDistance('prakash', 'parkash', 3)).toBe(editDistance('prakash', 'parkash', 3, false));
  });
});
