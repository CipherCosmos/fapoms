import { compareNames, normaliseIndianName, nameAgreementIsAcceptable } from './name-match';

const grade = (a: string, b: string) => compareNames(a, b).grade;

/**
 * Every name in this file is a real one from the live roster, or the shape of one.
 *
 * What is being pinned down: a reviewer types what an Aadhaar or PAN card says, and the system has
 * to tell them how well it agrees with the record without crying wolf. A strict comparison flags
 * every legitimate spelling of an Indian name and a loose one flags nothing, and both end with a
 * reviewer who stops reading the warning.
 */
describe('normaliseIndianName', () => {
  it('drops the relative a name column should never have carried', () => {
    // Real roster rows open like this. The name after "S/O" is a father's — matching against it is
    // how the geocoder pinned people onto namesake businesses.
    expect(normaliseIndianName('S/O Padagalingam')).toEqual([]);
    expect(normaliseIndianName('S/O Manoj Rustagi, Keshav Rustagi')).toEqual(['KESHAV', 'RUSTAGI']);
  });

  it.each(['C/O', 'D/O', 'W/O', 's/o', 'S / O'])('handles %s as well as S/O', (marker) => {
    expect(normaliseIndianName(`${marker} Somebody Else, Real Name`)).toEqual(['REAL', 'NAME']);
  });

  it('drops honorifics, which describe a person without naming them', () => {
    expect(normaliseIndianName('Dr. Raj Kumar Bansal')).toEqual(['RAJ', 'KUMAR', 'BANSAL']);
    expect(normaliseIndianName('Smt Lakshmi Devi')).toEqual(['LAKSHMI', 'DEVI']);
    expect(normaliseIndianName('Late Shri Ram Prasad')).toEqual(['RAM', 'PRASAD']);
  });

  it('keeps initials as words, because they still assert a letter', () => {
    expect(normaliseIndianName('A K Venkatesan')).toEqual(['A', 'K', 'VENKATESAN']);
    expect(normaliseIndianName('M.R. Jayaprakash')).toEqual(['M', 'R', 'JAYAPRAKASH']);
  });

  it('survives an empty or absent cell', () => {
    expect(normaliseIndianName('')).toEqual([]);
    expect(normaliseIndianName(null)).toEqual([]);
    expect(normaliseIndianName('   ...  ')).toEqual([]);
  });
});

describe('compareNames — the same person, written differently', () => {
  it('calls the same words in a different order an exact match', () => {
    // Gujarati and Tamil rosters routinely write surname-first; the card rarely agrees.
    expect(grade('Shah Bhoopendra Devchand', 'Bhoopendra Devchand Shah')).toBe('EXACT');
  });

  it('ignores case and punctuation', () => {
    expect(grade('SHUAIB RASHEED', 'Shuaib Rasheed')).toBe('EXACT');
    expect(grade('M.R. Jayaprakash', 'M R Jayaprakash')).toBe('EXACT');
  });

  it('expands initials against the written-out name', () => {
    expect(grade('A K Venkatesan', 'Anil Kumar Venkatesan')).toBe('STRONG');
    expect(grade('Anil Kumar Venkatesan', 'A K Venkatesan')).toBe('STRONG');
  });

  it('accepts a name the card writes more fully than the roster does', () => {
    // The roster carries a single given name for a large part of the estate.
    expect(grade('Ramesh', 'Ramesh Valaboju')).toBe('STRONG');
    expect(grade('Veerni Bhaskar Rao', 'Bhaskar Rao')).toBe('STRONG');
  });

  it('forgives one letter in a word long enough for it to be a slip', () => {
    expect(grade('Prakash Nair', 'Parkash Nair')).toBe('STRONG');
  });

  /**
   * Four letters is where a single edit stops being a typo and starts being a different name, so
   * the tolerance does not apply below five.
   */
  it('does not forgive one letter in a short word', () => {
    expect(grade('Ravi Kumar', 'Rani Kumar')).toBe('MISMATCH');
  });
});

