import { readFileSync } from 'fs';
import { join } from 'path';
import { AssignmentStatus } from '@fapoms/shared';
import {
  ABANDONED_ASSIGNMENT_STATUSES,
  ASSIGNED_ASSIGNMENT_STATUSES,
  BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES,
  COMMITTED_ASSIGNMENT_STATUSES,
  DAY_EXCLUSIVE_ASSIGNMENT_STATUSES,
  ENGAGED_ASSIGNMENT_STATUSES,
  IN_FLIGHT_ASSIGNMENT_STATUSES,
  TERMINAL_ASSIGNMENT_STATUSES,
  sqlStatusList,
} from './assignment-workload';

/**
 * The shared status sets, the entity's index declarations and the migrations that create those
 * indexes must all still be saying the same thing.
 *
 * `assignment-double-booking.spec.ts` pins one set against one index by transcribing that index's
 * predicate as a literal. This file generalises the idea and closes its gap: a transcription is
 * only correct on the day it is written, and it says nothing about the OTHER indexes. Here the
 * predicates are PARSED out of the schema's own source — the `@Index` decorators on
 * `assignment.entity.ts` and the `CREATE ... INDEX` statements in
 * `infrastructure/database/migrations` — so the test compares the constant with the definition
 * that actually ships, and fails whichever side of the pair somebody edits.
 *
 * Three sources have to agree, not two: an index declared on the entity but created differently
 * by a migration produces one schema on a regenerated baseline and a different one on a migrated
 * database, and it was exactly that split (see the note above the scale indexes in
 * `assignment.entity.ts`) that let indexes silently vanish once already.
 *
 * These are file reads, not database reads, deliberately: a unit test that needs Postgres does
 * not run in CI (`.db.spec.ts` files are excluded), and this has to fail on the pull request that
 * causes the drift rather than on a deployment afterwards. The live database was verified to
 * match this source at the time of writing:
 *
 *   idx_assignments_single_active_assayer_day … WHERE is_active AND scheduled_date IS NOT NULL
 *     AND status = ANY (ARRAY['PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'])
 *   idx_assignments_single_active_branch      … WHERE is_active AND project_branch_id IS NOT NULL
 *     AND status = ANY (ARRAY['PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'])
 */

const MODULE_DIR = __dirname;
const ENTITY_SRC = readFileSync(join(MODULE_DIR, 'assignment.entity.ts'), 'utf8');
const MIGRATIONS_DIR = join(MODULE_DIR, '..', '..', 'infrastructure', 'database', 'migrations');

/** Every status name quoted inside one SQL/decorator fragment, in the order it appears. */
function statusesIn(fragment: string): string[] {
  const known = new Set<string>(Object.values(AssignmentStatus));
  return [...fragment.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).filter((s) => known.has(s));
}

/** The `where:` predicate of an `@Index('<name>', …)` declaration on the entity. */
function entityIndexPredicate(indexName: string): string {
  const at = ENTITY_SRC.indexOf(`@Index('${indexName}'`);
  expect(at).toBeGreaterThan(-1);
  const decorator = ENTITY_SRC.slice(at, ENTITY_SRC.indexOf('\n@', at + 1));
  const where = /where:\s*`([^`]*)`/.exec(decorator);
  expect(where).not.toBeNull();
  return where![1];
}

/**
 * The `CREATE … INDEX <name>` statement from whichever migration creates it, with the migration's
 * own filename, so a failure names the file to edit.
 */
function migrationIndexStatement(indexName: string): { file: string; sql: string } {
  const { readdirSync } = jest.requireActual('fs') as typeof import('fs');
  const files = readdirSync(MIGRATIONS_DIR).filter((f: string) => f.endsWith('.ts'));
  for (const file of files) {
    const src = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const at = src.indexOf(`INDEX IF NOT EXISTS "${indexName}"`);
    const plain = at === -1 ? src.indexOf(`INDEX "${indexName}"`) : at;
    if (plain === -1) continue;
    // Only a CREATE, never the DROP in `down()`.
    const before = src.slice(Math.max(0, plain - 60), plain);
    if (!/CREATE\s+(UNIQUE\s+)?$/i.test(before.replace(/\s+/g, ' ').replace(/.*?(CREATE\s+(UNIQUE\s+)?)$/i, '$1'))
        && !/CREATE/i.test(before)) continue;
    const end = src.indexOf('`', plain);
    return { file, sql: src.slice(plain, end === -1 ? plain + 400 : end) };
  }
  throw new Error(`No migration creates index ${indexName}`);
}

