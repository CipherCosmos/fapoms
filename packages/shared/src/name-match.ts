/**
 * FAPOMS — is the name printed on this card the name on this record?
 *
 * ## Why this cannot be a string comparison
 *
 * Onboarding asks a reviewer to type what an Aadhaar or PAN card actually says, so that the
 * record's name can be checked against it rather than taken on trust. The two will rarely be
 * identical even when they belong to the same person, because Indian names are written down in
 * ways that all mean the same thing:
 *
 * - **Initials expand or contract.** "A K Venkatesan" and "Anil Kumar Venkatesan" are one person.
 * - **Order moves.** "Shah Bhoopendra Devchand" and "Bhoopendra Devchand Shah" are one person.
 * - **A surname is present on one side only.** Plenty of the roster carries a single given name.
 * - **The record is contaminated.** Real rows in this system open with "S/O Padagalingam" — a
 *   father's name, in the person's name column, which the geocoding work already found being
 *   matched against businesses.
 *
 * A strict comparison flags every one of those and a loose one flags none, and both end the same
 * way: a reviewer who stops reading the warning. So this returns a **grade, not a verdict** — the
 * reviewer is told how well the two agree and decides, and `verifyDocument` only refuses outright
 * at the bottom of the scale.
 *
 * ## What it deliberately does not do
 *
 * No phonetic matching (Soundex/Metaphone are built for English and mangle transliterated Indian
 * names), no ML, no similarity ratio. Everything here is deterministic and enumerable in tests,
 * because this decides whether a person is admitted to a bank vault.
 */

import { editDistance } from './text-distance';

/** How well a name on a document agrees with the name on the record. */
export type NameMatchGrade = 'EXACT' | 'STRONG' | 'WEAK' | 'MISMATCH';

export interface NameComparison {
  grade: NameMatchGrade;
  /** Words on the record that nothing on the document accounts for, and the reverse. */
  unmatchedOnRecord: string[];
  unmatchedOnDocument: string[];
}

/**
 * "Son of", "care of" and the name that follows.
 *
 * Same rule the address parser applies, for the same reason: the name after it belongs to a
 * relative, and treating it as the person's own is how a record ends up matched to someone else.
 * The marker runs to a comma, or to the end when the cell holds nothing else.
 */
const RELATION_PREFIX = /\b(?:s|c|d|w|h)\s*[/.]\s*o\b\.?\s*:?\s*[^,]*/gi;

/** Titles that describe a person without naming them. */
const HONORIFICS = new Set([
  'MR', 'MRS', 'MS', 'MISS', 'SMT', 'SHRI', 'SRI', 'SHRIMATI', 'DR', 'PROF', 'LATE', 'KUM',
  'MASTER', 'M/S', 'MESSRS',
]);

/**
 * Two full words are the same word if they are equal, or one letter apart in a word long enough
 * for a single slip not to change which name it is.
 *
 * Five, not three: at four letters "RAVI" and "RANI" are one edit apart and are different people,
 * while at five or more a single edit is overwhelmingly a transcription slip ("PRAKASH" /
 * "PARKASH"). Applied to the shorter word's length, so a one-letter difference in length cannot
 * sneak a short word past the floor.
 */
const FUZZY_MIN_LENGTH = 5;

/**
 * Reduce a written name to the words it actually asserts.
 *
 * Order is load-bearing: the relation prefix goes first, because it contains a name that would
 * otherwise survive tokenisation and be matched against.
 */
export function normaliseIndianName(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const stripped = String(raw)
    .replace(RELATION_PREFIX, ' ')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ');

  return stripped
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !HONORIFICS.has(word));
}

/**
 * Abbreviations a card and a roster write differently for the same name.
 *
 * Kept to a named list rather than a phonetic algorithm. Soundex and Metaphone are built on English
 * phonemes and on transliterated Indian names they both over-merge distinct surnames and miss the
 * pairs that actually occur — and being opaque, a wrong answer cannot be argued with. "MD Iqbal"
 * and "Mohammed Iqbal" are one person on a great many Indian rosters, and no edit distance will
 * ever say so, because the two words share one letter.
 *
 * Add to this list when a real pair turns up in the data. Do not generalise it.
 */
const ABBREVIATIONS = new Map<string, string>([
  ['MD', 'MOHAMMED'], ['MOHD', 'MOHAMMED'], ['MHD', 'MOHAMMED'], ['MUHD', 'MOHAMMED'],
  ['MOHAMED', 'MOHAMMED'], ['MUHAMMAD', 'MOHAMMED'], ['MOHAMMAD', 'MOHAMMED'],
]);

