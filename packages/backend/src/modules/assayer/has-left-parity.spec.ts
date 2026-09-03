import * as fs from 'fs';
import * as path from 'path';
import { AssayerLifecycleStatus, DEPARTED_LIFECYCLE_STATES, hasLeftWorkforce } from '@fapoms/shared';

/**
 * "Has this person left" is asked in SQL and in TypeScript, and the two must agree.
 *
 * `hasLeftWorkforce` in `@fapoms/shared` is the rule. The data-integrity scanner and the web
 * roster both call it. The HR console cannot: its questions are aggregate counts computed inside
 * Postgres, so the rule appears there a second time as the `HAS_LEFT` SQL fragment. SQL cannot
 * import a TypeScript function, which makes that copy unavoidable — and unavoidable is not the
 * same as unwatched.
 *
 * The cost of not watching it is on record. This rule was written out three times; the deceased
 * arm was added to two of them. The third was the roster, so a man recorded as having died stayed
 * in "Incomplete record" and "Cannot be paid", and the screen asked a clerk to chase his bank
 * details. Nothing failed and nothing looked wrong, because each copy was individually plausible.
 *
 * Two copies remain — one function, one SQL fragment — and this fails when they disagree.
 */
describe('the SQL "has left" fragment matches the shared rule', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'hr-workforce.service.ts'), 'utf8',
  );

  /** The fragment's body, sliced from its declaration rather than found by a loose search. */
  const fragment = (): string => {
    const start = source.indexOf('const HAS_LEFT = (p: string) =>');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf(';', start));
  };

  it('names exactly the departed lifecycle states, and no others', () => {
    const quoted = [...fragment().matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    // 'DECEASED' is the reason, not a lifecycle state; INACTIVE is the state it hangs off.
    const states = quoted.filter((v) => v !== 'DECEASED' && v !== 'INACTIVE');

    expect([...states].sort()).toEqual([...DEPARTED_LIFECYCLE_STATES].sort());
  });

  it('still carries the deceased arm, which is the one that went missing before', () => {
    const sql = fragment();
    expect(sql).toContain('INACTIVE');
    expect(sql).toContain('DECEASED');
    expect(sql).toContain('unavailable_reason');
  });

  /**
   * The fragment evaluated as a rule, rather than only inspected as text.
   *
   * A structural check alone would pass on SQL that names the right values in the wrong shape —
   * `AND` where `OR` belongs, for instance. This runs the same cases through both sides.
   */
  it.each([
    [AssayerLifecycleStatus.RESIGNED, null, true],
    [AssayerLifecycleStatus.TERMINATED, null, true],
    [AssayerLifecycleStatus.ARCHIVED, null, true],
    [AssayerLifecycleStatus.INACTIVE, 'DECEASED', true],
    [AssayerLifecycleStatus.INACTIVE, 'deceased', true],
    // Still employed, merely unavailable — the distinction the whole rule turns on.
    [AssayerLifecycleStatus.INACTIVE, 'NO_WORK_IN_AREA', false],
    [AssayerLifecycleStatus.INACTIVE, null, false],
    [AssayerLifecycleStatus.ON_LEAVE, null, false],
    [AssayerLifecycleStatus.SUSPENDED, null, false],
    [AssayerLifecycleStatus.ACTIVE, null, false],
  ])('agrees on %s / %s', (lifecycleStatus, unavailableReason, expected) => {
    expect(hasLeftWorkforce({ lifecycleStatus, unavailableReason })).toBe(expected);

    // The SQL read as a boolean expression, with the same two inputs substituted in.
    const sql = fragment();
    const evaluated = evaluateFragment(sql, lifecycleStatus, unavailableReason);
    expect(evaluated).toBe(expected);
  });
});

/**
 * The fragment translated into a JavaScript boolean expression, then evaluated.
 *
 * The first version of this pulled the state list and the deceased arm out with two regexes and
 * then wrote `states.includes(x) || (lifecycle === … && reason === …)` in TypeScript — hardcoding
 * the connectives. The docblock above claimed it would catch "AND where OR belongs"; it could not.
 * Swapping the fragment's `OR` for `AND` left all ten cases passing, while in Postgres that makes
 * `HAS_LEFT` permanently false — a status cannot be both inside the IN-list and equal to INACTIVE.
 * Measured live, that mutation returns 25 departed people to the roster (717 → 742) and sends
 * clerks to chase records belonging to people who have left. A guard that models the rule instead
 * of reading it is not checking the rule.
 *
 * So the operators are taken FROM the SQL. This translates only the vocabulary `HAS_LEFT` is
 * written in and throws on anything else, because a translator that guesses would go green exactly
 * when the fragment had changed most.
 */
function evaluateFragment(sql: string, lifecycle: string, reason: string | null): boolean {
  const RECOGNISED = [
    // `upper(coalesce(<col>, ''))` — collapse to the column before the comparisons are rewritten.
    [/upper\(coalesce\((\w*\.?\w+),\s*''\)\)/g, '$1'],
    [/(\w*\.?)lifecycle_status\s+IN\s+\(([^)]*)\)/g, '[$2].includes(LIFECYCLE)'],
    [/(\w*\.?)lifecycle_status\s*=\s*/g, 'LIFECYCLE === '],
    [/(\w*\.?)unavailable_reason\s*=\s*/g, 'REASON === '],
    [/\bAND\b/g, '&&'],
    [/\bOR\b/g, '||'],
  ] as const;

  let expr = sql.slice(sql.indexOf('`') + 1);
  // Drop the template-literal machinery: the fragment is assembled from two backticked pieces
  // joined by `+`, with `${p}` table-alias placeholders throughout.
  expr = expr.replace(/\$\{p\}/g, '').replace(/`\s*\+\s*`/g, '').replace(/`/g, '');
  for (const [pattern, replacement] of RECOGNISED) expr = expr.replace(pattern, replacement);

  const leftovers = expr.replace(/LIFECYCLE|REASON|includes|'[^']*'|[\s()[\],.!=&|]/g, '');
  if (leftovers.length > 0) {
    throw new Error(
      `HAS_LEFT uses SQL this spec cannot read (${leftovers}). Extend the translation above `
      + 'rather than deleting the case — an unreadable fragment is the state in which this guard '
      + 'is worth the most, not the least.',
    );
  }

  // eslint-disable-next-line no-new-func
  return new Function('LIFECYCLE', 'REASON', `return ${expr};`)(
    lifecycle, (reason ?? '').toUpperCase(),
  ) as boolean;
}