/** The pairs: one shared constant, one database object that enforces the same rule. */
const PINNED: Array<{ constant: AssignmentStatus[]; name: string; index: string }> = [
  {
    constant: DAY_EXCLUSIVE_ASSIGNMENT_STATUSES,
    name: 'DAY_EXCLUSIVE_ASSIGNMENT_STATUSES',
    index: 'idx_assignments_single_active_assayer_day',
  },
  {
    constant: BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES,
    name: 'BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES',
    index: 'idx_assignments_single_active_branch',
  },
];

describe('shared status sets against the schema that enforces them', () => {
  for (const { constant, name, index } of PINNED) {
    it(`${name} matches the ${index} migration predicate`, () => {
      const { file, sql } = migrationIndexStatement(index);
      expect({ file, statuses: statusesIn(sql).sort() })
        .toEqual({ file, statuses: [...constant].sort() });
    });
  }

  it('idx_assignments_single_active_branch is declared identically on the entity and in its migration', () => {
    // The entity declaration is what a regenerated baseline schema carries; the migration is what
    // an existing database ran. A fresh deployment and a migrated one must end up the same.
    expect(statusesIn(entityIndexPredicate('idx_assignments_single_active_branch')).sort())
      .toEqual([...BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES].sort());
  });

  it('idx_assignments_open_offers still covers exactly the one status it names', () => {
    // Not a set, but the same class of drift: the offers index exists to serve the PENDING queue.
    expect(statusesIn(entityIndexPredicate('idx_assignments_open_offers'))).toEqual([AssignmentStatus.PENDING]);
  });

  it('idx_assignments_completed_reconcile still covers exactly COMPLETED', () => {
    expect(statusesIn(entityIndexPredicate('idx_assignments_completed_reconcile'))).toEqual([AssignmentStatus.COMPLETED]);
  });

  it('finds a real predicate for every index it claims to check, rather than passing vacuously', () => {
    // Guard against the parser silently returning nothing and every assertion above comparing
    // [] with [] — the failure mode that makes a drift test worthless.
    for (const { index } of PINNED) {
      expect(statusesIn(migrationIndexStatement(index).sql).length).toBeGreaterThan(0);
    }
    expect(statusesIn(entityIndexPredicate('idx_assignments_single_active_branch')).length).toBe(4);
  });
});

/**
 * The sets against each other. Each answers a different question, and the differences are the
 * part that keeps getting lost when somebody writes a fifth literal instead of importing one.
 */
describe('the status sets stay distinct, because they answer different questions', () => {
  const sorted = (s: AssignmentStatus[]) => [...s].sort();

  it('covers every status in the enum exactly once between ASSIGNED and ABANDONED', () => {
    expect(sorted([...ASSIGNED_ASSIGNMENT_STATUSES, ...ABANDONED_ASSIGNMENT_STATUSES]))
      .toEqual(sorted(Object.values(AssignmentStatus)));
    for (const s of ASSIGNED_ASSIGNMENT_STATUSES) {
      expect(ABANDONED_ASSIGNMENT_STATUSES).not.toContain(s);
    }
  });

  it('keeps ABANDONED as TERMINAL minus COMPLETED', () => {
    expect(sorted(ABANDONED_ASSIGNMENT_STATUSES))
      .toEqual(sorted(TERMINAL_ASSIGNMENT_STATUSES.filter((s) => s !== AssignmentStatus.COMPLETED)));
    expect(ABANDONED_ASSIGNMENT_STATUSES).not.toContain(AssignmentStatus.COMPLETED);
  });

  it('keeps ENGAGED as "said yes and did not walk away": no PENDING, yes COMPLETED', () => {
    // The dashboard's readiness check: a date in the diary whose only assignment is an
    // unanswered offer is exactly the case it exists to flag, so PENDING must stay out.
    expect(ENGAGED_ASSIGNMENT_STATUSES).not.toContain(AssignmentStatus.PENDING);
    expect(ENGAGED_ASSIGNMENT_STATUSES).toContain(AssignmentStatus.COMPLETED);
    expect(sorted(ENGAGED_ASSIGNMENT_STATUSES))
      .toEqual(sorted([...COMMITTED_ASSIGNMENT_STATUSES, AssignmentStatus.COMPLETED]));
  });

  it('keeps ENGAGED distinct from every set it might be mistaken for', () => {
    for (const other of [COMMITTED_ASSIGNMENT_STATUSES, IN_FLIGHT_ASSIGNMENT_STATUSES, ASSIGNED_ASSIGNMENT_STATUSES]) {
      expect(sorted(ENGAGED_ASSIGNMENT_STATUSES)).not.toEqual(sorted(other));
    }
  });

  it('keeps ASSIGNED wider than IN_FLIGHT by exactly COMPLETED', () => {
    expect(sorted(ASSIGNED_ASSIGNMENT_STATUSES))
      .toEqual(sorted([...IN_FLIGHT_ASSIGNMENT_STATUSES, AssignmentStatus.COMPLETED]));
  });

  it('excludes abandoned work from every set that describes live or delivered work', () => {
    for (const set of [
      COMMITTED_ASSIGNMENT_STATUSES,
      IN_FLIGHT_ASSIGNMENT_STATUSES,
      DAY_EXCLUSIVE_ASSIGNMENT_STATUSES,
      BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES,
      ENGAGED_ASSIGNMENT_STATUSES,
      ASSIGNED_ASSIGNMENT_STATUSES,
    ]) {
      expect(set).not.toContain(AssignmentStatus.CANCELLED);
      expect(set).not.toContain(AssignmentStatus.REJECTED);
    }
  });

  it('renders each set as a SQL list the raw queries can interpolate', () => {
    expect(sqlStatusList(ENGAGED_ASSIGNMENT_STATUSES)).toBe(`'ACCEPTED','CHECKED_IN','IN_PROGRESS','COMPLETED'`);
    expect(sqlStatusList(ABANDONED_ASSIGNMENT_STATUSES)).toBe(`'REJECTED','CANCELLED'`);
    // No stray whitespace or trailing comma: these go straight into an `IN (...)`.
    for (const set of [ASSIGNED_ASSIGNMENT_STATUSES, IN_FLIGHT_ASSIGNMENT_STATUSES]) {
      expect(sqlStatusList(set)).toMatch(/^'[A-Z_]+'(,'[A-Z_]+')*$/);
    }
  });
});

