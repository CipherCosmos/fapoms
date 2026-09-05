import {
  cannotBePaid, stillWorkable, PAYOUT_BLOCKING_COLUMNS, AssayerLifecycleStatus,
} from '@fapoms/shared';
import { HrWorkforceService } from './hr-workforce.service';

/**
 * "Cannot be paid" is asked in TypeScript and in SQL, and the two must agree.
 *
 * `cannotBePaid` in `@fapoms/shared` is THE rule now (see the "Payability — the one rulebook"
 * section of `assayer-record.ts`): before it existed, this predicate was three different tests —
 * the roster chip required bank + IFSC + PAN and a still-workable person, the Pay page tested only
 * bank + IFSC and happily counted people who had already left, and the server's own aggregate was
 * hand-written SQL with a third idea of both. Same two words on three screens, three populations.
 *
 * The `unpayable` segment count in `hr-workforce.service.ts`'s `segments()` (and the payout gap
 * inside `recordCompliance()`) cannot import `cannotBePaid` — it is SQL running inside Postgres —
 * so it exists a second time as `HrWorkforceService.anyPayoutBlockingMissingSql()` plus the shared
 * `ON_ROSTER_A` "still workable" gate. This is the same shape as `has-left-parity.spec.ts`: read
 * the REAL, LIVE fragment the service actually generates, translate only the vocabulary it uses,
 * throw on anything else, and run the same fixtures through both sides.
 *
 * The "still workable" half is not re-derived here. `has-left-parity.spec.ts` already proves
 * `HAS_LEFT` (SQL) agrees with `hasLeftWorkforce` (shared) exhaustively, and
 * `hr-workforce-soft-delete.spec.ts` already proves every `ON_ROSTER`/`ON_ROSTER_A` definition in
 * this file carries `HAS_LEFT` plus both leaving-date checks — so `stillWorkable` (shared), which
 * is built from the exact same three checks, is a faithful stand-in for what `ON_ROSTER_A` tests in
 * SQL. Re-proving that equivalence a third time here would duplicate existing coverage rather than
 * add any; what is actually NEW in `cannotBePaid` — and therefore what this file exists to check —
 * is the payout-blocking-columns half.
 */

/** One person, in both the spellings the same fact reaches: camelCase from the API, snake_case in Postgres. */
interface Fixture {
  name: string;
  lifecycleStatus: string;
  unavailableReason?: string | null;
  exitDate?: string | null;
  terminationDate?: string | null;
  panNumber?: string | null;
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
  /** What `cannotBePaid` should say — pinned by hand so a fixture typo cannot silently agree with itself. */
  expected: boolean;
}

const FIXTURES: Fixture[] = [
  {
    name: 'workable, missing only the PAN',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    panNumber: null, bankAccountNumber: '00112233', ifscCode: 'HDFC0001234',
    expected: true,
  },
  {
    name: 'workable, missing only the IFSC',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    panNumber: 'ABCDE1234F', bankAccountNumber: '00112233', ifscCode: '',
    expected: true,
  },
  {
    name: 'workable, every payout field blank',
    lifecycleStatus: AssayerLifecycleStatus.TRAINING,
    panNumber: null, bankAccountNumber: null, ifscCode: null,
    expected: true,
  },
  {
    name: 'workable, record complete — can be paid',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    panNumber: 'ABCDE1234F', bankAccountNumber: '00112233', ifscCode: 'HDFC0001234',
    expected: false,
  },
  {
    name: 'resigned, missing bank details — gone, not unpayable',
    lifecycleStatus: AssayerLifecycleStatus.RESIGNED,
    panNumber: 'ABCDE1234F', bankAccountNumber: null, ifscCode: 'HDFC0001234',
    expected: false,
  },
  {
    name: 'terminated, missing PAN — gone, not unpayable',
    lifecycleStatus: AssayerLifecycleStatus.TERMINATED,
    panNumber: null, bankAccountNumber: '00112233', ifscCode: 'HDFC0001234',
    expected: false,
  },
  {
    name: 'INACTIVE and recorded deceased, missing bank details — the exact regression this rule exists to prevent',
    lifecycleStatus: AssayerLifecycleStatus.INACTIVE, unavailableReason: 'DECEASED',
    panNumber: 'ABCDE1234F', bankAccountNumber: null, ifscCode: null,
    expected: false,
  },
  {
    name: 'INACTIVE but NOT deceased (no work in their area), missing bank details — still workable, still chased',
    lifecycleStatus: AssayerLifecycleStatus.INACTIVE, unavailableReason: 'NO_WORK_IN_AREA',
    panNumber: 'ABCDE1234F', bankAccountNumber: null, ifscCode: 'HDFC0001234',
    expected: true,
  },
  {
    name: 'on leave, missing PAN — still workable, still chased',
    lifecycleStatus: AssayerLifecycleStatus.ON_LEAVE,
    panNumber: null, bankAccountNumber: '00112233', ifscCode: 'HDFC0001234',
    expected: true,
  },
  {
    name: 'ACTIVE lifecycle but an exit date was entered — dated out, not unpayable',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE, exitDate: '2026-01-15',
    panNumber: null, bankAccountNumber: '00112233', ifscCode: 'HDFC0001234',
    expected: false,
  },
  {
    name: 'ACTIVE lifecycle but a termination date was entered — dated out, not unpayable',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE, terminationDate: '2026-02-01',
    panNumber: 'ABCDE1234F', bankAccountNumber: null, ifscCode: 'HDFC0001234',
    expected: false,
  },
];