describe('compareNames — different people, and thin evidence', () => {
  it('refuses two different given names behind a shared surname', () => {
    // The most common way a wrong card gets approved: the reviewer sees "Kumar" and stops reading.
    expect(grade('Ramesh Kumar', 'Suresh Kumar')).toBe('MISMATCH');
  });

  it('refuses a name whose extra word contradicts rather than extends', () => {
    expect(grade('Ramesh Kumar Sharma', 'Ramesh Verma')).toBe('MISMATCH');
  });

  /**
   * Initials agreeing on their first letters is not evidence of a person. Grading this STRONG
   * would let "A K" approve any Anil Kumar, Ajay Krishnan or Asha Kapoor on the roster.
   */
  it('grades a match carried entirely by initials as weak, not strong', () => {
    expect(grade('A K V', 'Anil Kumar Venkatesan')).toBe('WEAK');
  });

  it('refuses when either side has no name left in it', () => {
    expect(grade('S/O Padagalingam', 'Padagalingam Murugan')).toBe('MISMATCH');
    expect(grade('', 'Anil Kumar')).toBe('MISMATCH');
    expect(grade('Anil Kumar', null as any)).toBe('MISMATCH');
  });

  /**
   * A greedy pass can spend the record's only "KUMAR" on the document's "KUMARI" and then report
   * the exact word unmatched. The pairing has to be a maximum one.
   */
  it('pairs words optimally rather than greedily', () => {
    expect(grade('Kumar Kumari', 'Kumari Kumar')).toBe('EXACT');
    expect(compareNames('Kumar Devi', 'Kumari Kumar').grade).toBe('MISMATCH');
  });
});

describe('compareNames — what the reviewer is shown', () => {
  it('names the words that went unaccounted for on each side', () => {
    const result = compareNames('Ramesh Kumar Sharma', 'Ramesh Verma');
    expect(result.unmatchedOnRecord).toEqual(expect.arrayContaining(['SHARMA']));
    expect(result.unmatchedOnDocument).toEqual(['VERMA']);
  });

  it('reports nothing unaccounted for on an exact match', () => {
    const result = compareNames('Shah Bhoopendra Devchand', 'Bhoopendra Devchand Shah');
    expect(result.unmatchedOnRecord).toEqual([]);
    expect(result.unmatchedOnDocument).toEqual([]);
  });
});

describe('nameAgreementIsAcceptable', () => {
  /**
   * Only the bottom of the scale blocks. WEAK is believable and STRONG is ordinary; refusing them
   * outright would stop most of a legitimate roster, and the reviewer is looking at the card.
   */
  it.each([['EXACT', true], ['STRONG', true], ['WEAK', true], ['MISMATCH', false]] as const)(
    '%s → %s', (g, expected) => expect(nameAgreementIsAcceptable(g)).toBe(expected),
  );
});

/**
 * Abbreviations that no edit distance can bridge.
 *
 * "MD Iqbal" and "Mohammed Iqbal" are one person on a great many Indian rosters, and the two words
 * share a single letter. This is a named list, deliberately — the alternative is a phonetic
 * algorithm built on English phonemes, which on transliterated names merges surnames that are not
 * the same and misses the pairs that actually occur.
 */
describe('compareNames — abbreviations', () => {
  it.each([['Md Iqbal'], ['Mohd Iqbal'], ['Mohammad Iqbal']])(
    'reads %s as Mohammed Iqbal', (written) => {
      expect(grade(written, 'Mohammed Iqbal')).toBe('STRONG');
    },
  );

  /**
   * `MD` must never be treated as a title. Stripping it the way `Dr` is stripped would delete half
   * the name and leave "Iqbal" to match anything.
   */
  it('does not mistake Md for a doctor', () => {
    expect(normaliseIndianName('Md Iqbal')).toEqual(['MD', 'IQBAL']);
    expect(grade('Md Iqbal', 'Iqbal Hussain')).toBe('MISMATCH');
  });
});