/**
 * No call site may state one of these sets for itself again. This is the test that would have
 * caught all five of the divergent literals at once.
 */
describe('no backend source restates a shared status set', () => {
  const { readdirSync, statSync } = jest.requireActual('fs') as typeof import('fs');
  const SRC = join(MODULE_DIR, '..', '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
    }
    return out;
  }

  /**
   * Files that legitimately hold a status list of their own.
   *  - `assignment-workload.ts` is where the sets are defined.
   *  - `assignment.entity.ts` and the migrations ARE the database's own statement of the rule;
   *    they cannot import TypeScript constants into a `CREATE INDEX`, which is precisely why the
   *    pinning tests above exist.
   *  - `benchmark-harness.ts` generates synthetic rows and picks statuses at random.
   *  - `lifecycle-certification-fixtures.ts` describes individual fixture rows, not a rule.
   */
  const ALLOWED = [
    'assignment/assignment-workload.ts',
    'assignment/assignment.entity.ts',
    'database/migrations/',
    'database/benchmark-harness.ts',
    'assayer/lifecycle-certification-fixtures.ts',
  ];

  /**
   * Lines that are a status list but not one of these sets, allowed by the name they are bound to
   * rather than by file, so the rest of that file stays under the rule.
   *
   * `ASSAYER_TRANSITIONS` is which target statuses a field user may REQUEST — a permission, not a
   * predicate over existing rows. It contains REJECTED, which every set in `assignment-workload.ts`
   * excludes by design, and folding it into one of them would either let the app cancel work or
   * stop it declining an offer. This is the case the sets must not swallow.
   */
  const ALLOWED_NAMES = ['ASSAYER_TRANSITIONS'];

  /** A quoted status list of three or more names, in SQL or in an array literal. */
  const LIST = /(?:'(?:PENDING|ACCEPTED|CHECKED_IN|IN_PROGRESS|COMPLETED|REJECTED|CANCELLED)'\s*,\s*){2,}'(?:PENDING|ACCEPTED|CHECKED_IN|IN_PROGRESS|COMPLETED|REJECTED|CANCELLED)'/;

  it('has no hand-written three-or-more assignment status list outside the schema', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.some((a) => rel.includes(a))) continue;
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (!LIST.test(line)) continue;
        if (ALLOWED_NAMES.some((n) => line.includes(n))) continue;
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    // Each of these was a real defect: four different answers to "what is this assayer's
    // workload", and a dashboard and an export disagreeing about whether a branch was covered.
    expect(offenders).toEqual([]);
  });
});