/** The name a word stands for, or the word itself. */
const expand = (word: string): string => ABBREVIATIONS.get(word) ?? word;

/** A one-letter word is an initial standing in for a name nobody wrote out. */
const isInitial = (word: string): boolean => word.length === 1;

/** Could these two words be the same name? */
function wordsAgree(a: string, b: string): boolean {
  if (a === b) return true;
  if (isInitial(a) || isInitial(b)) {
    // An initial asserts only a first letter, so that is all it can be held to.
    return a[0] === b[0];
  }
  const left = expand(a);
  const right = expand(b);
  if (left === right) return true;
  if (Math.min(left.length, right.length) < FUZZY_MIN_LENGTH) return false;
  return editDistance(left, right, 1, true) <= 1;
}

/**
 * The largest set of word pairings in which no word is used twice.
 *
 * Greedy pairing is wrong here and the failure is not exotic: against "KUMAR KUMARI", a greedy
 * pass can spend the record's only "KUMAR" on the document's "KUMARI" and then report the exact
 * word unmatched. Kuhn's augmenting-path search is a dozen lines and always finds the maximum, and
 * the lists are three or four words long, so its cost is irrelevant.
 */
function maximumPairing(record: string[], document: string[]): Map<number, number> {
  /** For each document word, which record word it is currently paired with. */
  const pairedTo = new Map<number, number>();

  const augment = (recordIndex: number, seen: Set<number>): boolean => {
    for (let d = 0; d < document.length; d++) {
      if (seen.has(d) || !wordsAgree(record[recordIndex], document[d])) continue;
      seen.add(d);
      const holder = pairedTo.get(d);
      // Free, or its current holder can be re-paired elsewhere.
      if (holder === undefined || augment(holder, seen)) {
        pairedTo.set(d, recordIndex);
        return true;
      }
    }
    return false;
  };

  for (let r = 0; r < record.length; r++) augment(r, new Set<number>());
  return pairedTo;
}

/**
 * Compare a name on the record with a name read off a document.
 *
 * The grades, and why each line sits where it does:
 *
 * - **EXACT** — the same words, in any order. Nothing for a reviewer to think about.
 * - **STRONG** — every word on the shorter side is accounted for, and at least one of those
 *   pairings is between two written-out words. That last clause is what stops "A K" from being
 *   called a strong match for "Anil Kumar": three initials agreeing on three first letters is not
 *   evidence of a person, and a grade a reviewer can lean on has to rest on at least one real word.
 * - **WEAK** — the shorter side is fully accounted for, but only initials carried it. Believable,
 *   and not something to approve without looking at the card.
 * - **MISMATCH** — a word on the shorter side is unaccounted for. "Ramesh Kumar" against "Suresh
 *   Kumar" lands here, which is the point: a shared surname is not a shared identity.
 *
 * An empty side is always MISMATCH. A name we could not read is not a name that agrees — and after
 * the relation prefix is stripped, "S/O Padagalingam" is empty, which is exactly right: that cell
 * names a father, so it cannot corroborate anybody.
 */
export function compareNames(
  recordName: string | null | undefined,
  documentName: string | null | undefined,
): NameComparison {
  const record = normaliseIndianName(recordName);
  const document = normaliseIndianName(documentName);

  if (record.length === 0 || document.length === 0) {
    return { grade: 'MISMATCH', unmatchedOnRecord: record, unmatchedOnDocument: document };
  }

  if (record.length === document.length
    && [...record].sort().join(' ') === [...document].sort().join(' ')) {
    return { grade: 'EXACT', unmatchedOnRecord: [], unmatchedOnDocument: [] };
  }

  const pairedTo = maximumPairing(record, document);
  const pairedRecord = new Set([...pairedTo.values()]);

  const unmatchedOnRecord = record.filter((_, i) => !pairedRecord.has(i));
  const unmatchedOnDocument = document.filter((_, d) => !pairedTo.has(d));

  const shorter = Math.min(record.length, document.length);
  const everythingCovered = pairedTo.size === shorter;
  const restsOnARealWord = [...pairedTo.entries()]
    .some(([d, r]) => !isInitial(record[r]) && !isInitial(document[d]));

  const grade: NameMatchGrade = !everythingCovered
    ? 'MISMATCH'
    : restsOnARealWord ? 'STRONG' : 'WEAK';

  return { grade, unmatchedOnRecord, unmatchedOnDocument };
}

/** Whether a grade is good enough to record a verification without somebody overriding it. */
export const nameAgreementIsAcceptable = (grade: NameMatchGrade): boolean => grade !== 'MISMATCH';
