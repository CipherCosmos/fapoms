/**
 * FAPOMS — how far apart two pieces of text are, when one of them may be a typo of the other.
 *
 * Extracted from `regions.ts`, where it was written to canonicalise state names against a fixed
 * vocabulary. Identity work needs the same measure for a different job — deciding whether the name
 * printed on an Aadhaar card is a misspelling of the name on the record or a different person — and
 * two copies of an edit-distance routine is exactly the kind of duplication that drifts.
 */

/**
 * Edit distance, bounded so a hopeless pair costs almost nothing to reject.
 *
 * Two rolling rows rather than a full matrix: this runs against ~40 candidates per state lookup,
 * once per unmatched row of a branch import, and once per token pair when comparing names, so the
 * allocation is worth avoiding.
 *
 * Returns `ceiling + 1` rather than the true distance once the pair is hopeless — callers only ever
 * ask "is this within budget", and finishing the computation to report how hopeless would be work
 * nobody reads.
 *
 * ## `transpositions`
 *
 * Off by default, which keeps the region canonicaliser exactly as it was.
 *
 * Names want it on. Two adjacent letters swapped is the single commonest way a person mistypes a
 * word — "Prakash" for "Parkash" — and plain Levenshtein charges that two edits, the same as two
 * unrelated substitutions, so a name budget generous enough to forgive it also forgives genuinely
 * different names. With transpositions counted as one edit, the budget can stay at one.
 *
 * This is the restricted (optimal string alignment) variant: it does not allow a substring to be
 * edited between the two transposed letters. That case does not arise in names, and the
 * unrestricted algorithm costs an alphabet-sized table per call.
 */
export function editDistance(
  a: string,
  b: string,
  ceiling: number,
  transpositions = false,
): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;

  let beforePrev = new Array<number>(b.length + 1);
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowBest = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (
        transpositions
        && i > 1 && j > 1
        && a[i - 1] === b[j - 2]
        && a[i - 2] === b[j - 1]
      ) {
        curr[j] = Math.min(curr[j], beforePrev[j - 2] + 1);
      }
      if (curr[j] < rowBest) rowBest = curr[j];
    }
    // Every future row is >= this row's minimum, so we can stop once the whole row is hopeless.
    if (rowBest > ceiling) return ceiling + 1;
    const oldest = beforePrev;
    beforePrev = prev;
    prev = curr;
    curr = oldest;
  }
  return prev[b.length];
}