/** The SQL-side shape: only the columns the SQL fragment actually reads, snake_case. */
function asSqlRow(f: Fixture): Record<string, unknown> {
  return {
    pan_number: f.panNumber ?? null,
    bank_account_number: f.bankAccountNumber ?? null,
    ifsc_code: f.ifscCode ?? null,
  };
}

/**
 * `anyPayoutBlockingMissingSql()` evaluated as a boolean expression against one SQL-shaped row.
 *
 * Pulled live off the class (a private static method — TypeScript's `private` is erased at
 * runtime, so `as any` reaches it the same way `hr-workforce-counts.spec.ts` reaches the service's
 * other private methods) rather than hand-copied, so a future edit to `missingSql` or to which
 * columns are payout-blocking changes what THIS evaluates too, automatically.
 *
 * Only the vocabulary `missingSql` actually emits is recognised, exactly as
 * `has-left-parity.spec.ts`'s `evaluateFragment` does for `HAS_LEFT` — an unrecognised shape throws
 * rather than silently evaluating a stale translation.
 */
function evaluatePayoutBlockingSql(sql: string, row: Record<string, unknown>): boolean {
  const CLAUSE = /\(([a-z_]+) IS NULL OR \1::text = ''\)/g;
  const matches = [...sql.matchAll(CLAUSE)];
  if (matches.length === 0) {
    throw new Error(
      `anyPayoutBlockingMissingSql() produced SQL this spec cannot read (${sql}). Extend the `
      + 'translation above rather than deleting the case — an unreadable fragment is the state in '
      + 'which this guard is worth the most, not the least.',
    );
  }

  // The connective BETWEEN each pair of clauses, read from the actual text rather than assumed —
  // an early version of this hard-coded `.some()` (i.e. always OR) regardless of what the source
  // said, and a dry-run mutation to `.join(' AND ')` (requiring every field blank at once, instead
  // of any one) sailed straight through every fixture. Reading the real token closes that: a
  // mutated connective now shows up as the wrong operator instead of not showing up at all.
  const connectives = new Set<string>();
  for (let i = 0; i < matches.length - 1; i++) {
    const between = sql.slice(matches[i].index! + matches[i][0].length, matches[i + 1].index!);
    const op = /^\s*(AND|OR)\s*$/.exec(between)?.[1];
    if (!op) {
      throw new Error(
        `anyPayoutBlockingMissingSql() joins its clauses with something this spec cannot read `
        + `(${JSON.stringify(between)}). Extend the translation above rather than deleting the case.`,
      );
    }
    connectives.add(op);
  }
  if (connectives.size > 1) {
    throw new Error(
      'anyPayoutBlockingMissingSql() mixes AND and OR between its clauses — this spec only reads a '
      + 'uniform join, which is all three payout-blocking columns have ever needed.',
    );
  }
  const op = connectives.size === 1 ? [...connectives][0] : 'OR'; // one clause alone has no connective to read

  const blank = matches.map(([, column]) => {
    const value = row[column];
    return value == null || String(value) === '';
  });
  return op === 'OR' ? blank.some(Boolean) : blank.every(Boolean);
}

describe('the SQL "cannot be paid" fragment matches the shared rule', () => {
  const anyPayoutMissingSql = (): string => (HrWorkforceService as unknown as { anyPayoutBlockingMissingSql(): string })
    .anyPayoutBlockingMissingSql();

  it('checks exactly the payout-blocking columns, and no others', () => {
    const columns = [...anyPayoutMissingSql().matchAll(/\(([a-z_]+) IS NULL/g)].map((m) => m[1]);
    expect([...new Set(columns)].sort()).toEqual([...PAYOUT_BLOCKING_COLUMNS].sort());
  });

  it('joins the per-column checks with OR — one missing field is enough to be unpayable', () => {
    // The clauses are alternatives (any gap blocks a payout), never a conjunction (needing every
    // field blank at once) — a mutation swapping OR for AND here would still contain the letters
    // "OR" nowhere, which this catches directly rather than via the fixture run below.
    const sql = anyPayoutMissingSql();
    const joins = sql.split(/\)\s*(AND|OR)\s*\(/g).filter((tok) => tok === 'AND' || tok === 'OR');
    expect(joins.length).toBeGreaterThan(0);
    expect(joins.every((tok) => tok === 'OR')).toBe(true);
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    const shared = cannotBePaid(f as unknown as Parameters<typeof cannotBePaid>[0]);
    expect(shared).toBe(f.expected);

    // The SQL side: `stillWorkable` stands in for `ON_ROSTER_A` (see the file header for why that
    // substitution does not weaken the check), ANDed with the live payout-blocking fragment
    // evaluated against the SQL-shaped row.
    const sqlMirror = stillWorkable(f) && evaluatePayoutBlockingSql(anyPayoutMissingSql(), asSqlRow(f));
    expect(sqlMirror).toBe(f.expected);
  });

  it('agrees with the shared rule over the whole fixture set, not just field by field', () => {
    const sql = anyPayoutMissingSql();

    const sharedCount = FIXTURES.filter((f) => cannotBePaid(f as unknown as Parameters<typeof cannotBePaid>[0])).length;
    const sqlCount = FIXTURES.filter((f) => stillWorkable(f) && evaluatePayoutBlockingSql(sql, asSqlRow(f))).length;

    expect(sqlCount).toBe(sharedCount);
    // Pinned to the fixture design's own intent, so a change that breaks both sides identically
    // (and would otherwise pass the equality check above) still fails.
    expect(sharedCount).toBe(FIXTURES.filter((f) => f.expected).length);
  });
});
